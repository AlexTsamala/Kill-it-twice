CREATE TABLE replication_outbox (
    id             BIGSERIAL PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id   BIGINT NOT NULL,
    event_type     TEXT NOT NULL,          -- product.created | product.updated | product.deleted
    version        INTEGER NOT NULL,
    payload        JSONB NOT NULL,         -- full row snapshot at change time
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at   TIMESTAMPTZ
);

-- Partial: only unprocessed rows are ever read, so the index stays small as the backlog grows.
CREATE INDEX idx_outbox_unprocessed ON replication_outbox (id) WHERE processed_at IS NULL;
