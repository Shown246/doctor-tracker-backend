import session from 'express-session';
import { MongoStore } from 'connect-mongo';
import mongoose from 'mongoose';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Environment } from '../../config/environment.js';
import {
  SESSION_LIFETIME_MS,
  sessionCookieOptions,
} from '../../config/environment.js';
import { ApiError } from '../../errors/api-error.js';
import { findCurrentUser } from './auth.service.js';
import type { CurrentUser } from './auth.schemas.js';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    expiresAt?: number;
    csrfToken?: string;
  }
}
declare module 'express-serve-static-core' {
  interface Request {
    account?: CurrentUser;
  }
}

export const SESSION_COOKIE_NAME = 'doctor_tracker.sid';
export function clearSessionCookie(response: Response, config: Environment) {
  response.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
  });
}
export function saveSession(request: Request) {
  return new Promise<void>((resolve, reject) =>
    request.session.save((error) => (error ? reject(error) : resolve())),
  );
}
export function destroySession(request: Request) {
  return new Promise<void>((resolve, reject) =>
    request.session.destroy((error) => (error ? reject(error) : resolve())),
  );
}
export function regenerateSession(request: Request) {
  return new Promise<void>((resolve, reject) =>
    request.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
}

export function pinSessionDeadline(request: Request) {
  const stored = request.session;
  stored.cookie.expires = new Date(stored.expiresAt!);
  // express-session normally slides cookie and store expiry by calling touch().
  // Override this per request so both always retain the absolute deadline.
  Object.defineProperty(stored, 'touch', {
    configurable: true,
    value() {
      stored.cookie.expires = new Date(stored.expiresAt!);
      return stored;
    },
  });
}

export function startSession(request: Request, userId?: string) {
  request.session.expiresAt = Date.now() + SESSION_LIFETIME_MS;
  request.session.csrfToken = randomBytes(32).toString('hex');
  if (userId) request.session.userId = userId;
  pinSessionDeadline(request);
}

export function browserOriginProtection(config: Environment): RequestHandler {
  return (request, _response, next) => {
    const origin = request.get('Origin');
    const referer = request.get('Referer');
    let permitted = true;
    if (origin !== undefined) permitted = origin === config.FRONTEND_ORIGIN;
    else if (referer !== undefined) {
      try {
        permitted = new URL(referer).origin === config.FRONTEND_ORIGIN;
      } catch {
        permitted = false;
      }
    } else if (request.get('Sec-Fetch-Site') === 'cross-site')
      permitted = false;
    if (!permitted)
      return next(
        new ApiError(403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed'),
      );
    next();
  };
}

// Lazy initialization keeps app creation and health probes free of DB side effects.
// Every feature router uses this shared instance; no MemoryStore fallback exists.
export function sessionSecurity(config: Environment): RequestHandler[] {
  let middleware: RequestHandler | undefined;
  const persist: RequestHandler = (request, response, next) => {
    if (!middleware) {
      if (mongoose.connection.readyState !== 1)
        return next(new ApiError(503, 'NOT_READY', 'Database is unavailable'));
      const store = MongoStore.create({
        client: mongoose.connection.getClient(),
        dbName: config.MONGODB_DATABASE,
        collectionName: 'sessions',
        ttl: SESSION_LIFETIME_MS / 1000,
        autoRemove: 'disabled', // TTL index is installed by db:indexes.
      });
      middleware = session({
        name: SESSION_COOKIE_NAME,
        secret: config.SESSION_SECRET,
        store,
        resave: false,
        saveUninitialized: false,
        rolling: false,
        cookie: sessionCookieOptions(config.NODE_ENV),
      });
    }
    middleware(request, response, next);
  };
  const state: RequestHandler = async (request, response, next) => {
    response.set('Cache-Control', 'private, no-store');
    if (request.session.expiresAt !== undefined || request.session.userId) {
      if (
        !Number.isFinite(request.session.expiresAt) ||
        request.session.expiresAt! <= Date.now()
      ) {
        await destroySession(request);
        clearSessionCookie(response, config);
        throw new ApiError(401, 'SESSION_EXPIRED', 'Session has expired');
      }
      pinSessionDeadline(request);
    }
    if (request.session.userId) {
      const account = await findCurrentUser(request.session.userId);
      if (account) request.account = account;
    }
    next();
  };
  const csrf: RequestHandler = (request, _response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const token = request.get('X-CSRF-Token');
    const expected = request.session.csrfToken;
    if (
      !token ||
      !expected ||
      !/^[a-f\d]{64}$/.test(expected) ||
      !/^[a-f\d]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      return next(
        new ApiError(403, 'CSRF_INVALID', 'A valid CSRF token is required'),
      );
    }
    next();
  };
  return [browserOriginProtection(config), persist, state, csrf];
}
