import type { ErrorClass } from '../../common/errors.js';

export const PRODUCT_SINK = Symbol('ProductSink');

export interface ProductDocument {
  readonly id: number;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly status: string;
  readonly version: number;
  readonly updated_at: string;
}

export type SinkOperation =
  | { readonly kind: 'index'; readonly document: ProductDocument }
  | { readonly kind: 'delete'; readonly id: number; readonly version: number }
  | { readonly kind: 'poison'; readonly id: number };

/** Far above any seeded product id, so a poison record is rejected on its mapping (SPEC §6)
 *  rather than colliding with a real document and returning a version conflict instead. */
export const POISON_ID_BASE = 9_000_000_000;

export interface BulkItemFailure {
  /** Index into the operations passed to `writeBatch`, so the caller can recover which of
   *  its own records failed without matching on the Elasticsearch `_id`. */
  readonly position: number;
  readonly id: number;
  readonly errorClass: ErrorClass;
  readonly reason: string;
}

export interface BulkWriteResult {
  readonly appliedCount: number;
  readonly versionConflictCount: number;
  readonly failures: readonly BulkItemFailure[];
}

export interface ProductSink {
  writeBatch(operations: readonly SinkOperation[]): Promise<BulkWriteResult>;
}

export function indexOperation(document: ProductDocument): SinkOperation {
  return { kind: 'index', document };
}

export function deleteOperation(id: number, version: number): SinkOperation {
  return { kind: 'delete', id, version };
}

export function poisonOperation(poisonRowId: number): SinkOperation {
  return { kind: 'poison', id: POISON_ID_BASE + poisonRowId };
}

export const UNMAPPED_FIELD = 'simulated_unmapped_field';

export function poisonDocumentBody(id: number): Record<string, unknown> {
  return {
    id,
    sku: `POISON-${String(id)}`,
    name: 'simulated poison record',
    description: null,
    price: 0,
    status: 'active',
    version: 1,
    updated_at: new Date().toISOString(),
    [UNMAPPED_FIELD]: 'rejected by dynamic: strict',
  };
}
