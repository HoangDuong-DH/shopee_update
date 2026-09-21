-- One explicit, immutable runtime choice for the remaining sources of a frozen preparation.
CREATE TABLE production_execution_policies (
 id uuid PRIMARY KEY,
 preparation_id uuid NOT NULL UNIQUE REFERENCES production_source_preparations(id),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL,
 body jsonb NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER production_execution_policy_immutable BEFORE UPDATE OR DELETE ON production_execution_policies
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
ALTER TABLE production_pilot_deferred_image_verifications ADD COLUMN execution_policy_id uuid REFERENCES production_execution_policies(id);

CREATE FUNCTION production_execution_policy_matches_operation(policy_id uuid, operation_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM production_execution_policies p
  JOIN production_pilot_operations o ON o.id=operation_id,
  LATERAL jsonb_array_elements(p.body->'batches') b,
  LATERAL jsonb_array_elements(b->'sources') s,
  LATERAL jsonb_array_elements(o.source_payload->'batchAuthorization'->'sources') a
  WHERE p.id=policy_id AND p.body->>'publicationMode'='hidden_for_review' AND p.body->>'imageQcPolicy'='defer_image_qc'
   AND p.body->'scope'->>'environment'='production' AND p.body->'scope'->>'partnerId'='2010476' AND p.body->'scope'->>'shopId'='1423724897'
   AND b->>'batchId'=o.source_payload->'batchAuthorization'->>'batchId'
   AND b->>'manifestSha256'=o.source_payload->'batchAuthorization'->>'manifestSha256'
   AND s->>'sourceIdentity'=o.source_identity AND (s->>'sourceRevision')::integer=o.source_revision
   AND a->>'sourceIdentity'=o.source_identity AND (a->>'sourceRevision')::integer=o.source_revision AND a->>'documentSha256'=s->>'documentSha256'
   AND ((s->>'operationId' IS NULL AND s->>'itemId' IS NULL AND s->>'sourceFingerprint' IS NULL)
    OR (s->>'operationId'=o.id::text AND s->>'itemId'=o.item_id AND s->>'sourceFingerprint'=o.source_fingerprint))
 );
$$;

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
    AND ((o.source_payload->'batchAuthorization'->>'publicationMode'='hidden_for_review'
     AND o.source_payload->'batchAuthorization'->>'imageQcPolicy'='defer_image_qc' AND proof.execution_policy_id IS NULL)
     OR production_execution_policy_matches_operation(proof.execution_policy_id,o.id))
    AND EXISTS(SELECT 1 FROM production_pilot_steps step WHERE step.operation_id=o.id AND step.kind='create' AND step.state='acknowledged')
    AND NOT EXISTS(SELECT 1 FROM production_pilot_steps step WHERE step.operation_id=o.id AND step.state<>'acknowledged')
    AND NOT EXISTS(SELECT 1 FROM production_pilot_publications p WHERE p.create_operation_id=o.id)))
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_LANE_NEEDS_VERIFICATION'; END IF;
 RETURN OLD;
END $$;
