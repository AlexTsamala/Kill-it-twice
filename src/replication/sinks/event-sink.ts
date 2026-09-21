import { z } from 'zod';

export const EVENT_SINK = Symbol('EventSink');

export const PRODUCT_EVENT_TYPES = [
  'product.snapshot',
  'product.created',
  'product.updated',
  'product.deleted',
] as const;

export const productEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(PRODUCT_EVENT_TYPES),
  aggregateId: z.number().int().positive(),
  version: z.number().int(),
  occurredAt: z.string().min(1),
  data: z.object({
    id: z.number().int().positive(),
    sku: z.string(),
    name: z.string(),
    price: z.number(),
    status: z.string(),
  }),
});

export type ProductEvent = z.infer<typeof productEventSchema>;
export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number];

export interface EventSink {
  publishBatch(events: readonly ProductEvent[]): Promise<void>;
}
