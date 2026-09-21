CREATE TABLE seller_knowledge_draft_acceptances (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  product_key text NOT NULL REFERENCES products(product_key),
  source_revision integer NOT NULL,
  connection_id uuid NOT NULL REFERENCES connections(id),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_key, source_revision) REFERENCES product_revisions(product_key, revision)
);
CREATE INDEX seller_knowledge_draft_acceptance_target ON seller_knowledge_draft_acceptances(product_key, source_revision, connection_id);
CREATE TRIGGER immutable_seller_knowledge_draft_acceptances BEFORE UPDATE OR DELETE ON seller_knowledge_draft_acceptances FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
