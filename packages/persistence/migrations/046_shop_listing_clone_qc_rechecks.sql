-- Append-only follow-up QC after an initial mismatch. No Shopee mutation is unlocked.
-- The first QC row remains immutable and is never overwritten.
CREATE TABLE shop_listing_clone_qc_rechecks (
 id uuid PRIMARY KEY,
 intent_id uuid NOT NULL REFERENCES shop_listing_clone_intents(id),
 initial_qc_id uuid NOT NULL REFERENCES shop_listing_clone_qc(id),
 attempt_no integer NOT NULL CHECK (attempt_no > 0),
 target_item_id text NOT NULL CHECK (target_item_id ~ '^[1-9][0-9]*$'),
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 expected_projection_hash text NOT NULL CHECK (expected_projection_hash ~ '^[a-f0-9]{64}$'),
 readback_hash text NOT NULL CHECK (readback_hash ~ '^[a-f0-9]{64}$'),
 readback jsonb NOT NULL,
 proof jsonb NOT NULL,
 normalized_expected_hash text NOT NULL CHECK (normalized_expected_hash ~ '^[a-f0-9]{64}$'),
 normalized_observed_hash text NOT NULL CHECK (normalized_observed_hash ~ '^[a-f0-9]{64}$'),
 comparator_result jsonb NOT NULL,
 result text NOT NULL CHECK (result IN ('verified','mismatch')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (intent_id,attempt_no),
 CHECK (result <> 'verified' OR
   (normalized_expected_hash = normalized_observed_hash AND comparator_result->>'verified' = 'true'))
);
CREATE TRIGGER immutable_shop_listing_clone_qc_rechecks
 BEFORE UPDATE OR DELETE ON shop_listing_clone_qc_rechecks
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
