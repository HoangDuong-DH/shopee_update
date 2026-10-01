-- Explicit, revision-bound decisions made after a listing draft has been created.
-- Original product revisions and imported workbook bytes remain authoritative.
CREATE TABLE listing_price_mapping_receipts (
  id uuid PRIMARY KEY,
  product_key text NOT NULL,
  product_revision integer NOT NULL,
  review_fingerprint text NOT NULL CHECK (review_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_key, product_revision) REFERENCES product_revisions(product_key, revision),
  UNIQUE (product_key, product_revision)
);

CREATE TABLE listing_price_mapping_rows (
  receipt_id uuid NOT NULL REFERENCES listing_price_mapping_receipts(id),
  slot_key text NOT NULL CHECK (slot_key ~ '^[a-f0-9]{64}$'),
  option_labels jsonb NOT NULL CHECK (jsonb_typeof(option_labels) = 'array'),
  price_import_id uuid NOT NULL REFERENCES source_files(id),
  price_row_key text NOT NULL,
  price_file_sha256 text NOT NULL CHECK (price_file_sha256 ~ '^[a-f0-9]{64}$'),
  price_sheet text NOT NULL,
  price_profile text,
  sku text NOT NULL,
  sku_cell text NOT NULL,
  original_price text NOT NULL CHECK (original_price ~ '^[1-9][0-9]*$'),
  price_cell text NOT NULL,
  PRIMARY KEY (receipt_id, slot_key),
  UNIQUE (receipt_id, price_import_id, price_row_key)
);

CREATE INDEX listing_price_mapping_rows_source ON listing_price_mapping_rows(price_import_id, price_row_key);
CREATE TRIGGER listing_price_mapping_receipt_immutable BEFORE UPDATE OR DELETE ON listing_price_mapping_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TRIGGER listing_price_mapping_row_immutable BEFORE UPDATE OR DELETE ON listing_price_mapping_rows
  FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
