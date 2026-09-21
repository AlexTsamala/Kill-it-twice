import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOutboxEvent, buildSnapshotEvent } from './product-event.factory.js';
import type { ProductDocument } from './sinks/product-sink.js';
import type { OutboxRow } from './outbox.js';

const document: ProductDocument = {
  id: 42,
  sku: 'SKU-00000041',
  name: 'Seamless Ceramic Stool',
  description: 'irrelevant to the event payload',
  price: 103.12,
  status: 'draft',
  version: 4,
  updated_at: '2026-09-20T08:00:00.000Z',
};

const outboxRow: OutboxRow = {
  id: 843210,
  aggregate_id: 42,
  event_type: 'product.updated',
  version: 7,
  occurred_at: new Date('2026-09-20T08:00:00.000Z'),
  payload: {
    id: 42,
    sku: 'SKU-00000041',
    name: 'Renamed Stool',
    price: 120.5,
    status: 'active',
  },
};

describe('buildSnapshotEvent', () => {
  it('derives eventId from the product id, never randomly (AGENTS.md §8)', () => {
    assert.equal(buildSnapshotEvent(document).eventId, 'backfill-42');
  });

  it('produces an identical event on every call, so retries dedup correctly', () => {
    assert.deepEqual(buildSnapshotEvent(document), buildSnapshotEvent(document));
  });

  it('marks backfill rows as a snapshot, not as something that just happened (D6)', () => {
    assert.equal(buildSnapshotEvent(document).eventType, 'product.snapshot');
  });

  it('carries the source version so the projection guard can order it', () => {
    assert.equal(buildSnapshotEvent(document).version, 4);
  });

  it('omits description — the event payload is the §7 shape, not the ES document', () => {
    assert.deepEqual(buildSnapshotEvent(document).data, {
      id: 42,
      sku: 'SKU-00000041',
      name: 'Seamless Ceramic Stool',
      price: 103.12,
      status: 'draft',
    });
  });
});

describe('buildOutboxEvent', () => {
  it('derives eventId from the outbox row id, so it is stable across retries', () => {
    assert.equal(buildOutboxEvent(outboxRow).eventId, 'outbox-843210');
  });

  it('carries the event type recorded at change time', () => {
    assert.equal(buildOutboxEvent(outboxRow).eventType, 'product.updated');
  });

  it('uses the payload snapshot, not current state', () => {
    assert.equal(buildOutboxEvent(outboxRow).data.name, 'Renamed Stool');
  });
});

describe('event id namespaces', () => {
  it('keeps backfill and incremental ids distinct for the same aggregate (SPEC §7)', () => {
    const snapshot = buildSnapshotEvent(document);
    const change = buildOutboxEvent({ ...outboxRow, id: 42 });

    assert.equal(snapshot.aggregateId, change.aggregateId);
    assert.notEqual(
      snapshot.eventId,
      change.eventId,
      'a snapshot must not dedup away a later update of the same row',
    );
  });
});
