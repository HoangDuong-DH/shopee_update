CREATE TABLE production_authorization_attempts (
 id uuid PRIMARY KEY,
 partner_id text NOT NULL CHECK(partner_id='2010476'),
 shop_id text NOT NULL CHECK(shop_id='1423724897'),
 expected_revision integer NOT NULL CHECK(expected_revision>=0),
 state_hash text NOT NULL UNIQUE,
 browser_hash text NOT NULL,
 key_ciphertext text,
 status text NOT NULL CHECK(status IN ('pending','exchanging','verified','rejected','unknown','expired')),
 reason text,
 connection_id uuid REFERENCES connections,
 connection_revision integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_authorization_expiry ON production_authorization_attempts(status,expires_at);
