import type { Database, DatabaseClient } from '../common/database.js';
import type { ProductEvent } from '../replication/sinks/event-sink.js';

export type ProjectionOutcome = 'applied' | 'duplicate' | 'superseded';

async function claimEventId(client: DatabaseClient, eventId: string): Promise<boolean> {
  const claimed = await client.query(
    'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING',
    [eventId],
  );
  return claimed.rowCount === 1;
}

/**
 * D4 + D6: the dedup insert and the projection write share one transaction, so a duplicate
 * delivery can never mark an event processed without its effect landing.
 */
export async function applyProductEvent(
  db: Database,
  event: ProductEvent,
): Promise<ProjectionOutcome> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    if (!(await claimEventId(client, event.eventId))) {
      await client.query('COMMIT');
      return 'duplicate';
    }

    const written =
      event.eventType === 'product.deleted'
        ? await client.query(
            'DELETE FROM product_projection WHERE id = $1 AND version <= $2',
            [event.data.id, event.version],
          )
        : await client.query(
            `INSERT INTO product_projection (id, version, name, price, status)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE
                SET version = excluded.version,
                    name    = excluded.name,
                    price   = excluded.price,
                    status  = excluded.status
              WHERE excluded.version > product_projection.version`,
            [event.data.id, event.version, event.data.name, event.data.price, event.data.status],
          );

    await client.query('COMMIT');
    return written.rowCount === 0 ? 'superseded' : 'applied';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
