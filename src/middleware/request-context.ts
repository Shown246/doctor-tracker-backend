import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../logging/logger.js';

export function requestContext(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.locals.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    response.on('finish', () => {
      // Never log raw URLs, query strings, bodies, headers, or account data.
      logger.info(
        {
          requestId,
          method: request.method,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        'HTTP request completed',
      );
    });
    next();
  };
}
