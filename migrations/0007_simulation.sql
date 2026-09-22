-- The simulation controls live in Postgres because the api role sets them and the worker
-- role reads them: separate containers with no channel between them but the database.
CREATE TABLE simulation_sink_state (
    sink       TEXT PRIMARY KEY,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO simulation_sink_state (sink, enabled)
VALUES ('elasticsearch', true), ('rabbitmq', true)
ON CONFLICT (sink) DO NOTHING;

-- G4 injects records Elasticsearch must reject per-item. A poison row cannot live in
-- products, whose NUMERIC price column would reject the bad value first.
CREATE TABLE simulation_poison (
    id          BIGSERIAL PRIMARY KEY,
    injected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ
);

CREATE INDEX idx_simulation_poison_pending ON simulation_poison (id) WHERE consumed_at IS NULL;
