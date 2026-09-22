import type { BulkItemFailure } from './sinks/product-sink.js';

export type BatchOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'retry'; readonly transientCount: number }
  | { readonly kind: 'dead-letter'; readonly failures: readonly BulkItemFailure[] };

export function routeBatchFailures(failures: readonly BulkItemFailure[]): BatchOutcome {
  if (failures.length === 0) {
    return { kind: 'complete' };
  }

  const transientCount = failures.filter((item) => item.errorClass === 'transient').length;
  if (transientCount > 0) {
    return { kind: 'retry', transientCount };
  }

  return { kind: 'dead-letter', failures };
}
