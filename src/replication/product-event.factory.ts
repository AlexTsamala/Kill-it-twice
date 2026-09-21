import type { OutboxRow } from './outbox.js';
import type { ProductEvent } from './sinks/event-sink.js';
import type { ProductDocument } from './sinks/product-sink.js';

export function buildSnapshotEvent(document: ProductDocument): ProductEvent {
  return {
    eventId: `backfill-${String(document.id)}`,
    eventType: 'product.snapshot',
    aggregateId: document.id,
    version: document.version,
    occurredAt: document.updated_at,
    data: {
      id: document.id,
      sku: document.sku,
      name: document.name,
      price: document.price,
      status: document.status,
    },
  };
}

export function buildOutboxEvent(row: OutboxRow): ProductEvent {
  return {
    eventId: `outbox-${String(row.id)}`,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    version: row.version,
    occurredAt: row.occurred_at.toISOString(),
    data: row.payload,
  };
}
