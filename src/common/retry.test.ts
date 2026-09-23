import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from './config.js';
import { backoffCeilingMs, fullJitterDelayMs, retryTransient } from './retry.js';

const NEVER_ABORTED = new AbortController().signal;

function transientError(): Error {
  return Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
}

function alwaysZero(): number {
  return 0;
}

describe('backoffCeilingMs', () => {
  it('doubles with every attempt', () => {
    assert.equal(backoffCeilingMs(0), config.RETRY_BASE_MS);
    assert.equal(backoffCeilingMs(1), config.RETRY_BASE_MS * 2);
    assert.equal(backoffCeilingMs(2), config.RETRY_BASE_MS * 4);
  });

  it('never exceeds the configured cap', () => {
    const farBeyondTheCap = 40;
    assert.equal(backoffCeilingMs(farBeyondTheCap), config.RETRY_CAP_MS);
  });
});

describe('fullJitterDelayMs', () => {
  it('can draw zero, so a retry is not forced to wait the whole ceiling', () => {
    assert.equal(fullJitterDelayMs(3, alwaysZero), 0);
  });

  it('never waits longer than the ceiling for that attempt', () => {
    const almostOne = 0.999_999;
    assert.ok(fullJitterDelayMs(2, () => almostOne) < backoffCeilingMs(2));
  });

  it('spreads two components retrying at the same attempt (SPEC §8)', () => {
    const first = fullJitterDelayMs(4, () => 0.1);
    const second = fullJitterDelayMs(4, () => 0.9);
    assert.notEqual(first, second);
  });
});

describe('retryTransient', () => {
  const options = {
    pipeline: 'test',
    signal: NEVER_ABORTED,
    random: alwaysZero,
    onRetry: () => undefined,
  };

  it('runs the work once when it succeeds', async () => {
    let calls = 0;
    const result = await retryTransient(() => {
      calls += 1;
      return Promise.resolve('ok');
    }, options);

    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    let calls = 0;
    const result = await retryTransient(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(transientError()) : Promise.resolve('ok');
    }, options);

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('does not retry a permanent failure', async () => {
    let calls = 0;
    await assert.rejects(
      retryTransient(() => {
        calls += 1;
        return Promise.reject(new Error('mapping conflict'));
      }, options),
      /mapping conflict/,
    );

    assert.equal(calls, 1);
  });

  it('gives up after the configured maximum attempts', async () => {
    let calls = 0;
    await assert.rejects(
      retryTransient(() => {
        calls += 1;
        return Promise.reject(transientError());
      }, options),
      /connection refused/,
    );

    assert.equal(calls, config.RETRY_MAX_ATTEMPTS);
  });
});
