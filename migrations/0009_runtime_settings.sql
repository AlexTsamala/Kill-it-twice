-- Control-plane state the api writes and the workers read. Env still validates at startup and
-- supplies every default (AGENTS.md §4); a row here is an explicit, visible override rather
-- than a second source of configuration.
CREATE TABLE runtime_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
