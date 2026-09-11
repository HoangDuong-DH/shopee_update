CREATE TABLE work_orders (
 id uuid PRIMARY KEY,
 latest_revision integer NOT NULL CHECK(latest_revision > 0),
 target_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_order_revisions (
 order_id uuid NOT NULL REFERENCES work_orders,
 revision integer NOT NULL CHECK(revision > 0),
 product_key text NOT NULL,
 source_revision integer NOT NULL,
 connection_id uuid REFERENCES connections,
 config jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,revision),
 FOREIGN KEY(product_key,source_revision) REFERENCES product_revisions(product_key,revision)
);
CREATE TRIGGER immutable_work_order BEFORE UPDATE OR DELETE ON work_order_revisions
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();

CREATE TABLE handoff_receipts (
 preview_fingerprint text PRIMARY KEY,
 product_key text NOT NULL,
 revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(product_key,revision) REFERENCES product_revisions(product_key,revision)
);
