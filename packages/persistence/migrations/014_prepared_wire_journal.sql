-- HTTP-stage journal, intentionally separate from normalized simulation jobs.
CREATE TABLE prepared_wire_operations (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections(id),
 owner_key text NOT NULL, source_key text NOT NULL, fingerprint text NOT NULL,
 input jsonb NOT NULL, state text NOT NULL CHECK(state IN ('prepared','running','unknown','acknowledged','blocked')),
 item_id text, claim_id uuid, lease_until timestamptz, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prepared_wire_owner_lane ON prepared_wire_operations(owner_key) WHERE state IN ('running','unknown');
CREATE UNIQUE INDEX prepared_wire_intent_once ON prepared_wire_operations(owner_key,fingerprint);
CREATE TABLE prepared_wire_steps (
 operation_id uuid NOT NULL REFERENCES prepared_wire_operations(id), ordinal integer NOT NULL,
 path text NOT NULL, payload jsonb NOT NULL, fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('sent','unknown','acknowledged')),
 receipt jsonb, sent_at timestamptz NOT NULL, acknowledged_at timestamptz,
 PRIMARY KEY(operation_id,ordinal)
);
CREATE FUNCTION immutable_prepared_wire() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='prepared_wire_operations' THEN
  IF NEW.input IS DISTINCT FROM OLD.input OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
   OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.owner_key IS DISTINCT FROM OLD.owner_key
   OR NEW.source_key IS DISTINCT FROM OLD.source_key THEN RAISE EXCEPTION 'IMMUTABLE_PREPARED_WIRE'; END IF;
  IF OLD.state IN ('unknown','acknowledged') AND NEW.state IS DISTINCT FROM OLD.state
   THEN RAISE EXCEPTION 'PREPARED_WIRE_REPLAY_FORBIDDEN'; END IF;
 ELSE
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
   OR NEW.path IS DISTINCT FROM OLD.path OR NEW.payload IS DISTINCT FROM OLD.payload
   OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
   OR OLD.state IN ('unknown','acknowledged') AND NEW IS DISTINCT FROM OLD
   THEN RAISE EXCEPTION 'IMMUTABLE_PREPARED_WIRE_STEP'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prepared_wire_operation_immutable BEFORE UPDATE ON prepared_wire_operations FOR EACH ROW EXECUTE FUNCTION immutable_prepared_wire();
CREATE TRIGGER prepared_wire_step_immutable BEFORE UPDATE ON prepared_wire_steps FOR EACH ROW EXECUTE FUNCTION immutable_prepared_wire();
