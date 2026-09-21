-- Completed API writes may wait for per-item QC without monopolizing the shop.
-- This is a dispatch receipt, never a verification or publication approval.
CREATE FUNCTION production_pilot_can_wait_for_qc(operation uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH op AS (SELECT * FROM production_pilot_operations WHERE id=operation),
 media AS (
 SELECT 'cover:' || (source_payload->'document'->'cover'->>'importId') AS key FROM op
 UNION SELECT 'gallery:' || (m->>'importId') FROM op, jsonb_array_elements(COALESCE(source_payload->'document'->'gallery','[]'::jsonb)) m
 UNION SELECT 'description:' || (m->'image'->>'importId') FROM op, jsonb_array_elements(COALESCE(source_payload->'document'->'description','[]'::jsonb)) m WHERE m->>'type'='image'
 UNION SELECT 'variation:' || (m->'image'->>'importId') FROM op, jsonb_array_elements(COALESCE(source_payload->'document'->'models','[]'::jsonb)) m WHERE m->'image' IS NOT NULL AND m->'image'<>'null'::jsonb
 ), expected AS (
 SELECT 'media-' || (row_number() OVER ()-1)::text AS key FROM media
 UNION ALL SELECT 'create'
 UNION ALL SELECT 'variations' FROM op WHERE jsonb_array_length(source_payload->'document'->'tierNames')>0
 )
 SELECT EXISTS(SELECT 1 FROM op WHERE state='acknowledged' AND item_id ~ '^[1-9][0-9]*$'
 AND source_payload->'document'->'cover'->>'importId' IS NOT NULL
 AND jsonb_typeof(source_payload->'document'->'tierNames')='array'
 AND NOT EXISTS(SELECT 1 FROM media WHERE key IS NULL)
 AND NOT EXISTS(SELECT 1 FROM production_pilot_publications WHERE create_operation_id=operation)
 AND (SELECT count(*) FROM production_pilot_steps WHERE operation_id=operation)=(SELECT count(*) FROM expected)
 AND NOT EXISTS(SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM production_pilot_steps s WHERE s.operation_id=operation AND s.step_key=e.key AND s.state='acknowledged' AND s.receipt IS NOT NULL AND s.outcome_fingerprint IS NOT NULL))
 AND EXISTS(SELECT 1 FROM production_pilot_steps s WHERE s.operation_id=operation AND s.kind='create' AND s.step_key='create' AND s.payload->>'item_status'='UNLIST' AND s.receipt->'response'->>'item_id'=op.item_id)
 AND NOT EXISTS(SELECT 1 FROM production_pilot_steps s WHERE s.operation_id=operation AND s.kind='variations' AND s.payload->>'item_id' IS DISTINCT FROM op.item_id));
$$;
CREATE TABLE production_pilot_qc_wait_receipts (
 operation_id uuid PRIMARY KEY REFERENCES production_pilot_operations(id),
 operation_revision integer NOT NULL,
 source_fingerprint text NOT NULL,
 item_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER production_pilot_qc_wait_immutable BEFORE UPDATE OR DELETE ON production_pilot_qc_wait_receipts FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();

CREATE OR REPLACE FUNCTION guard_production_pilot_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR NOT (
  EXISTS(SELECT 1 FROM production_pilot_qc_wait_receipts r JOIN production_pilot_operations o ON o.id=r.operation_id
   WHERE o.id=OLD.operation_id AND o.owner_key=OLD.owner_key AND r.operation_revision=o.revision
    AND r.source_fingerprint=o.source_fingerprint AND r.item_id=o.item_id AND production_pilot_can_wait_for_qc(o.id)) OR
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
    AND ((o.source_payload->'batchAuthorization'->>'publicationMode'='hidden_for_review'
     AND o.source_payload->'batchAuthorization'->>'imageQcPolicy'='defer_image_qc' AND proof.execution_policy_id IS NULL)
     OR production_execution_policy_matches_operation(proof.execution_policy_id,o.id))
    AND EXISTS(SELECT 1 FROM production_pilot_steps step WHERE step.operation_id=o.id AND step.kind='create' AND step.state='acknowledged')
    AND NOT EXISTS(SELECT 1 FROM production_pilot_steps step WHERE step.operation_id=o.id AND step.state<>'acknowledged')
    AND NOT EXISTS(SELECT 1 FROM production_pilot_publications p WHERE p.create_operation_id=o.id)))
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_LANE_NEEDS_VERIFICATION'; END IF;
 RETURN OLD;
END $$;
