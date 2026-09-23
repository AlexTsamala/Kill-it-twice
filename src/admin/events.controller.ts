import { Controller, Inject, Sse, type MessageEvent } from '@nestjs/common';
import { Observable, from, mergeMap, of } from 'rxjs';
import { z } from 'zod';

import { DATABASE, type Database } from '../common/database.js';
import { readRuntimeSettings } from '../common/runtime-settings.js';

const FEED_BATCH = 25;

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

  /** Tails the outbox rather than the queue: the outbox is the durable record of what
   *  changed, and reading it does not compete with the consumer for messages. */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return new Observable<void>((subscriber) => {
      let cancelled = false;

      const tick = async (): Promise<void> => {
        while (!cancelled) {
          subscriber.next();
          const { outboxPollIntervalMs } = await readRuntimeSettings(this.database);
          await new Promise((resolve) => setTimeout(resolve, Math.max(outboxPollIntervalMs, 500)));
        }
      };

      void tick();
      return () => {
        cancelled = true;
      };
    }).pipe(
      mergeMap(() => from(this.#recentChanges()), 1),
      mergeMap((events) => from(events)),
      mergeMap((event) => of({ data: event } satisfies MessageEvent)),
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
