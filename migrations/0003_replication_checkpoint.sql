CREATE TABLE replication_checkpoint (
    pipeline          TEXT PRIMARY KEY,     -- 'backfill' | 'incremental'
    last_processed_id BIGINT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'idle',
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);


INSERT INTO replication_checkpoint (pipeline)
VALUES ('backfill'), ('incremental')
ON CONFLICT (pipeline) DO NOTHING;
