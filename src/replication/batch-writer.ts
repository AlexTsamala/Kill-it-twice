import { TransientBatchError } from '../common/errors.js';
import { type RetryOptions, retryTransient } from '../common/retry.js';
import { routeBatchFailures } from './failure-routing.js';
import type { BulkWriteResult, ProductSink, SinkOperation } from './sinks/product-sink.js';

export async function writeBatchWithRetry(
  sink: ProductSink,
  operations: readonly SinkOperation[],
  options: RetryOptions,
): Promise<BulkWriteResult> {
  return retryTransient(async () => {
    const result = await sink.writeBatch(operations);
    const outcome = routeBatchFailures(result.failures);

    if (outcome.kind === 'retry') {
      throw new TransientBatchError(outcome.transientCount);
    }

    return result;
  }, options);
}
