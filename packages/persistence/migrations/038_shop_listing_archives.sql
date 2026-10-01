-- Immutable, scoped pointers to source listing observations. Full Shopee JSON stays
-- in seller_knowledge_observations; this archive does not duplicate it or media bytes.
CREATE TABLE shop_listing_archives (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections(id),
  source_shop_id text NOT NULL,
  name text NOT NULL,
  selection jsonb NOT NULL,
  source_sync_id uuid REFERENCES seller_knowledge_syncs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  item_count integer NOT NULL DEFAULT 0 CHECK(item_count >= 0),
  UNIQUE(connection_id,name,source_sync_id)
);

CREATE TABLE shop_listing_archive_items (
  archive_id uuid NOT NULL REFERENCES shop_listing_archives(id),
  item_id text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES seller_knowledge_observations(id),
  content_hash text NOT NULL,
  item_status text NOT NULL,
  title text NOT NULL,
  brand_id text NOT NULL,
  category_id text,
  model_count integer NOT NULL CHECK(model_count >= 0),
  gallery_count integer NOT NULL CHECK(gallery_count >= 0),
  video_count integer NOT NULL CHECK(video_count >= 0),
  PRIMARY KEY(archive_id,item_id)
);
CREATE INDEX shop_listing_archive_brand ON shop_listing_archive_items(archive_id,brand_id,item_id);
CREATE INDEX shop_listing_archive_evidence ON shop_listing_archive_items(evidence_id);

CREATE TRIGGER immutable_shop_listing_archives BEFORE UPDATE OR DELETE ON shop_listing_archive_items
  FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
