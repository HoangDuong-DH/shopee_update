ALTER TABLE connections
  ADD COLUMN display_name text CHECK (display_name IS NULL OR (length(btrim(display_name)) BETWEEN 1 AND 120)),
  ADD COLUMN name_revision integer NOT NULL DEFAULT 0 CHECK (name_revision >= 0);
