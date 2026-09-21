CREATE TABLE folder_source_claims (
  product_key text PRIMARY KEY REFERENCES products(product_key),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  selection_fingerprint text NOT NULL CHECK (selection_fingerprint ~ '^[a-f0-9]{64}$'),
  batch_id uuid NOT NULL,
  batch_revision integer NOT NULL,
  group_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id,batch_revision) REFERENCES input_batch_revisions(batch_id,revision)
);
CREATE FUNCTION protect_folder_source_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FOLDER_SOURCE_CLAIM_IMMUTABLE'; END;
$$;
CREATE TRIGGER folder_source_claim_immutable BEFORE UPDATE OR DELETE ON folder_source_claims
FOR EACH ROW EXECUTE FUNCTION protect_folder_source_claim();
