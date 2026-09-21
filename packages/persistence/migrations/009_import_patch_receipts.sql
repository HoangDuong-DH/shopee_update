CREATE TABLE import_patch_receipts (
 id uuid PRIMARY KEY,
 name text NOT NULL,
 semantic_fingerprint text NOT NULL UNIQUE,
 body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_import_patch_receipt BEFORE UPDATE OR DELETE ON import_patch_receipts
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TABLE import_patch_targets (
 receipt_id uuid NOT NULL REFERENCES import_patch_receipts,
 work_order_id uuid NOT NULL,
 work_order_revision integer NOT NULL,
 PRIMARY KEY(receipt_id,work_order_id),
 FOREIGN KEY(work_order_id,work_order_revision) REFERENCES work_order_revisions(order_id,revision)
);
CREATE TRIGGER immutable_import_patch_target BEFORE UPDATE OR DELETE ON import_patch_targets
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TABLE import_patch_save_requests (
 id uuid PRIMARY KEY,
 request_fingerprint text NOT NULL,
 receipt_id uuid NOT NULL REFERENCES import_patch_receipts
);
CREATE TRIGGER immutable_import_patch_request BEFORE UPDATE OR DELETE ON import_patch_save_requests
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
