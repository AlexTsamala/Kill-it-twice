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
  writeBatch(documents: readonly ProductDocument[]): Promise<BulkWriteResult>;
}
