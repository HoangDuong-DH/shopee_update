-- One confirmed listing variation must not reuse another variation's SKU.
ALTER TABLE listing_price_mapping_rows
  ADD CONSTRAINT listing_price_mapping_rows_unique_sku UNIQUE (receipt_id, sku);
