CREATE TABLE sandbox_field_trials (
 id uuid PRIMARY KEY,
 trial_item_id uuid NOT NULL REFERENCES sandbox_create_trial_items(id),
 connection_id uuid NOT NULL REFERENCES connections(id),
 connection_revision integer NOT NULL,
 item_id text NOT NULL CHECK(item_id NOT IN ('803934364','846056124')),
 fingerprint text NOT NULL,
 input jsonb NOT NULL,
 baseline jsonb NOT NULL,
 operation jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','unknown','verified','blocked')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sandbox_field_shop_lane ON sandbox_field_trials(connection_id) WHERE state='unknown';
CREATE FUNCTION immutable_sandbox_field_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.input IS DISTINCT FROM OLD.input OR NEW.operation IS DISTINCT FROM OLD.operation OR NEW.baseline IS DISTINCT FROM OLD.baseline
 OR NEW.fingerprint <> OLD.fingerprint OR NEW.connection_id <> OLD.connection_id OR NEW.connection_revision <> OLD.connection_revision
 OR NEW.trial_item_id <> OLD.trial_item_id OR NEW.item_id <> OLD.item_id THEN RAISE EXCEPTION 'IMMUTABLE_SANDBOX_FIELD_INTENT'; END IF;
 IF OLD.state <> 'prepared' AND NEW.state='prepared' THEN RAISE EXCEPTION 'SANDBOX_FIELD_REPLAY_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_sandbox_field_intent BEFORE UPDATE ON sandbox_field_trials FOR EACH ROW EXECUTE FUNCTION immutable_sandbox_field_intent();
