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
    const next = previous.then(work);

    this.#chains.set(aggregateId, next);

    void next.finally(() => {
      if (this.#chains.get(aggregateId) === next) {
        this.#chains.delete(aggregateId);
      }
    });
  }
}
