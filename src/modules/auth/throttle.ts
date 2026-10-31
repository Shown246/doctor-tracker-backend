import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import type { RequestHandler } from 'express';
import { ApiError } from '../../errors/api-error.js';
import type { Environment } from '../../config/environment.js';

export const AUTH_LIMITS = {
  registration: { limit: 10, windowMs: 60 * 60 * 1000 },
  loginIp: { limit: 30, windowMs: 15 * 60 * 1000 },
  loginAccountIp: { limit: 10, windowMs: 15 * 60 * 1000 },
} as const;

// Fixed-window counters are atomic and shared by all API processes. Neither
// raw email addresses nor IPs are stored. Expired buckets have a TTL index.
export function authThrottle(
  config: Environment,
  kind: keyof typeof AUTH_LIMITS,
): RequestHandler {
  return async (request, response, next) => {
    const { limit, windowMs } = AUTH_LIMITS[kind];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const email: unknown = request.body?.email;
    const identity =
      kind === 'loginAccountIp' && typeof email === 'string'
        ? email.trim().toLowerCase()
        : '';
    const digest = createHmac('sha256', config.SESSION_SECRET)
      .update(JSON.stringify([kind, request.ip, identity]))
      .digest('hex');
    const expiresAt = new Date(windowStart + windowMs);
    const counters = mongoose.connection.collection<{
      _id: string;
      count: number;
      expiresAt: Date;
    }>('authRateLimits');
    let bucket;
    try {
      bucket = await counters.findOneAndUpdate(
        { _id: `${digest}:${windowStart}` },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt },
        },
        { upsert: true, returnDocument: 'after' },
      );
    } catch (error) {
      // Concurrent first inserts can race on the unique _id index.
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      ))
        throw error;
      bucket = await counters.findOneAndUpdate(
        { _id: `${digest}:${windowStart}` },
        { $inc: { count: 1 } },
        { returnDocument: 'after' },
      );
    }
    if (!bucket || bucket.count > limit) {
      response.set(
        'Retry-After',
        String(Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000))),
      );
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many attempts; try again later',
      );
    }
    next();
  };
}
