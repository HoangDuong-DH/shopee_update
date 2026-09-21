-- Publication is a distinct, source-bound stage. Created-UNLIST evidence remains immutable.
CREATE TABLE production_pilot_publications (
 id uuid PRIMARY KEY,
 owner_key text NOT NULL CHECK(owner_key='production:2010476:1423724897'),
 create_operation_id uuid NOT NULL UNIQUE REFERENCES production_pilot_operations(id),
 create_verification_id uuid NOT NULL REFERENCES production_pilot_verifications(id),
 connection_id uuid NOT NULL REFERENCES connections(id), connection_revision integer NOT NULL CHECK(connection_revision>0),
 source_identity text NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 item_id text NOT NULL CHECK(item_id ~ '^[1-9][0-9]*$'),
 path text NOT NULL CHECK(path='/api/v2/product/unlist_item'), payload jsonb NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 expected_projection jsonb NOT NULL, expected_raw jsonb NOT NULL,
 preflight_readbacks jsonb NOT NULL, preflight_expires_at timestamptz NOT NULL, preflight_metadata jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('authorized','sent','acknowledged','rejected','unknown','verified')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), receipt jsonb, outcome_fingerprint text,
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, recorded_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_key,source_identity,source_revision),
 CHECK ((state='authorized' AND sent_at IS NULL AND receipt IS NULL) OR
        (state='sent' AND sent_at IS NOT NULL AND receipt IS NULL) OR
        (state IN ('acknowledged','rejected','unknown') AND sent_at IS NOT NULL AND receipt IS NOT NULL AND outcome_fingerprint IS NOT NULL) OR
        (state='verified' AND sent_at IS NOT NULL))
);
CREATE TABLE production_pilot_publication_verifications (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL UNIQUE REFERENCES production_pilot_publications(id),
 operation_revision integer NOT NULL, phase text NOT NULL CHECK(phase='published'),
 basis text NOT NULL CHECK(basis IN ('acknowledged','read_reconciliation')),
 item_id text NOT NULL, readbacks jsonb NOT NULL, evidence_fingerprint text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_production_pilot_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PRODUCTION_PILOT_PUBLICATION_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','revision','receipt','outcome_fingerprint','sent_at','recorded_at','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','receipt','outcome_fingerprint','sent_at','recorded_at','updated_at'])
    OR NEW.revision<>OLD.revision+1 OR OLD.state='verified'
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR (OLD.receipt IS NOT NULL AND (NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.outcome_fingerprint IS DISTINCT FROM OLD.outcome_fingerprint OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at))
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_PUBLICATION_IMMUTABLE'; END IF;
 IF NOT ((OLD.state='authorized' AND NEW.state='sent') OR
         (OLD.state='sent' AND NEW.state IN ('acknowledged','rejected','unknown')) OR
         (OLD.state IN ('acknowledged','rejected','unknown') AND NEW.state='verified' AND EXISTS(
           SELECT 1 FROM production_pilot_publication_verifications v WHERE v.operation_id=OLD.id AND v.operation_revision=OLD.revision)))
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_PUBLICATION_REPLAY_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_pilot_publication_guard BEFORE UPDATE OR DELETE ON production_pilot_publications FOR EACH ROW EXECUTE FUNCTION guard_production_pilot_publication();
CREATE TRIGGER production_pilot_publication_verification_immutable BEFORE UPDATE OR DELETE ON production_pilot_publication_verifications FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE FUNCTION guard_production_pilot_publication_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM production_pilot_publications p WHERE p.create_operation_id=OLD.operation_id AND p.state<>'verified')
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_PUBLICATION_LANE_NEEDS_VERIFICATION'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER production_pilot_publication_lane_guard BEFORE UPDATE OR DELETE ON production_pilot_lanes FOR EACH ROW EXECUTE FUNCTION guard_production_pilot_publication_lane();
