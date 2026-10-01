-- One permanent create identity per archived item and destination shop.
CREATE TABLE shop_listing_clone_intents (
 id uuid PRIMARY KEY,
 archive_id uuid NOT NULL,
 source_item_id text NOT NULL,
 source_evidence_id uuid NOT NULL REFERENCES seller_knowledge_observations(id),
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
 planned_payload_hash text NOT NULL CHECK (planned_payload_hash ~ '^[a-f0-9]{64}$'),
 expected_projection_hash text NOT NULL CHECK (expected_projection_hash ~ '^[a-f0-9]{64}$'),
 target_connection_id uuid NOT NULL REFERENCES connections(id),
 target_connection_revision integer NOT NULL CHECK (target_connection_revision > 0),
 target_partner_id text NOT NULL,
 target_shop_id text NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','working','needs_reconciliation','needs_qc','verified','held')),
 target_item_id text CHECK (target_item_id ~ '^[1-9][0-9]*$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (archive_id,source_item_id,target_partner_id,target_shop_id),
 FOREIGN KEY (archive_id,source_item_id) REFERENCES shop_listing_archive_items(archive_id,item_id)
);
CREATE INDEX shop_listing_clone_intents_state ON shop_listing_clone_intents(state,created_at);

-- A sent create stays reserved forever, including ambiguous outcomes.
CREATE TABLE shop_listing_clone_steps (
 id uuid PRIMARY KEY,
 intent_id uuid NOT NULL REFERENCES shop_listing_clone_intents(id),
 step_key text NOT NULL CHECK (step_key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 ordinal integer NOT NULL CHECK (ordinal > 0),
 kind text NOT NULL CHECK (kind IN ('image','video','create','init_variation')),
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized','sent','acknowledged','rejected','unknown')),
 receipt jsonb,
 receipt_hash text CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
 authorized_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 recorded_at timestamptz,
 UNIQUE (intent_id,step_key), UNIQUE (intent_id,ordinal),
 CHECK ((state='authorized' AND sent_at IS NULL AND receipt IS NULL AND receipt_hash IS NULL AND recorded_at IS NULL)
     OR (state='sent' AND sent_at IS NOT NULL AND receipt IS NULL AND receipt_hash IS NULL AND recorded_at IS NULL)
     OR (state IN ('acknowledged','rejected','unknown') AND sent_at IS NOT NULL AND receipt IS NOT NULL AND receipt_hash IS NOT NULL AND recorded_at IS NOT NULL))
);
CREATE UNIQUE INDEX shop_listing_clone_one_create ON shop_listing_clone_steps(intent_id) WHERE kind='create';
CREATE UNIQUE INDEX shop_listing_clone_one_init ON shop_listing_clone_steps(intent_id) WHERE kind='init_variation';

-- An absence report never unlocks a second create.
CREATE TABLE shop_listing_clone_reconciliations (
 id uuid PRIMARY KEY,
 step_id uuid NOT NULL UNIQUE REFERENCES shop_listing_clone_steps(id),
 finding text NOT NULL CHECK (finding IN ('found','absent','inconclusive')),
 target_item_id text CHECK (target_item_id ~ '^[1-9][0-9]*$'),
 evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL,
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK (finding='found' OR target_item_id IS NULL)
);

CREATE TABLE shop_listing_clone_qc (
 id uuid PRIMARY KEY,
 intent_id uuid NOT NULL UNIQUE REFERENCES shop_listing_clone_intents(id),
 target_item_id text NOT NULL CHECK (target_item_id ~ '^[1-9][0-9]*$'),
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 expected_projection_hash text NOT NULL CHECK (expected_projection_hash ~ '^[a-f0-9]{64}$'),
 readback_hash text NOT NULL CHECK (readback_hash ~ '^[a-f0-9]{64}$'),
 readback jsonb NOT NULL,
 result text NOT NULL CHECK (result IN ('verified','mismatch')),
 checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION guard_shop_listing_clone_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLONE_INTENT_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','target_item_id','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','target_item_id','updated_at'])
    OR (OLD.target_item_id IS NOT NULL AND NEW.target_item_id IS DISTINCT FROM OLD.target_item_id)
    OR OLD.state='verified'
    OR NOT ((OLD.state='reserved' AND NEW.state IN ('working','held'))
         OR (OLD.state='working' AND NEW.state IN ('needs_reconciliation','needs_qc','held'))
         OR (OLD.state='needs_reconciliation' AND NEW.state IN ('working','needs_qc','held'))
         OR (OLD.state='needs_qc' AND NEW.state IN ('verified','held'))
         OR (OLD.state='held' AND NEW.state IN ('needs_qc','verified')))
 THEN RAISE EXCEPTION 'CLONE_INTENT_TRANSITION_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_shop_listing_clone_intents BEFORE UPDATE OR DELETE ON shop_listing_clone_intents
 FOR EACH ROW EXECUTE FUNCTION guard_shop_listing_clone_intent();

CREATE FUNCTION guard_shop_listing_clone_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLONE_STEP_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','receipt','receipt_hash','sent_at','recorded_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','receipt','receipt_hash','sent_at','recorded_at'])
    OR NOT ((OLD.state='authorized' AND NEW.state='sent')
         OR (OLD.state='sent' AND NEW.state IN ('acknowledged','rejected','unknown')))
 THEN RAISE EXCEPTION 'CLONE_STEP_REPLAY_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_shop_listing_clone_steps BEFORE UPDATE OR DELETE ON shop_listing_clone_steps
 FOR EACH ROW EXECUTE FUNCTION guard_shop_listing_clone_step();
CREATE TRIGGER immutable_shop_listing_clone_reconciliations BEFORE UPDATE OR DELETE ON shop_listing_clone_reconciliations
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TRIGGER immutable_shop_listing_clone_qc BEFORE UPDATE OR DELETE ON shop_listing_clone_qc
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();

