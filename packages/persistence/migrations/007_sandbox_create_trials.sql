CREATE TABLE sandbox_create_trials (
 id uuid PRIMARY KEY,
 trial_key text NOT NULL,
 connection_id uuid NOT NULL REFERENCES connections(id),
 connection_revision integer NOT NULL,
 fingerprint text NOT NULL,
 manifest jsonb NOT NULL,
 evidence jsonb NOT NULL,
 paused boolean NOT NULL DEFAULT false,
 pause_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,trial_key)
);
CREATE TABLE sandbox_create_trial_items (
 id uuid PRIMARY KEY,
 trial_id uuid NOT NULL REFERENCES sandbox_create_trials(id),
 connection_id uuid NOT NULL REFERENCES connections(id),
 source_key text NOT NULL,
 position integer NOT NULL,
 intent jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting','verified','failed','unknown')),
 stage text NOT NULL DEFAULT 'queued' CHECK(stage IN ('queued','create_intent','created','tiers_intent','readback','done')),
 item_id text,
 lease_epoch integer NOT NULL DEFAULT 0,
 lease_until timestamptz,
 worker_id text,
 attempt_count integer NOT NULL DEFAULT 0,
 read_count integer NOT NULL DEFAULT 0,
 next_run_at timestamptz NOT NULL DEFAULT now(),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,source_key),
 UNIQUE(trial_id,position),
 UNIQUE(connection_id,item_id)
);
CREATE INDEX sandbox_create_due ON sandbox_create_trial_items(next_run_at) WHERE state IN ('queued','waiting');
CREATE UNIQUE INDEX sandbox_create_one_running ON sandbox_create_trial_items(connection_id) WHERE state='running';
CREATE TABLE sandbox_create_trial_attempts (
 id uuid PRIMARY KEY,
 trial_item_id uuid NOT NULL REFERENCES sandbox_create_trial_items(id),
 lease_epoch integer NOT NULL,
 stage text NOT NULL CHECK(stage IN ('create_intent','tiers_intent')),
 input_fingerprint text NOT NULL,
 input jsonb NOT NULL,
 outcome jsonb,
 started_at timestamptz NOT NULL,
 finished_at timestamptz,
 UNIQUE(trial_item_id,stage)
);
CREATE TABLE sandbox_create_trial_events (
 id bigserial PRIMARY KEY,
 trial_item_id uuid NOT NULL REFERENCES sandbox_create_trial_items(id),
 lease_epoch integer NOT NULL,
 code text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION immutable_sandbox_create_trial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.fingerprint <> OLD.fingerprint
 OR NEW.connection_id <> OLD.connection_id OR NEW.connection_revision <> OLD.connection_revision OR NEW.trial_key <> OLD.trial_key THEN
  RAISE EXCEPTION 'IMMUTABLE_SANDBOX_CREATE_TRIAL';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_sandbox_create_trial BEFORE UPDATE ON sandbox_create_trials FOR EACH ROW EXECUTE FUNCTION immutable_sandbox_create_trial();
CREATE FUNCTION immutable_sandbox_create_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.intent IS DISTINCT FROM OLD.intent OR NEW.connection_id <> OLD.connection_id OR NEW.source_key <> OLD.source_key OR NEW.trial_id <> OLD.trial_id
 OR (OLD.item_id IS NOT NULL AND NEW.item_id IS DISTINCT FROM OLD.item_id) THEN
  RAISE EXCEPTION 'IMMUTABLE_SANDBOX_CREATE_ITEM';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_sandbox_create_item BEFORE UPDATE ON sandbox_create_trial_items FOR EACH ROW EXECUTE FUNCTION immutable_sandbox_create_item();
