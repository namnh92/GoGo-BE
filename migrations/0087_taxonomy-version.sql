-- Additive. Rollback: retain this row across API rollbacks; dropping/recreating
-- it would reuse validators held by clients. Production rollback is roll-forward.
CREATE TABLE taxonomy_version (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO taxonomy_version (id) VALUES (1);
