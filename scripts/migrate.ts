import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';
import { z } from 'zod';

import { config } from '../src/common/config.js';
import { logger } from '../src/common/logger.js';

const { Client } = pg;
type Client = pg.Client;

const MIGRATION_LOCK_KEY = 8734129;

const ledgerRowSchema = z.object({
  filename: z.string().min(1),
  checksum: z.string().min(1),
});

interface PendingMigration {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function listMigrationFiles(directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  if (files.length === 0) {
    throw new Error(`No .sql files found in ${directory}`);
  }

  return files;
}

async function createLedgerIfMissing(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readLedger(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<Record<string, unknown>>(
    'SELECT filename, checksum FROM schema_migrations',
  );

  const entries = rows.map((row): [string, string] => {
    const { filename, checksum } = ledgerRowSchema.parse(row);
    return [filename, checksum];
  });

  return new Map(entries);
}

function rejectIfAlreadyAppliedFileChanged(
  filename: string,
  appliedChecksum: string,
  currentChecksum: string,
): void {
  if (appliedChecksum !== currentChecksum) {
    throw new Error(
      `${filename} changed after it was applied. Migrations are forward-only ` +
        `(AGENTS.md §3): add a new numbered file rather than editing this one.`,
    );
  }
}

async function applyMigration(client: Client, migration: PendingMigration): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
      migration.filename,
      migration.checksum,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function migrate(): Promise<void> {
  const directory = join(process.cwd(), 'migrations');
  const files = await listMigrationFiles(directory);

  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await createLedgerIfMissing(client);

    const ledger = await readLedger(client);
    let appliedThisRun = 0;

    for (const filename of files) {
      const sql = await readFile(join(directory, filename), 'utf8');
      const checksum = checksumOf(sql);
      const appliedChecksum = ledger.get(filename);

      if (appliedChecksum !== undefined) {
        rejectIfAlreadyAppliedFileChanged(filename, appliedChecksum, checksum);
        continue;
      }

      await applyMigration(client, { filename, sql, checksum });
      appliedThisRun += 1;
      logger.info({ filename }, 'migration applied');
    }

    logger.info({ appliedThisRun, totalMigrations: files.length }, 'migrations up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    await client.end();
  }
}

try {
  await migrate();
} catch (error) {
  logger.error({ err: error }, 'migration failed');
  process.exit(1);
}
