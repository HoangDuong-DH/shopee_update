-- A plan records user-selected destinations, independent of the archive and
-- current OAuth state. It never authorizes a marketplace write by itself.
CREATE TABLE shop_listing_copy_plans (
  archive_id uuid PRIMARY KEY REFERENCES shop_listing_archives(id),
  targets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(targets)='array'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
