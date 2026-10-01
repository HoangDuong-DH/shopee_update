ALTER TABLE source_files ADD COLUMN lease_epoch integer NOT NULL DEFAULT 0 CHECK(lease_epoch>=0);
ALTER TABLE source_files ADD COLUMN worker_id text CHECK(worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 200);
CREATE INDEX source_files_queued_claim ON source_files(created_at,id) WHERE status='queued';
CREATE INDEX source_files_expired_claim ON source_files(lease_until,created_at,id) WHERE status='running';

-- A rolled-back old worker may not finish a currently leased import by ID alone.
-- New completion clears the owner only after epoch/owner/expiry CAS succeeds.
CREATE FUNCTION guard_source_import_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='running' AND NEW.status IN ('ready','failed') AND
  (OLD.worker_id IS NULL OR NEW.worker_id IS NOT NULL OR NEW.lease_epoch<>OLD.lease_epoch
   OR NEW.lease_until IS NOT NULL OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
  THEN RAISE EXCEPTION 'IMPORT_CURRENT_LEASE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_import_completion_guard BEFORE UPDATE ON source_files
 FOR EACH ROW EXECUTE FUNCTION guard_source_import_completion();
