CREATE TABLE production_source_preparations (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  body jsonb NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz,
  registration jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE production_preparation_executions (
  preparation_id uuid PRIMARY KEY REFERENCES production_source_preparations(id),
  fingerprint text NOT NULL,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
