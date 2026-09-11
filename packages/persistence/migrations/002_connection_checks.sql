CREATE TABLE connection_checks (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections, connection_revision integer NOT NULL,
 endpoint text NOT NULL, request_id text, checked_at timestamptz NOT NULL DEFAULT now(), result jsonb NOT NULL
);
