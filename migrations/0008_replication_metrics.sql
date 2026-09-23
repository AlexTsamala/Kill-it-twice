CREATE TABLE replication_metrics (
    name       TEXT NOT NULL,
    labels     TEXT NOT NULL,
    value      DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (name, labels)
);
