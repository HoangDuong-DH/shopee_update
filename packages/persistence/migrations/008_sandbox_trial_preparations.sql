CREATE TABLE sandbox_trial_preparations (
  id uuid PRIMARY KEY,
  trial_key text NOT NULL UNIQUE,
  connection_id uuid NOT NULL REFERENCES connections(id),
  connection_revision integer NOT NULL CHECK (connection_revision > 0),
  input jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','prepared','blocked','unknown')),
  metadata jsonb,
  uploads jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest jsonb,
  fingerprint text,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  trial_id uuid REFERENCES sandbox_create_trials(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
