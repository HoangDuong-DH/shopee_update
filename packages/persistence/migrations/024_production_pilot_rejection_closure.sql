-- A definitive rejected create stays rejected forever; a separate immutable proof can close its lane.
CREATE TABLE production_pilot_rejection_closures (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE REFERENCES production_pilot_operations(id),
 operation_revision integer NOT NULL CHECK(operation_revision>0),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 rejected_step_id uuid NOT NULL UNIQUE REFERENCES production_pilot_steps(id),
 rejected_request_fingerprint text NOT NULL CHECK(rejected_request_fingerprint ~ '^[a-f0-9]{64}$'),
 rejected_receipt_fingerprint text NOT NULL CHECK(rejected_receipt_fingerprint ~ '^[a-f0-9]{64}$'),
 rejected_request jsonb NOT NULL, rejected_receipt jsonb NOT NULL,
 connection_revision integer NOT NULL CHECK(connection_revision>0),
 scans jsonb NOT NULL CHECK(jsonb_array_length(scans)=2),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint ~ '^[a-f0-9]{64}$'),
 closed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER production_pilot_rejection_closure_immutable BEFORE UPDATE OR DELETE ON production_pilot_rejection_closures
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
ALTER TABLE production_pilot_operations ADD COLUMN supersedes_operation_id uuid UNIQUE REFERENCES production_pilot_operations(id);
CREATE FUNCTION guard_production_pilot_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.supersedes_operation_id IS DISTINCT FROM OLD.supersedes_operation_id
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_SUPERSESSION_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' AND NEW.supersedes_operation_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM production_pilot_operations predecessor JOIN production_pilot_rejection_closures proof ON proof.operation_id=predecessor.id
  WHERE predecessor.id=NEW.supersedes_operation_id AND predecessor.owner_key=NEW.owner_key AND predecessor.connection_id=NEW.connection_id
   AND predecessor.source_identity=NEW.source_identity AND predecessor.source_revision<NEW.source_revision
   AND predecessor.state='rejected' AND predecessor.item_id IS NULL AND proof.operation_revision=predecessor.revision
   AND proof.source_fingerprint=predecessor.source_fingerprint
   AND NEW.source_payload->>'supersedesOperationId'=predecessor.id::text)
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_SUPERSESSION_UNPROVEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_pilot_supersession_guard BEFORE INSERT OR UPDATE ON production_pilot_operations
 FOR EACH ROW EXECUTE FUNCTION guard_production_pilot_supersession();
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
     AND other.id<>step.id AND (other.kind<>'media' OR other.state<>'acknowledged'))))
 THEN RAISE EXCEPTION 'PRODUCTION_PILOT_LANE_NEEDS_VERIFICATION'; END IF;
 RETURN OLD;
END $$;
-- The independent publication lane guard from migration 023 remains in force.
