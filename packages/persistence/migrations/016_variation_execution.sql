CREATE TABLE variation_operations (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections(id),
 owner_key text NOT NULL, fingerprint text NOT NULL, input jsonb NOT NULL, plan jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','running','verified','blocked','unknown')),
 claim_id uuid, lease_until timestamptz, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_key,fingerprint)
);
CREATE UNIQUE INDEX variation_owner_lane ON variation_operations(owner_key) WHERE state IN ('running','unknown');
CREATE TABLE variation_steps (
 operation_id uuid NOT NULL REFERENCES variation_operations(id), ordinal integer NOT NULL,
 path text NOT NULL, payload jsonb NOT NULL, before_snapshot jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('sent','verified','unknown')), receipt jsonb, qc jsonb,
 after_snapshot jsonb, sent_at timestamptz NOT NULL, verified_at timestamptz,
 PRIMARY KEY(operation_id,ordinal)
);
CREATE FUNCTION immutable_variation_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='variation_operations' THEN
  IF NEW.input IS DISTINCT FROM OLD.input OR NEW.plan IS DISTINCT FROM OLD.plan
   OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.owner_key IS DISTINCT FROM OLD.owner_key
   OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.id IS DISTINCT FROM OLD.id
   THEN RAISE EXCEPTION 'IMMUTABLE_VARIATION_INTENT'; END IF;
  IF OLD.state IN ('verified','blocked','unknown') AND NEW IS DISTINCT FROM OLD
   THEN RAISE EXCEPTION 'VARIATION_REPLAY_FORBIDDEN'; END IF;
 ELSE
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
   OR NEW.path IS DISTINCT FROM OLD.path OR NEW.payload IS DISTINCT FROM OLD.payload
   OR NEW.before_snapshot IS DISTINCT FROM OLD.before_snapshot OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
   OR OLD.state IN ('verified','unknown') AND NEW IS DISTINCT FROM OLD
   THEN RAISE EXCEPTION 'IMMUTABLE_VARIATION_STEP'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER variation_operation_immutable BEFORE UPDATE ON variation_operations FOR EACH ROW EXECUTE FUNCTION immutable_variation_execution();
CREATE TRIGGER variation_step_immutable BEFORE UPDATE ON variation_steps FOR EACH ROW EXECUTE FUNCTION immutable_variation_execution();
