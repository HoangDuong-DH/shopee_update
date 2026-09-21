CREATE TABLE prepared_source_batches (
 id uuid PRIMARY KEY,
 request jsonb NOT NULL,
 source_digest text NOT NULL,
 body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE prepared_source_versions (
 source_key text NOT NULL,
 source_fingerprint text NOT NULL,
 source_revision integer NOT NULL,
 PRIMARY KEY(source_key,source_fingerprint),
 FOREIGN KEY(source_key,source_revision) REFERENCES product_revisions(product_key,revision)
);
