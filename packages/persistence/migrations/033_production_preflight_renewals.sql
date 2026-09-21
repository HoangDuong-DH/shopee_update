-- New observations may renew an untouched reservation; original intent remains immutable.
CREATE TABLE production_pilot_preflight_renewals (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>0),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 source_payload jsonb NOT NULL,
 expected_projection jsonb NOT NULL,
 receipt_fingerprint text NOT NULL CHECK(receipt_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(operation_id,ordinal)
);
CREATE TRIGGER production_pilot_preflight_renewal_immutable BEFORE UPDATE OR DELETE ON production_pilot_preflight_renewals
 FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
