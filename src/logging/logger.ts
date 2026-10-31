import { pino } from 'pino';
import type { Environment } from '../config/environment.js';

export function createLogger(level: Environment['LOG_LEVEL'] = 'info') {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        'password',
        'passwordHash',
        'MONGODB_URI',
        'SESSION_SECRET',
        'req.headers',
        'req.body',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
