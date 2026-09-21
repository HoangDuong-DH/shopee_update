-- Read-only, scoped observations. These tables do not authorize any marketplace write.
CREATE TABLE seller_knowledge_syncs (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, connection_id uuid NOT NULL REFERENCES connections(id),
 scope jsonb NOT NULL, connection_revision integer NOT NULL, max_items integer NOT NULL CHECK(max_items BETWEEN 1 AND 500),
 state text NOT NULL CHECK(state IN ('queued','running','paused','complete','failed')),
 cursor jsonb NOT NULL, processed_count integer NOT NULL DEFAULT 0, fetched_count integer NOT NULL DEFAULT 0,
 reused_count integer NOT NULL DEFAULT 0, request_count integer NOT NULL DEFAULT 0,
 code text, issues jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_knowledge_sync_connection ON seller_knowledge_syncs(connection_id,created_at DESC);
CREATE TABLE seller_knowledge_observations (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections(id), kind text NOT NULL CHECK(kind IN ('read','listing','category','category_tree')),
 subject_key text NOT NULL, content_hash text NOT NULL, scope jsonb NOT NULL, body jsonb NOT NULL,
 observed_at timestamptz NOT NULL, UNIQUE(connection_id,kind,subject_key,content_hash)
);
CREATE TRIGGER immutable_seller_knowledge BEFORE UPDATE OR DELETE ON seller_knowledge_observations FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TABLE seller_knowledge_items (
 connection_id uuid NOT NULL REFERENCES connections(id), item_id text NOT NULL, evidence_id uuid NOT NULL REFERENCES seller_knowledge_observations(id),
 category_id text, brand_id text, title text NOT NULL, item_sku text NOT NULL, model_skus text[] NOT NULL DEFAULT '{}',
 normalized_text text NOT NULL, item_status text NOT NULL, remote_updated_at bigint, complete boolean NOT NULL,
 last_seen_at timestamptz NOT NULL, PRIMARY KEY(connection_id,item_id)
);
CREATE INDEX seller_knowledge_category_items ON seller_knowledge_items(connection_id,category_id,brand_id,last_seen_at DESC);
CREATE INDEX seller_knowledge_model_skus ON seller_knowledge_items USING gin(model_skus);
CREATE TABLE seller_knowledge_categories (
 connection_id uuid NOT NULL REFERENCES connections(id), category_id text NOT NULL,
 evidence_id uuid NOT NULL REFERENCES seller_knowledge_observations(id), connection_revision integer NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(connection_id,category_id)
);
