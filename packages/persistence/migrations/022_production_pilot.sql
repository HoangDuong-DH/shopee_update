-- Bounded live pilot journal. Acknowledgement never releases the durable shop lane.
CREATE TABLE production_pilot_operations (
 id uuid PRIMARY KEY,
 owner_key text NOT NULL CHECK(owner_key='production:2010476:1423724897'),
 connection_id uuid NOT NULL REFERENCES connections(id), connection_revision integer NOT NULL CHECK(connection_revision>0),
 source_identity text NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 source_payload jsonb NOT NULL, source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 expected_projection jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('authorized','sent','acknowledged','rejected','unknown','verified')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), item_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_key,source_identity,source_revision)
);
CREATE TABLE production_pilot_lanes (
 owner_key text PRIMARY KEY CHECK(owner_key='production:2010476:1423724897'),
 operation_id uuid NOT NULL UNIQUE REFERENCES production_pilot_operations(id),
 acquired_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE production_pilot_steps (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES production_pilot_operations(id),
 step_key text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0),
 kind text NOT NULL CHECK(kind IN ('media','create','variations')),
 path text NOT NULL CHECK(path IN ('/api/v2/media_space/upload_image','/api/v2/product/add_item','/api/v2/product/init_tier_variation')),
 payload jsonb NOT NULL, media jsonb,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 authorized_revision integer NOT NULL CHECK(authorized_revision>0),
 state text NOT NULL CHECK(state IN ('authorized','sent','acknowledged','rejected','unknown')),
 receipt jsonb, outcome_fingerprint text,
 authorized_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, recorded_at timestamptz,
 UNIQUE(operation_id,step_key), UNIQUE(operation_id,ordinal),
 CHECK((kind='media' AND path='/api/v2/media_space/upload_image' AND media IS NOT NULL) OR
       (kind='create' AND path='/api/v2/product/add_item' AND media IS NULL) OR
       (kind='variations' AND path='/api/v2/product/init_tier_variation' AND media IS NULL)),
 CHECK((state='authorized' AND sent_at IS NULL AND receipt IS NULL) OR
       (state='sent' AND sent_at IS NOT NULL AND receipt IS NULL) OR
       (state IN ('acknowledged','rejected','unknown') AND sent_at IS NOT NULL AND receipt IS NOT NULL AND outcome_fingerprint IS NOT NULL))
);
CREATE UNIQUE INDEX production_pilot_one_create ON production_pilot_steps(operation_id) WHERE kind='create';
CREATE UNIQUE INDEX production_pilot_one_variation_init ON production_pilot_steps(operation_id) WHERE kind='variations';
CREATE TABLE production_pilot_verifications (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL UNIQUE REFERENCES production_pilot_operations(id),
 operation_revision integer NOT NULL, phase text NOT NULL CHECK(phase='created_unlisted'),
 item_id text NOT NULL, expected_fingerprint text NOT NULL,
 readbacks jsonb NOT NULL, evidence_fingerprint text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_production_pilot_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PRODUCTION_PILOT_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='production_pilot_operations' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_key IS DISTINCT FROM OLD.owner_key
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.connection_revision IS DISTINCT FROM OLD.connection_revision
    OR NEW.source_identity IS DISTINCT FROM OLD.source_identity OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
    OR NEW.source_payload IS DISTINCT FROM OLD.source_payload OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
    OR NEW.expected_projection IS DISTINCT FROM OLD.expected_projection OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.item_id IS NOT NULL AND NEW.item_id IS DISTINCT FROM OLD.item_id)
    OR NEW.revision<>OLD.revision+1 OR OLD.state='verified'
    THEN RAISE EXCEPTION 'PRODUCTION_PILOT_IMMUTABLE'; END IF;
  IF NOT ((OLD.state='authorized' AND NEW.state IN ('authorized','sent')) OR
          (OLD.state='sent' AND NEW.state IN ('acknowledged','rejected','unknown')) OR
          (OLD.state='acknowledged' AND NEW.state='authorized') OR
          (OLD.state IN ('sent','acknowledged','rejected','unknown') AND NEW.state='verified' AND
           EXISTS(SELECT 1 FROM production_pilot_verifications v WHERE v.operation_id=OLD.id AND v.operation_revision=OLD.revision)))
    THEN RAISE EXCEPTION 'PRODUCTION_PILOT_REPLAY_FORBIDDEN'; END IF;
 ELSE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.step_key IS DISTINCT FROM OLD.step_key OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.path IS DISTINCT FROM OLD.path
    OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.media IS DISTINCT FROM OLD.media
    OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.authorized_revision IS DISTINCT FROM OLD.authorized_revision
    OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR NOT ((OLD.state='authorized' AND NEW.state='sent') OR
            (OLD.state='sent' AND NEW.state IN ('acknowledged','rejected','unknown')))
    THEN RAISE EXCEPTION 'PRODUCTION_PILOT_REPLAY_FORBIDDEN'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_pilot_operation_guard BEFORE UPDATE OR DELETE ON production_pilot_operations FOR EACH ROW EXECUTE FUNCTION guard_production_pilot_journal();
CREATE TRIGGER production_pilot_step_guard BEFORE UPDATE OR DELETE ON production_pilot_steps FOR EACH ROW EXECUTE FUNCTION guard_production_pilot_journal();
CREATE TRIGGER production_pilot_verification_immutable BEFORE UPDATE OR DELETE ON production_pilot_verifications FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE FUNCTION guard_production_pilot_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM production_pilot_operations o JOIN production_pilot_verifications v ON v.operation_id=o.id
   WHERE o.id=OLD.operation_id AND o.owner_key=OLD.owner_key AND o.state='verified' AND v.operation_revision=o.revision-1)
   THEN RAISE EXCEPTION 'PRODUCTION_PILOT_LANE_NEEDS_VERIFICATION'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER production_pilot_lane_guard BEFORE UPDATE OR DELETE ON production_pilot_lanes FOR EACH ROW EXECUTE FUNCTION guard_production_pilot_lane();
