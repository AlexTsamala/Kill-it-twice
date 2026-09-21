import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { DATABASE, type Database, type DatabaseClient } from '../common/database.js';

const productRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  sku: z.string(),
  name: z.string(),
  price: z.coerce.number(),
  status: z.string(),
  version: z.number().int(),
});

type ProductRow = z.infer<typeof productRowSchema>;

export interface NewProduct {
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly status: string;
}

export interface ProductChanges {
  readonly name?: string;
  readonly price?: number;
  readonly status?: string;
}

async function insertOutboxRow(
  client: DatabaseClient,
  eventType: 'product.created' | 'product.updated' | 'product.deleted',
  product: ProductRow,
): Promise<void> {
  await client.query(
    `INSERT INTO replication_outbox
       (aggregate_type, aggregate_id, event_type, version, payload)
     VALUES ('product', $1, $2, $3, $4::jsonb)`,
    [
      product.id,
      eventType,
      product.version,
      JSON.stringify({
        id: product.id,
        sku: product.sku,
        name: product.name,
        price: product.price,
        status: product.status,
      }),
    ],
  );
}

@Injectable()
export class ProductsRepository {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async create(product: NewProduct): Promise<ProductRow> {
    return this.#inTransaction(async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO products (sku, name, description, price, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sku, name, price, status, version`,
        [product.sku, product.name, product.description, product.price, product.status],
      );

      const created = productRowSchema.parse(rows[0]);
      await insertOutboxRow(client, 'product.created', created);
      return created;
    });
  }

  async update(id: number, changes: ProductChanges): Promise<ProductRow | undefined> {
    return this.#inTransaction(async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE products
            SET name       = COALESCE($2, name),
                price      = COALESCE($3, price),
                status     = COALESCE($4, status),
                version    = version + 1,
                updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, sku, name, price, status, version`,
        [id, changes.name ?? null, changes.price ?? null, changes.status ?? null],
      );

      if (rows[0] === undefined) {
        return undefined;
      }

      const updated = productRowSchema.parse(rows[0]);
      await insertOutboxRow(client, 'product.updated', updated);
      return updated;
    });
  }

  async softDelete(id: number): Promise<ProductRow | undefined> {
    return this.#inTransaction(async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE products
            SET deleted_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, sku, name, price, status, version`,
        [id],
      );

      if (rows[0] === undefined) {
        return undefined;
      }

      const deleted = productRowSchema.parse(rows[0]);
      await insertOutboxRow(client, 'product.deleted', deleted);
      return deleted;
    });
  }

  // D1: the business write and its outbox row share one transaction. There is no code path
  // in this repository that writes one without the other.
  async #inTransaction<Result>(work: (client: DatabaseClient) => Promise<Result>): Promise<Result> {
    const client = await this.database.connect();

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
