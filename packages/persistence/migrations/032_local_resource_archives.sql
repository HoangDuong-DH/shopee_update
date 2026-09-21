-- Lifecycle is a reversible overlay. Original sources, revisions and jobs stay unchanged.
CREATE TABLE local_resource_archives (
 kind text NOT NULL CHECK(kind IN ('catalog_listing','input_batch','product','pricebook')),
 resource_id text NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 400),
 archived_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,resource_id)
);
CREATE TABLE local_resource_archive_events (
 id uuid PRIMARY KEY,
 kind text NOT NULL,
 resource_id text NOT NULL,
 archived boolean NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(kind,resource_id) REFERENCES local_resource_archives(kind,resource_id)
);
CREATE TRIGGER immutable_local_archive_event BEFORE UPDATE OR DELETE ON local_resource_archive_events
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
