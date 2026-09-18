import pino from 'pino';

import { config } from './config.js';

export type Logger = pino.Logger;

export const logger: Logger = pino(
  {
    level: config.LOG_LEVEL,
    base: { role: config.APP_ROLE },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['payload', '*.payload', 'req.headers.authorization'],
      censor: '[redacted]',
    },
  },
  pino.destination({ dest: 1, sync: true }),
);
