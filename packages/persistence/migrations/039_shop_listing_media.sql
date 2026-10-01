-- Media bytes live in a content-addressed file store, never in PostgreSQL.
CREATE TABLE shop_listing_media_blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_count bigint NOT NULL CHECK (byte_count > 0),
  mime text NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shop_listing_media_refs (
  archive_id uuid NOT NULL REFERENCES shop_listing_archives(id),
  item_id text NOT NULL,
  role text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_media_id text,
  source_url text NOT NULL,
  blob_sha256 text REFERENCES shop_listing_media_blobs(sha256),
  state text NOT NULL CHECK (state IN ('pending','stored','failed')) DEFAULT 'pending',
  last_error text,
  fetched_at timestamptz,
  PRIMARY KEY(archive_id,item_id,role,ordinal),
  FOREIGN KEY(archive_id,item_id) REFERENCES shop_listing_archive_items(archive_id,item_id)
);
CREATE INDEX shop_listing_media_refs_state ON shop_listing_media_refs(archive_id,state);
CREATE INDEX shop_listing_media_refs_blob ON shop_listing_media_refs(blob_sha256) WHERE blob_sha256 IS NOT NULL;
