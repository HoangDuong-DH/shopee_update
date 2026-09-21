CREATE TABLE sandbox_listing_reconciliations (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES sandbox_listing_runs(id),
 run_revision integer NOT NULL CHECK(run_revision>0),
 run_input_fingerprint text NOT NULL,
 run_content_hash text NOT NULL CHECK(run_content_hash ~ '^[a-f0-9]{64}$'),
 run_snapshot jsonb NOT NULL,
 request jsonb NOT NULL,
 verified boolean NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sandbox_listing_recovery_verified ON sandbox_listing_reconciliations(run_id,run_revision) WHERE verified;
CREATE FUNCTION immutable_legacy_listing_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'LEGACY_LISTING_RECOVERY_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_legacy_listing_recovery BEFORE UPDATE OR DELETE ON sandbox_listing_reconciliations
 FOR EACH ROW EXECUTE FUNCTION immutable_legacy_listing_recovery();
