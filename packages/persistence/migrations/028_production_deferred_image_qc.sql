-- Explicit hidden-only image deferral. This is not a full create verification.
-- Original operation/source rows are not rewritten by a deferral receipt.
CREATE TABLE production_pilot_deferred_image_verifications (
 operation_id uuid PRIMARY KEY REFERENCES production_pilot_operations(id),
 operation_revision integer NOT NULL CHECK(operation_revision>0),
 item_id text NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 basis text NOT NULL CHECK(basis='image_qc_deferred_by_operator'),
 expected_core_fingerprint text NOT NULL CHECK(expected_core_fingerprint ~ '^[a-f0-9]{64}$'),
 readbacks jsonb NOT NULL CHECK(jsonb_typeof(readbacks)='array' AND jsonb_array_length(readbacks)=2),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER production_pilot_deferred_image_immutable BEFORE UPDATE OR DELETE ON production_pilot_deferred_image_verifications
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE OR REPLACE FUNCTION guard_production_pilot_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR NOT (
  EXISTS(SELECT 1 FROM production_pilot_operations o JOIN production_pilot_verifications v ON v.operation_id=o.id
   WHERE o.id=OLD.operation_id AND o.owner_key=OLD.owner_key AND o.state='verified' AND v.operation_revision=o.revision-1)
  OR EXISTS(SELECT 1 FROM production_pilot_operations o
   JOIN production_pilot_rejection_closures proof ON proof.operation_id=o.id
   JOIN production_pilot_steps step ON step.id=proof.rejected_step_id AND step.operation_id=o.id
   WHERE o.id=OLD.operation_id AND o.owner_key=OLD.owner_key AND o.state='rejected' AND o.item_id IS NULL
    AND proof.operation_revision=o.revision AND proof.source_fingerprint=o.source_fingerprint
    AND step.kind='create' AND step.state='rejected' AND step.path='/api/v2/product/add_item'
    AND step.fingerprint=proof.rejected_request_fingerprint AND step.outcome_fingerprint=proof.rejected_receipt_fingerprint
    AND step.payload=proof.rejected_request AND step.receipt=proof.rejected_receipt
    AND NOT EXISTS(SELECT 1 FROM production_pilot_steps other WHERE other.operation_id=o.id
     AND other.id<>step.id AND (other.kind<>'media' OR other.state<>'acknowledged')))
  OR EXISTS(SELECT 1 FROM production_pilot_operations o
   JOIN production_pilot_deferred_image_verifications proof ON proof.operation_id=o.id
   WHERE o.id=OLD.operation_id AND o.owner_key=OLD.owner_key AND o.state='acknowledged'
    AND proof.operation_revision=o.revision AND proof.source_fingerprint=o.source_fingerprint AND proof.item_id=o.item_id
    AND o.source_payload->'batchAuthorization'->>'publicationMode'='hidden_for_review'
    AND o.source_payload->'batchAuthorization'->>'imageQcPolicy'='defer_image_qc'
    AND EXISTS(SELECT 1 FROM production_pilot_steps step WHERE step.operation_id=o.id AND step.kind='create' AND step.state='acknowledged')
    AND NOT EXISTS(SELECT 1 FROM production_pilot_steps step WHERE step.operation_id=o.id AND step.state<>'acknowledged')
    AND NOT EXISTS(SELECT 1 FROM production_pilot_publications p WHERE p.create_operation_id=o.id)))
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_LANE_NEEDS_VERIFICATION'; END IF;
 RETURN OLD;
END $$;
