-- SPEC §5. BIGSERIAL, not UUID: keyset pagination needs a cheaply-ordered cursor.
-- version is the external version Elasticsearch is given (D3).
-- Deletes are soft so the backfill still sees current state.

CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    sku         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    price       NUMERIC(12,2) NOT NULL,
    status      TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
