-- Enrollment is independent of the existing, bounded production writer allowlist.
ALTER TABLE production_authorization_attempts DROP CONSTRAINT production_authorization_attempts_partner_id_check;
ALTER TABLE production_authorization_attempts DROP CONSTRAINT production_authorization_attempts_shop_id_check;
ALTER TABLE production_authorization_attempts ADD CHECK (partner_id ~ '^[1-9][0-9]{0,15}$');
ALTER TABLE production_authorization_attempts ADD CHECK (shop_id ~ '^[1-9][0-9]{0,15}$');
ALTER TABLE connections ADD COLUMN auto_refresh boolean NOT NULL DEFAULT false;
ALTER TABLE connections ADD COLUMN refresh_status text NOT NULL DEFAULT 'idle'
 CHECK (refresh_status IN ('idle','waiting','running','healthy','reauth_required','unknown'));
ALTER TABLE connections ADD COLUMN refresh_reason text;
ALTER TABLE connections ADD COLUMN next_refresh_at timestamptz;
ALTER TABLE connections ADD COLUMN health_checked_at timestamptz;
-- Existing production enrollment was explicitly authorized for maintenance by the owner.
UPDATE connections SET auto_refresh=true WHERE environment='production' AND token_ciphertext IS NOT NULL;
CREATE INDEX connection_refresh_due ON connections(next_refresh_at) WHERE auto_refresh AND environment='production';
