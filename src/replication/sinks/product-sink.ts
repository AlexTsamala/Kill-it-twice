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
  | { readonly kind: 'delete'; readonly id: number; readonly version: number };

export interface BulkItemFailure {
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
