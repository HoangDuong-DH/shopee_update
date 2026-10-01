-- Separate immutable source contract, raw GET payload, and normalized comparator projections.
-- Existing expected_projection_hash is the source-derived archive/policy contract.
ALTER TABLE shop_listing_clone_qc
  ADD COLUMN normalized_expected_hash text CHECK (normalized_expected_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN normalized_observed_hash text CHECK (normalized_observed_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN comparator_result jsonb;
COMMENT ON COLUMN shop_listing_clone_qc.readback_hash IS
  'SHA-256 of two raw target GET receipts; intentionally not equal to expected_projection_hash.';
COMMENT ON COLUMN shop_listing_clone_qc.expected_projection_hash IS
  'Immutable source-derived archive/policy projection hash pinned by the intent.';


ALTER TABLE shop_listing_clone_qc ADD CONSTRAINT clone_qc_verified_projection
  CHECK (result <> 'verified' OR (
    normalized_expected_hash IS NOT NULL AND
    normalized_observed_hash IS NOT NULL AND
    normalized_expected_hash = normalized_observed_hash AND
    comparator_result->>'verified' = 'true')) NOT VALID;
