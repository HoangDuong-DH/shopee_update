CREATE TABLE sandbox_listing_runs (
 id uuid PRIMARY KEY,
 connection_id uuid NOT NULL REFERENCES connections(id),
 item_id text NOT NULL,
 product_key text NOT NULL,
 source_revision integer NOT NULL,
 connection_revision integer NOT NULL,
 input_fingerprint text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 state text NOT NULL CHECK(state IN ('prepared','in_flight','unknown','verified','rejected','drift')),
 intent jsonb NOT NULL,
 body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(product_key,source_revision) REFERENCES product_revisions(product_key,revision)
);
CREATE UNIQUE INDEX sandbox_listing_one_active_target ON sandbox_listing_runs(connection_id,item_id)
 WHERE state IN ('in_flight','unknown');
CREATE TABLE sandbox_listing_run_events (
 id bigserial PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES sandbox_listing_runs(id),
 revision integer NOT NULL,
 state text NOT NULL,
 code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,revision)
);
CREATE FUNCTION reject_sandbox_intent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.intent IS DISTINCT FROM OLD.intent OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
  OR NEW.connection_id <> OLD.connection_id OR NEW.item_id <> OLD.item_id
  OR NEW.product_key <> OLD.product_key OR NEW.source_revision <> OLD.source_revision
  OR NEW.connection_revision <> OLD.connection_revision THEN
  RAISE EXCEPTION 'IMMUTABLE_SANDBOX_INTENT';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_sandbox_intent BEFORE UPDATE ON sandbox_listing_runs
 FOR EACH ROW EXECUTE FUNCTION reject_sandbox_intent_mutation();
