-- Target-scoped, role-preserving media transfers. A sent upload never becomes sendable again.
CREATE TABLE shop_listing_media_transfers (
 id uuid PRIMARY KEY,
 archive_id uuid NOT NULL,
 source_item_id text NOT NULL,
 source_role text NOT NULL,
 source_ordinal integer NOT NULL CHECK(source_ordinal >= 0),
 blob_sha256 text NOT NULL REFERENCES shop_listing_media_blobs(sha256),
 media_kind text NOT NULL CHECK(media_kind IN ('image','video')),
 image_scene text NOT NULL DEFAULT '' CHECK(image_scene IN ('','normal','desc')),
 image_ratio text NOT NULL DEFAULT '' CHECK(image_ratio IN ('','1:1','3:4')),
 target_connection_id uuid NOT NULL REFERENCES connections(id),
 target_connection_revision integer NOT NULL CHECK(target_connection_revision > 0),
 target_partner_id text NOT NULL,
 target_shop_id text NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','sent','acknowledged','unknown','rejected','held')),
 remote_media_id text,
 receipt jsonb,
 receipt_hash text CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 sent_at timestamptz,
 recorded_at timestamptz,
 reconciled_at timestamptz,
 reconciliation jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(archive_id,source_item_id,source_role,source_ordinal)
  REFERENCES shop_listing_media_refs(archive_id,item_id,role,ordinal),
 UNIQUE(target_partner_id,target_shop_id,blob_sha256,source_role,media_kind,image_scene,image_ratio),
 CHECK((media_kind='video' AND source_role='video' AND image_scene='' AND image_ratio='')
    OR (media_kind='image' AND source_role<>'video')),
 CHECK((state='reserved' AND sent_at IS NULL AND receipt IS NULL AND remote_media_id IS NULL)
    OR (state='sent' AND sent_at IS NOT NULL AND receipt IS NULL AND remote_media_id IS NULL)
    OR (state IN ('acknowledged','unknown','rejected','held') AND sent_at IS NOT NULL AND receipt IS NOT NULL)),
 CHECK((state='acknowledged' AND remote_media_id IS NOT NULL)
    OR (state<>'acknowledged' AND remote_media_id IS NULL))
);
CREATE INDEX shop_listing_media_transfers_pending ON shop_listing_media_transfers(target_shop_id,state,created_at);

-- Durable CAS adapter for video-upload's per-part state machine.
CREATE TABLE shop_listing_video_upload_entries (
 key text PRIMARY KEY,
 target_partner_id text NOT NULL,
 target_shop_id text NOT NULL,
 source_item_id text NOT NULL,
 blob_sha256 text NOT NULL REFERENCES shop_listing_media_blobs(sha256),
 revision integer NOT NULL CHECK(revision >= 0),
 entry jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(key = 'production:' || target_partner_id || ':' || target_shop_id || ':' || source_item_id || ':' || blob_sha256)
);
CREATE INDEX shop_listing_video_upload_entries_scope ON shop_listing_video_upload_entries(target_partner_id,target_shop_id,source_item_id);

CREATE FUNCTION guard_shop_listing_media_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MEDIA_TRANSFER_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','remote_media_id','receipt','receipt_hash','sent_at','recorded_at','reconciled_at','reconciliation'])
      IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','remote_media_id','receipt','receipt_hash','sent_at','recorded_at','reconciled_at','reconciliation'])
    OR NOT ((OLD.state='reserved' AND NEW.state='sent')
        OR (OLD.state='sent' AND NEW.state IN ('acknowledged','unknown','rejected'))
        OR (OLD.state='unknown' AND NEW.state IN ('acknowledged','held')))
 THEN RAISE EXCEPTION 'MEDIA_TRANSFER_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_shop_listing_media_transfer_change
 BEFORE UPDATE OR DELETE ON shop_listing_media_transfers
 FOR EACH ROW EXECUTE FUNCTION guard_shop_listing_media_transfer();

