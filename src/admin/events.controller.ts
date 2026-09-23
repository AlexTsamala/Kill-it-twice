import { Controller, Inject, Sse, type MessageEvent } from '@nestjs/common';
import { Observable, catchError, concatMap, from, interval, map, mergeMap, of } from 'rxjs';
import { z } from 'zod';

import { DATABASE, type Database } from '../common/database.js';
import { logger } from '../common/logger.js';

const FEED_BATCH = 25;
const FEED_POLL_MS = 1000;
const PIPELINE = 'sse';

const eventRowSchema = z.object({
  id: z.coerce.number().int(),
  aggregate_id: z.coerce.number().int(),
  event_type: z.string(),
  version: z.number().int(),
  occurred_at: z.date(),
  processed_at: z.date().nullable(),
});

export type ChangeEvent = z.infer<typeof eventRowSchema>;

@Controller('admin/events')
export class EventsController {
  #lastSeen = 0;

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /**
   * Tails the outbox rather than the queue: the outbox is the durable record of what changed,
   * and reading it does not compete with the consumer for messages. A failed poll yields
   * nothing and the stream continues — an open browser tab must not be able to end the api.
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return interval(FEED_POLL_MS).pipe(
      concatMap(() =>
        from(this.#recentChanges()).pipe(
          catchError((error: unknown) => {
            logger.warn({ pipeline: PIPELINE, err: error }, 'change feed poll failed');
            return of([]);
          }),
        ),
      ),
      mergeMap((events) => from(events)),
      map((event) => ({ data: event }) satisfies MessageEvent),
    );
  }

  async #recentChanges(): Promise<ChangeEvent[]> {
    const { rows } = await this.database.query<Record<string, unknown>>(
      `SELECT id, aggregate_id, event_type, version, occurred_at, processed_at
         FROM replication_outbox
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [this.#lastSeen, FEED_BATCH],
    );

    const events = rows.map((row) => eventRowSchema.parse(row));
    this.#lastSeen = events.at(-1)?.id ?? this.#lastSeen;

    return events;
  }
}
