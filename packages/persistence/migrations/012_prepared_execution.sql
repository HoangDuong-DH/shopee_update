-- Prepared business execution is an independent pipeline. Legacy jobs and sandbox trials are unchanged.
CREATE TABLE prepared_execution_batches (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL,
 fingerprint text NOT NULL UNIQUE,
 input_source_digest text NOT NULL,
 input jsonb NOT NULL,
 mode text NOT NULL CHECK(mode='simulation'),
 created_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz
);
CREATE TABLE prepared_execution_jobs (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES prepared_execution_batches(id),
 position integer NOT NULL,
 connection_id uuid NOT NULL REFERENCES connections(id),
 owner_key text NOT NULL,
 source_key text NOT NULL,
 intent_key text NOT NULL,
 entry jsonb NOT NULL,
 operation text NOT NULL CHECK(operation IN ('create','update')),
 field_mask jsonb NOT NULL,
 selected_skus jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','queued','running','unknown','verified','blocked','cancelled')),
 paused boolean NOT NULL DEFAULT false,
 mutation_sent boolean NOT NULL DEFAULT false,
 item_id text,
 baseline jsonb,
 expected jsonb NOT NULL,
 receipt jsonb,
 readback jsonb,
 result jsonb,
 claim_id uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,position)
);
CREATE INDEX prepared_execution_queue ON prepared_execution_jobs(created_at,position) WHERE state='queued' AND NOT paused;
CREATE UNIQUE INDEX prepared_execution_owner_lane ON prepared_execution_jobs(owner_key) WHERE state IN ('running','unknown');
CREATE UNIQUE INDEX prepared_execution_intent_once ON prepared_execution_jobs(intent_key) WHERE state NOT IN ('blocked','cancelled');
CREATE TABLE prepared_execution_bindings (
 owner_key text NOT NULL,
 source_key text NOT NULL,
 create_job_id uuid NOT NULL REFERENCES prepared_execution_jobs(id),
 state text NOT NULL CHECK(state IN ('reserved','unknown','bound')),
 item_id text,
 model_bindings jsonb,
 snapshot jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_key,source_key)
);
CREATE UNIQUE INDEX prepared_execution_item_owner ON prepared_execution_bindings(owner_key,item_id) WHERE item_id IS NOT NULL;
CREATE FUNCTION immutable_prepared_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='prepared_execution_batches' THEN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.input IS DISTINCT FROM OLD.input
   OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.input_source_digest IS DISTINCT FROM OLD.input_source_digest
   OR NEW.mode IS DISTINCT FROM OLD.mode THEN RAISE EXCEPTION 'IMMUTABLE_PREPARED_EXECUTION'; END IF;
 ELSE
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.entry IS DISTINCT FROM OLD.entry
   OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.owner_key IS DISTINCT FROM OLD.owner_key
   OR NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.intent_key IS DISTINCT FROM OLD.intent_key
   OR NEW.operation IS DISTINCT FROM OLD.operation OR NEW.field_mask IS DISTINCT FROM OLD.field_mask
   OR NEW.selected_skus IS DISTINCT FROM OLD.selected_skus OR NEW.baseline IS DISTINCT FROM OLD.baseline
   OR NEW.expected IS DISTINCT FROM OLD.expected THEN RAISE EXCEPTION 'IMMUTABLE_PREPARED_EXECUTION'; END IF;
  IF OLD.mutation_sent AND (NOT NEW.mutation_sent OR NEW.state IN ('prepared','queued','running','cancelled','blocked'))
   THEN RAISE EXCEPTION 'PREPARED_MUTATION_REPLAY_FORBIDDEN'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_prepared_execution_batch BEFORE UPDATE ON prepared_execution_batches FOR EACH ROW EXECUTE FUNCTION immutable_prepared_execution();
CREATE TRIGGER immutable_prepared_execution_job BEFORE UPDATE ON prepared_execution_jobs FOR EACH ROW EXECUTE FUNCTION immutable_prepared_execution();
