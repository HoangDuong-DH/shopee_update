-- Keep the compact lookup projection correct even when an older API version writes after rollback.
-- The source is always the immutable listing observation of the same connection.
CREATE FUNCTION refresh_seller_knowledge_item_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT o.body - 'rawItem' - 'rawModels' INTO NEW.summary
  FROM seller_knowledge_observations AS o
  WHERE o.id = NEW.evidence_id AND o.connection_id = NEW.connection_id AND o.kind = 'listing';
  IF NEW.summary IS NULL THEN
    RAISE EXCEPTION 'SELLER_KNOWLEDGE_LISTING_EVIDENCE_MISSING' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refresh_seller_knowledge_item_summary
BEFORE INSERT OR UPDATE OF evidence_id,connection_id,summary ON seller_knowledge_items
FOR EACH ROW EXECUTE FUNCTION refresh_seller_knowledge_item_summary();
