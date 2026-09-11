CREATE TABLE input_batches (
 id uuid PRIMARY KEY,
 latest_revision integer NOT NULL CHECK(latest_revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE input_batch_revisions (
 batch_id uuid NOT NULL REFERENCES input_batches,
 revision integer NOT NULL CHECK(revision > 0),
 state jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(batch_id, revision)
);
CREATE TRIGGER immutable_input_batch BEFORE UPDATE OR DELETE ON input_batch_revisions
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();

CREATE TABLE input_batch_sources (
 batch_id uuid NOT NULL,
 revision integer NOT NULL,
 source_id uuid NOT NULL REFERENCES source_files,
 PRIMARY KEY(batch_id, revision, source_id),
 FOREIGN KEY(batch_id, revision) REFERENCES input_batch_revisions(batch_id, revision)
);
CREATE INDEX input_batch_sources_source ON input_batch_sources(source_id);
CREATE TRIGGER immutable_input_batch_source BEFORE UPDATE OR DELETE ON input_batch_sources
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();

-- Claims remain reserved even when a folder is removed from the current snapshot.
-- A later re-selection of that folder must use the same listing identity.
CREATE TABLE input_batch_products (
 batch_id uuid NOT NULL REFERENCES input_batches,
 group_key text NOT NULL,
 product_key text NOT NULL UNIQUE,
 PRIMARY KEY(batch_id, group_key)
);
