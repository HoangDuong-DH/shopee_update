CREATE TABLE image_qc_cases (
  id uuid PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  binding jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  output_sha256 text NOT NULL CHECK (output_sha256 ~ '^[a-f0-9]{64}$'),
  comparison jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX image_qc_cases_recent ON image_qc_cases (created_at DESC, id);
CREATE TABLE image_qc_reviews (
  request_id uuid PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE REFERENCES image_qc_cases(id),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  result jsonb NOT NULL
);
CREATE FUNCTION reject_image_qc_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMAGE_QC_IMMUTABLE';
END;
$$;
CREATE TRIGGER immutable_image_qc_case BEFORE UPDATE OR DELETE ON image_qc_cases
  FOR EACH ROW EXECUTE FUNCTION reject_image_qc_mutation();
CREATE TRIGGER immutable_image_qc_review BEFORE UPDATE OR DELETE ON image_qc_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_image_qc_mutation();
