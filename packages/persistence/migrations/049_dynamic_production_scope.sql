-- Broaden only shop identity. Existing journal transitions, source proofs and
-- lane release requirements remain unchanged; historical rows are not rewritten.
ALTER TABLE production_pilot_operations DROP CONSTRAINT production_pilot_operations_owner_key_check;
ALTER TABLE production_pilot_operations ADD CONSTRAINT production_pilot_operations_owner_key_check
 CHECK(owner_key ~ '^production:[1-9][0-9]{0,15}:[1-9][0-9]{0,15}$');
ALTER TABLE production_pilot_lanes DROP CONSTRAINT production_pilot_lanes_owner_key_check;
ALTER TABLE production_pilot_lanes ADD CONSTRAINT production_pilot_lanes_owner_key_check
 CHECK(owner_key ~ '^production:[1-9][0-9]{0,15}:[1-9][0-9]{0,15}$');
ALTER TABLE production_pilot_publications DROP CONSTRAINT production_pilot_publications_owner_key_check;
ALTER TABLE production_pilot_publications ADD CONSTRAINT production_pilot_publications_owner_key_check
 CHECK(owner_key ~ '^production:[1-9][0-9]{0,15}:[1-9][0-9]{0,15}$');

CREATE FUNCTION production_owner_for_connection(connection uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN environment='production'
  AND partner_id ~ '^[1-9][0-9]{0,15}$' AND shop_id ~ '^[1-9][0-9]{0,15}$'
  THEN CASE WHEN partner_id::numeric<=9007199254740991 AND shop_id::numeric<=9007199254740991
   THEN environment || ':' || partner_id || ':' || shop_id END END
 FROM connections WHERE id=connection;
$$;
CREATE FUNCTION production_scope_matches_connection(scope jsonb, connection uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT jsonb_typeof(scope)='object' AND scope->>'environment'=environment
  AND scope->>'partnerId'=partner_id AND scope->>'shopId'=shop_id
  AND production_owner_for_connection(id) IS NOT NULL FROM connections WHERE id=connection),false);
$$;
CREATE FUNCTION guard_production_scope_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='production_pilot_operations' THEN
  IF NEW.owner_key IS DISTINCT FROM production_owner_for_connection(NEW.connection_id)
   THEN RAISE EXCEPTION 'PRODUCTION_SCOPE_CONNECTION_MISMATCH'; END IF;
  -- Older immutable payloads can omit a scope object. Any declared scope must
  -- match the actual connection; application source-contract guards still apply.
  IF (NEW.source_payload ? 'scope' AND production_scope_matches_connection(NEW.source_payload->'scope',NEW.connection_id) IS NOT TRUE)
   OR ((NEW.source_payload->'metadata') ?| ARRAY['environment','partnerId','shopId']
    AND production_scope_matches_connection(NEW.source_payload->'metadata',NEW.connection_id) IS NOT TRUE)
   THEN RAISE EXCEPTION 'PRODUCTION_SCOPE_PAYLOAD_MISMATCH'; END IF;
 ELSIF TG_TABLE_NAME='production_pilot_lanes' THEN
  IF NOT EXISTS(SELECT 1 FROM production_pilot_operations o WHERE o.id=NEW.operation_id
   AND o.owner_key=NEW.owner_key AND o.owner_key=production_owner_for_connection(o.connection_id))
   THEN RAISE EXCEPTION 'PRODUCTION_SCOPE_LANE_MISMATCH'; END IF;
 ELSE
  IF NEW.owner_key IS DISTINCT FROM production_owner_for_connection(NEW.connection_id)
   OR NOT EXISTS(SELECT 1 FROM production_pilot_operations o
    JOIN production_pilot_verifications v ON v.id=NEW.create_verification_id AND v.operation_id=o.id
    WHERE o.id=NEW.create_operation_id AND o.owner_key=NEW.owner_key AND o.connection_id=NEW.connection_id
     AND o.source_identity=NEW.source_identity AND o.source_revision=NEW.source_revision
     AND o.source_fingerprint=NEW.source_fingerprint AND o.item_id=NEW.item_id AND v.item_id=NEW.item_id)
   THEN RAISE EXCEPTION 'PRODUCTION_SCOPE_PUBLICATION_MISMATCH'; END IF;
  IF NEW.preflight_metadata ?| ARRAY['environment','partnerId','shopId']
   AND production_scope_matches_connection(NEW.preflight_metadata,NEW.connection_id) IS NOT TRUE
   THEN RAISE EXCEPTION 'PRODUCTION_SCOPE_PAYLOAD_MISMATCH'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_scope_operation_insert BEFORE INSERT ON production_pilot_operations
 FOR EACH ROW EXECUTE FUNCTION guard_production_scope_insert();
CREATE TRIGGER production_scope_lane_insert BEFORE INSERT ON production_pilot_lanes
 FOR EACH ROW EXECUTE FUNCTION guard_production_scope_insert();
CREATE TRIGGER production_scope_publication_insert BEFORE INSERT ON production_pilot_publications
 FOR EACH ROW EXECUTE FUNCTION guard_production_scope_insert();

CREATE OR REPLACE FUNCTION production_execution_policy_matches_operation(policy_id uuid, operation_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM production_execution_policies p
  JOIN production_pilot_operations o ON o.id=operation_id
  JOIN connections c ON c.id=o.connection_id,
  LATERAL jsonb_array_elements(p.body->'batches') b,
  LATERAL jsonb_array_elements(b->'sources') s,
  LATERAL jsonb_array_elements(o.source_payload->'batchAuthorization'->'sources') a
  WHERE p.id=policy_id AND p.body->>'publicationMode'='hidden_for_review' AND p.body->>'imageQcPolicy'='defer_image_qc'
   AND c.environment='production' AND o.owner_key=production_owner_for_connection(c.id)
   AND production_scope_matches_connection(p.body->'scope',c.id) IS TRUE
   AND b->>'batchId'=o.source_payload->'batchAuthorization'->>'batchId'
   AND b->>'manifestSha256'=o.source_payload->'batchAuthorization'->>'manifestSha256'
   AND s->>'sourceIdentity'=o.source_identity AND (s->>'sourceRevision')::integer=o.source_revision
   AND a->>'sourceIdentity'=o.source_identity AND (a->>'sourceRevision')::integer=o.source_revision AND a->>'documentSha256'=s->>'documentSha256'
   AND ((s->>'operationId' IS NULL AND s->>'itemId' IS NULL AND s->>'sourceFingerprint' IS NULL)
    OR (s->>'operationId'=o.id::text AND s->>'itemId'=o.item_id AND s->>'sourceFingerprint'=o.source_fingerprint))
 );
$$;
