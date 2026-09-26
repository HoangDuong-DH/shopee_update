-- Search projection only. Immutable observations remain the evidence of what Shopee returned.
ALTER TABLE seller_knowledge_items ADD COLUMN summary jsonb;
UPDATE seller_knowledge_items AS i
SET summary = o.body - 'rawItem' - 'rawModels'
FROM seller_knowledge_observations AS o
WHERE o.id = i.evidence_id AND o.connection_id = i.connection_id;
ALTER TABLE seller_knowledge_items ALTER COLUMN summary SET NOT NULL;
ALTER TABLE seller_knowledge_items ADD CONSTRAINT seller_knowledge_summary_object CHECK (jsonb_typeof(summary) = 'object');
