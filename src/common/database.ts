import pg from 'pg';

import { config } from './config.js';

const { Pool } = pg;

export const DATABASE = Symbol('Database');

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createDatabasePool(): Database {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
  });
}
