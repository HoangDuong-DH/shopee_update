-- Optional source-only API snapshots (for example promotions). Immutable and shop-scoped.
CREATE TABLE shop_listing_archive_aux (
  archive_id uuid NOT NULL,
  item_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('promotion')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(archive_id,item_id,kind),
  FOREIGN KEY(archive_id,item_id) REFERENCES shop_listing_archive_items(archive_id,item_id)
);
CREATE TRIGGER immutable_shop_listing_archive_aux BEFORE UPDATE OR DELETE ON shop_listing_archive_aux
  FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
