-- Source snapshots are separate from products, prepared batches and execution jobs.
CREATE TABLE source_catalogs (
  id uuid PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot_checksum text NOT NULL CHECK (snapshot_checksum ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE source_catalog_files (
  catalog_id uuid NOT NULL REFERENCES source_catalogs(id),
  source_id text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY(catalog_id, source_id)
);
CREATE TABLE source_catalog_listings (
  catalog_id uuid NOT NULL REFERENCES source_catalogs(id),
  listing_key text NOT NULL,
  brand text NOT NULL,
  source_order integer NOT NULL,
  search_text text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY(catalog_id, listing_key)
);
CREATE INDEX source_catalog_brand ON source_catalog_listings(catalog_id, brand, source_order);
CREATE TABLE source_catalog_designs (
  catalog_id uuid NOT NULL REFERENCES source_catalogs(id),
  design_id text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY(catalog_id, design_id)
);
CREATE TABLE source_catalog_pages (
  catalog_id uuid NOT NULL,
  design_id text NOT NULL,
  page_id text NOT NULL,
  page_number integer NOT NULL CHECK(page_number > 0),
  body jsonb NOT NULL,
  PRIMARY KEY(catalog_id, design_id, page_id),
  UNIQUE(catalog_id, design_id, page_number),
  FOREIGN KEY(catalog_id, design_id) REFERENCES source_catalog_designs(catalog_id, design_id)
);
CREATE TABLE source_catalog_candidates (
  catalog_id uuid NOT NULL,
  listing_key text NOT NULL,
  design_id text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'suggested' CHECK(status = 'suggested'),
  PRIMARY KEY(catalog_id, listing_key, design_id),
  FOREIGN KEY(catalog_id, listing_key) REFERENCES source_catalog_listings(catalog_id, listing_key),
  FOREIGN KEY(catalog_id, design_id) REFERENCES source_catalog_designs(catalog_id, design_id)
);
