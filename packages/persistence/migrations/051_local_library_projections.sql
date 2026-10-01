-- Rebuildable display projection only. Raw revisions remain immutable authority.
CREATE FUNCTION local_library_search_key(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
 SELECT translate(lower(normalize(value,NFC)),'áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ','aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd');
$$;
CREATE TABLE local_product_summaries (
 product_key text PRIMARY KEY REFERENCES products(product_key) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>0),
 title text,cover_key text,variant_count integer,asset_count integer,gallery_count integer,
 saved_issue_count integer,saved_blocking_issue_count integer,
 updated_at timestamptz NOT NULL,
 search_name text GENERATED ALWAYS AS (local_library_search_key(COALESCE(title,'') || ' ' || product_key)) STORED
);
CREATE FUNCTION refresh_local_product_summary(key text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO local_product_summaries(product_key,revision,title,cover_key,variant_count,asset_count,gallery_count,
  saved_issue_count,saved_blocking_issue_count,updated_at)
 SELECT p.product_key,p.latest_revision,
  CASE WHEN jsonb_typeof(r.body->'title'->'value')='string' THEN r.body->'title'->>'value' END,
  CASE WHEN jsonb_typeof(r.body->'coverKey')='string' THEN NULLIF(r.body->>'coverKey','') END,
  CASE WHEN jsonb_typeof(r.body->'variants')='array' THEN jsonb_array_length(r.body->'variants') END,
  CASE WHEN jsonb_typeof(r.body->'assets')='array' THEN jsonb_array_length(r.body->'assets') END,
  CASE WHEN jsonb_typeof(r.body->'galleryKeys')='array' THEN jsonb_array_length(r.body->'galleryKeys') END,
  CASE WHEN jsonb_typeof(r.body->'issues')='array' THEN jsonb_array_length(r.body->'issues') END,
  CASE WHEN jsonb_typeof(r.body->'issues')='array' THEN
   (SELECT count(*)::integer FROM jsonb_array_elements(r.body->'issues') issue WHERE issue->>'severity'='block') END,
  p.updated_at
 FROM products p JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision
 WHERE p.product_key=key
 ON CONFLICT(product_key) DO UPDATE SET revision=EXCLUDED.revision,title=EXCLUDED.title,cover_key=EXCLUDED.cover_key,
  variant_count=EXCLUDED.variant_count,asset_count=EXCLUDED.asset_count,gallery_count=EXCLUDED.gallery_count,
  saved_issue_count=EXCLUDED.saved_issue_count,saved_blocking_issue_count=EXCLUDED.saved_blocking_issue_count,
  updated_at=EXCLUDED.updated_at;
$$;
CREATE FUNCTION refresh_local_product_summary_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM refresh_local_product_summary(NEW.product_key);
 RETURN NEW;
END $$;
-- Older clients update the product pointer before inserting its revision. Either
-- write order is covered, within the same source transaction.
CREATE TRIGGER local_product_summary_pointer AFTER INSERT OR UPDATE OF latest_revision,updated_at ON products
 FOR EACH ROW EXECUTE FUNCTION refresh_local_product_summary_trigger();
CREATE TRIGGER local_product_summary_revision AFTER INSERT ON product_revisions
 FOR EACH ROW EXECUTE FUNCTION refresh_local_product_summary_trigger();
SELECT refresh_local_product_summary(product_key) FROM products;

ALTER TABLE source_files ADD COLUMN search_name text GENERATED ALWAYS AS
 (local_library_search_key(filename || ' ' || sha256 || ' ' || id::text)) STORED;
CREATE INDEX products_local_page ON products(updated_at DESC,product_key DESC);
CREATE INDEX source_files_local_page ON source_files(updated_at DESC,id DESC);
CREATE INDEX local_product_summary_search ON local_product_summaries(search_name text_pattern_ops);
CREATE INDEX source_files_local_search ON source_files(search_name text_pattern_ops);
CREATE INDEX work_order_revision_local_product ON work_order_revisions(product_key,order_id,revision);
