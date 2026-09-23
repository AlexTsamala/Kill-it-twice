import type { EventSink } from './event-sink.js';
import type { ProductSink } from './product-sink.js';

export const SINKS = Symbol('Sinks');

/** The pair every worker writes to (D6). Grouping them keeps a worker's dependencies at the
 *  three the code actually reasons about: where it reads, where it writes, what it counts. */
export interface Sinks {
  readonly product: ProductSink;
  readonly event: EventSink;
}
