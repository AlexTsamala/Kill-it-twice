import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { routeBatchFailures } from './failure-routing.js';
import type { BulkItemFailure } from './sinks/product-sink.js';

function failure(id: number, errorClass: 'transient' | 'permanent'): BulkItemFailure {
  return { position: id - 1, id, errorClass, reason: `${errorClass} failure on ${String(id)}` };
}

describe('routeBatchFailures', () => {
  it('completes a batch that had no failures', () => {
    assert.deepEqual(routeBatchFailures([]), { kind: 'complete' });
  });

  it('dead-letters a batch whose failures are all permanent (D5)', () => {
    const failures = [failure(1, 'permanent'), failure(2, 'permanent')];

    assert.deepEqual(routeBatchFailures(failures), { kind: 'dead-letter', failures });
  });

  it('retries the batch when any failure is transient, so the checkpoint stays (D5)', () => {
    const outcome = routeBatchFailures([failure(1, 'transient')]);

    assert.equal(outcome.kind, 'retry');
  });

  it('retries a mixed batch rather than dead-lettering the permanent items early', () => {
    const outcome = routeBatchFailures([failure(1, 'permanent'), failure(2, 'transient')]);

    assert.equal(outcome.kind, 'retry');
  });

  it('never dead-letters an item that could still succeed on a later attempt', () => {
    const outcome = routeBatchFailures([failure(1, 'transient'), failure(2, 'permanent')]);

    assert.notEqual(outcome.kind, 'dead-letter');
  });
});
