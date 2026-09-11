CREATE TABLE assistant_reviews (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL,
 plan_id uuid NOT NULL,
 plan_revision integer NOT NULL,
 scope jsonb NOT NULL,
 query text NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','stopped')),
 code text NOT NULL DEFAULT '',
 events jsonb NOT NULL DEFAULT '[]',
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz NOT NULL,
 finished_at timestamptz,
 FOREIGN KEY(plan_id,plan_revision) REFERENCES plan_revisions(plan_id,revision)
);
CREATE INDEX assistant_reviews_recent ON assistant_reviews(created_at DESC);
