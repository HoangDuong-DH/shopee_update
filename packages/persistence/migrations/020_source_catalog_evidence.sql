CREATE TABLE source_catalog_evidence (
  catalog_id uuid NOT NULL REFERENCES source_catalogs(id),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(catalog_id,evidence_sha256)
);
CREATE FUNCTION reject_source_catalog_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CATALOG_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_source_catalog_evidence BEFORE UPDATE OR DELETE ON source_catalog_evidence
FOR EACH ROW EXECUTE FUNCTION reject_source_catalog_evidence_mutation();
