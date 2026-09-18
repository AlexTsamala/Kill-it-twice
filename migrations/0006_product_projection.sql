CREATE TABLE product_projection (
    id      BIGINT PRIMARY KEY,
    version INTEGER NOT NULL,
    name    TEXT NOT NULL,
    price   NUMERIC(12,2) NOT NULL,
    status  TEXT NOT NULL
);
