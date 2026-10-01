-- The policy is a reviewable part of a destination plan. It does not authorize
-- a Shopee write; clone intents pin its revision and hash before execution.
ALTER TABLE shop_listing_copy_plans
  ADD COLUMN policy jsonb NOT NULL DEFAULT '{"targetStatus":"UNLIST","stockStrategy":"source_saleable_snapshot","priceStrategy":"source_original","promotionStrategy":"record_exception"}'::jsonb
  CHECK (jsonb_typeof(policy) = 'object');
