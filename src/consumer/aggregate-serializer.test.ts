import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { AggregateSerializer } from './aggregate-serializer.js';

const PRODUCT = 1;
const OTHER_PRODUCT = 2;

interface Gate {
  readonly waitFor: Promise<void>;
  open(): void;
}

function closedGate(): Gate {
  const handlers: { open?: () => void } = {};
  const waitFor = new Promise<void>((resolve) => {
    handlers.open = resolve;
  });

  return {
    waitFor,
    open: () => handlers.open?.(),
  };
}

async function settle(serializer: AggregateSerializer): Promise<void> {
  while (serializer.pendingAggregates > 0) {
    await tick();
  }
}

describe('AggregateSerializer', () => {
  it('holds the next event for an aggregate until the previous one finishes', async () => {
    const serializer = new AggregateSerializer();
    const gate = closedGate();
    const applied: string[] = [];

    serializer.run(PRODUCT, async () => {
      applied.push('created:start');
      await gate.waitFor;
      applied.push('created:end');
    });
    serializer.run(PRODUCT, () => {
      applied.push('deleted');
      return Promise.resolve();
    });

    await tick();
    assert.deepEqual(applied, ['created:start'], 'the delete ran before its create finished');

    gate.open();
    await settle(serializer);
    assert.deepEqual(applied, ['created:start', 'created:end', 'deleted']);
  });

  it('does not let a delete resurrect the row it was meant to remove', async () => {
    const serializer = new AggregateSerializer();
    const gate = closedGate();
    let rowExists = false;

    // The projection's delete removes a row or does nothing; it cannot subtract from a row
    // that is not there. Run out of order the delete is a no-op and the create that follows
    // puts the product back, which is how the projection reached 2,000,002.
    serializer.run(PRODUCT, async () => {
      await gate.waitFor;
      rowExists = true;
    });
    serializer.run(PRODUCT, () => {
      rowExists = false;
      return Promise.resolve();
    });

    gate.open();
    await settle(serializer);
    assert.equal(rowExists, false, 'the deleted product came back');
  });

  it('does not make one aggregate wait for another', async () => {
    const serializer = new AggregateSerializer();
    const gate = closedGate();
    const started: number[] = [];

    serializer.run(PRODUCT, async () => {
      started.push(PRODUCT);
      await gate.waitFor;
    });
    serializer.run(OTHER_PRODUCT, async () => {
      started.push(OTHER_PRODUCT);
      await gate.waitFor;
    });

    await tick();
    assert.deepEqual(started, [PRODUCT, OTHER_PRODUCT], 'serialised across aggregates');

    gate.open();
    await settle(serializer);
  });

  it('stops tracking an aggregate once its work is done', async () => {
    const serializer = new AggregateSerializer();

    serializer.run(PRODUCT, () => Promise.resolve());
    await settle(serializer);

    assert.equal(serializer.pendingAggregates, 0);
  });

  it('keeps the chain usable after work throws', async () => {
    const serializer = new AggregateSerializer();
    const applied: string[] = [];

    serializer.run(PRODUCT, () => Promise.reject(new Error('projection failed')));
    await settle(serializer);

    serializer.run(PRODUCT, () => {
      applied.push('next event');
      return Promise.resolve();
    });
    await settle(serializer);

    assert.deepEqual(applied, ['next event']);
  });
});
