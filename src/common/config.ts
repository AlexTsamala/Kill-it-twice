import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  APP_ROLE: z.enum(['api', 'worker', 'consumer']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
  HTTP_PORT: port,

  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: positiveInt,

  ELASTICSEARCH_NODE: z.string().min(1),
  ELASTICSEARCH_INDEX: z.string().min(1),
  ELASTICSEARCH_ALIAS: z.string().min(1),

  RABBITMQ_URL: z.string().min(1),
  RABBITMQ_EXCHANGE: z.string().min(1),
  RABBITMQ_QUEUE: z.string().min(1),
  RABBITMQ_PREFETCH: positiveInt,

  BATCH_SIZE: positiveInt,
  OUTBOX_POLL_INTERVAL_MS: positiveInt,
  BACKFILL_PUBLISH_EVENTS: booleanFromEnv,

  RETRY_MAX_ATTEMPTS: positiveInt,
  RETRY_BASE_MS: positiveInt,
  RETRY_CAP_MS: positiveInt,

  SEED_TOTAL: positiveInt,
  SEED_BATCH_SIZE: positiveInt,
});

export type Config = Readonly<z.infer<typeof schema>>;

function loadConfigOrExit(): Config {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    process.stderr.write(
      `Invalid configuration — refusing to start.\n${issues}\n` +
        `See .env.example for the full list of required variables.\n`,
    );
    process.exit(1);
  }

  return Object.freeze(parsed.data);
}

export const config: Config = loadConfigOrExit();
