CREATE TABLE seller_knowledge_fact_receipts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  connection_id uuid NOT NULL REFERENCES connections(id),
  item_id text NOT NULL,
  target_fingerprint text NOT NULL,
  request_fingerprint text NOT NULL,
  source_reference text NOT NULL,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_knowledge_fact_target ON seller_knowledge_fact_receipts(connection_id, item_id, target_fingerprint, created_at DESC);
CREATE TRIGGER immutable_seller_knowledge_facts BEFORE UPDATE OR DELETE ON seller_knowledge_fact_receipts FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
