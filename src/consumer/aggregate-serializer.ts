import { logger } from '../common/logger.js';

/**
 * Serialises work per aggregate id while leaving different aggregates concurrent.
 *
 * A single queue delivers in order, but prefetch lets handlers overlap — so `product.created`
 * and `product.deleted` for one row can interleave and the delete can run against a row that
 * does not exist yet. The version guard cannot catch that: once a row is gone there is no
 * version left to compare against.
 */
export class AggregateSerializer {
  readonly #chains = new Map<number, Promise<void>>();

  get pendingAggregates(): number {
    return this.#chains.size;
  }

  run(aggregateId: number, work: () => Promise<void>): void {
    const previous = this.#chains.get(aggregateId) ?? Promise.resolve();

    // A rejection here would reach the process as an unhandled rejection and take the
    // consumer down with it, and every later event for this aggregate would be skipped.
    const link = previous.then(work).catch((error: unknown) => {
      logger.error({ aggregateId, err: error }, 'handler escaped its own error handling');
    });

    this.#chains.set(aggregateId, link);

    void link.finally(() => {
      if (this.#chains.get(aggregateId) === link) {
        this.#chains.delete(aggregateId);
      }
    });
  }
}
