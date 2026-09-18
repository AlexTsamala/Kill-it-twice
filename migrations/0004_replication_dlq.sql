CREATE TABLE replication_dlq (
    id              BIGSERIAL PRIMARY KEY,
    pipeline        TEXT NOT NULL,
    source_ref      BIGINT NOT NULL,        -- outbox id or product id
    aggregate_id    BIGINT NOT NULL,
    event_type      TEXT,
    payload         JSONB NOT NULL,         -- complete, replayable without the source row
    error           TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    checkpoint_at   BIGINT NOT NULL,        -- where the pipeline was; needed to reconstruct context
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    replayed_at     TIMESTAMPTZ
);

-- Partial: replication_dlq_depth (SPEC §10) and the UI both read only unreplayed rows.
CREATE INDEX idx_dlq_unreplayed ON replication_dlq (id) WHERE replayed_at IS NULL;
