CREATE TABLE source_files (
 id uuid PRIMARY KEY, sha256 text NOT NULL, filename text NOT NULL, kind text NOT NULL CHECK(kind IN ('xlsx','docx','image')),
 bytes bigint NOT NULL CHECK(bytes>0), status text NOT NULL DEFAULT 'queued', body jsonb, message text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 UNIQUE(sha256,kind)
);
CREATE TABLE products (product_key text PRIMARY KEY, latest_revision integer NOT NULL CHECK(latest_revision>0), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE product_revisions (product_key text NOT NULL REFERENCES products, revision integer NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(product_key,revision));
CREATE TABLE plan_revisions (
 plan_id uuid NOT NULL, revision integer NOT NULL, product_key text NOT NULL, source_revision integer NOT NULL,
 fingerprint text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(plan_id,revision), FOREIGN KEY(product_key,source_revision) REFERENCES product_revisions(product_key,revision)
);
CREATE FUNCTION reject_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_REVISION'; END $$;
CREATE TRIGGER immutable_product BEFORE UPDATE OR DELETE ON product_revisions FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TRIGGER immutable_plan BEFORE UPDATE OR DELETE ON plan_revisions FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
CREATE TABLE jobs (
 id uuid PRIMARY KEY, plan_id uuid NOT NULL, plan_revision integer NOT NULL, scope jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting_retry','waiting_input','waiting_external','unknown','verified','failed','cancelled')),
 paused boolean NOT NULL DEFAULT false, cancel_requested boolean NOT NULL DEFAULT false,
 lease_epoch integer NOT NULL DEFAULT 0, lease_until timestamptz, worker_id text,
 attempt_count integer NOT NULL DEFAULT 0, message text NOT NULL DEFAULT '',
 next_run_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_id,plan_revision), FOREIGN KEY(plan_id,plan_revision) REFERENCES plan_revisions(plan_id,revision)
);
CREATE INDEX jobs_due ON jobs(next_run_at) WHERE state IN ('queued','waiting_retry');
CREATE TABLE outbox (id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs, topic text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz);
CREATE TABLE job_events (id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs, state text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE stock_instructions (
 command_id text PRIMARY KEY, environment text NOT NULL, partner_id text NOT NULL, shop_id text NOT NULL, sku text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), quantity integer NOT NULL CHECK(quantity>=0), body jsonb NOT NULL,
 UNIQUE(environment,partner_id,shop_id,sku,revision)
);
CREATE TABLE connections (
 id uuid PRIMARY KEY, environment text NOT NULL CHECK(environment IN ('sandbox','production')), partner_id text NOT NULL,
 shop_id text NOT NULL, name text NOT NULL, region text NOT NULL DEFAULT 'VN', revision integer NOT NULL DEFAULT 1,
 capability_revision integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'disconnected', token_ciphertext text,
 partner_key_ciphertext text, expires_at timestamptz, capabilities jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(environment,partner_id,shop_id)
);
CREATE TABLE worker_heartbeats (id text PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now());
