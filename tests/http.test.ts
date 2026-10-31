import express from 'express';
import request from 'supertest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import mongoose from 'mongoose';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config/environment.js';
import { createLogger } from '../src/logging/logger.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestContext } from '../src/middleware/request-context.js';
import { sendData, sendList } from '../src/http/responses.js';
import { validEnvironment } from './fixtures.js';

const logger = createLogger('silent');
const app = (ready = true) =>
  createApp({
    config: parseEnvironment(validEnvironment),
    logger,
    isDatabaseReady: async () => ready,
  });

describe('HTTP foundation', () => {
  it('reports liveness independently from readiness', async () => {
    const alive = await request(app(false)).get('/health/live').expect(200);
    expect(alive.body).toEqual({ data: { status: 'alive' } });
    await request(app()).get('/health/ready').expect(200);
    const unavailable = await request(app(false))
      .get('/health/ready')
      .expect(503);
    expect(unavailable.body.error.code).toBe('NOT_READY');
    expect(unavailable.body.error.requestId).toBe(
      unavailable.headers['x-request-id'],
    );
    expect(alive.headers['x-powered-by']).toBeUndefined();
    expect(alive.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns consistent unknown routes and generates independent request IDs', async () => {
    const first = await request(app())
      .get('/api/v1/unknown')
      .set('X-Request-Id', 'untrusted')
      .expect(404);
    const second = await request(app()).get('/unknown').expect(404);
    expect(first.body.error.code).toBe('NOT_FOUND');
    expect(first.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.headers['x-request-id']).not.toBe(
      second.headers['x-request-id'],
    );
  });

  it('handles malformed and oversized JSON consistently', async () => {
    const malformed = await request(app())
      .post('/api/v1/unknown')
      .set('Content-Type', 'application/json')
      .send('{"secret":')
      .expect(400);
    expect(malformed.body.error.code).toBe('MALFORMED_JSON');
    expect(JSON.stringify(malformed.body)).not.toContain('secret');
    const large = await request(app())
      .post('/api/v1/unknown')
      .send({ value: 'a'.repeat(40_000) })
      .expect(413);
    expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each([
    [
      new Error('mongodb://secret:password@host/private'),
      500,
      'INTERNAL_ERROR',
    ],
    [
      { code: 11000, keyValue: { email: 'private@example.test' } },
      409,
      'DUPLICATE_KEY',
    ],
    [
      z.strictObject({ name: z.string() }).safeParse({ name: 42 }).error,
      400,
      'VALIDATION_ERROR',
    ],
    [
      new mongoose.Error.CastError('ObjectId', 'private', '_id'),
      400,
      'VALIDATION_ERROR',
    ],
    [new mongoose.Error.StrictModeError('private'), 400, 'VALIDATION_ERROR'],
  ])(
    'maps errors without exposing submitted values',
    async (error, status, code) => {
      const probe = express();
      probe.use(requestContext(logger));
      probe.get('/probe', () => {
        throw error;
      });
      probe.use(errorHandler(logger));
      const result = await request(probe)
        .get('/probe')
        .expect(status as number);
      expect(result.body.error.code).toBe(code);
      expect(result.body.error.stack).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toMatch(
        /password|private@example/,
      );
    },
  );

  it('logs only stable metadata, never request secrets or driver error text', async () => {
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const recordingLogger = pino({ level: 'info' }, sink);
    const probe = express();
    probe.use(requestContext(recordingLogger));
    probe.get('/probe', () => {
      throw new Error('mongodb://user:supersecret@host');
    });
    probe.use(errorHandler(recordingLogger));
    const result = await request(probe)
      .get('/probe?password=supersecret')
      .set('Authorization', 'supersecret')
      .expect(500);
    expect(output).not.toContain('supersecret');
    expect(output).toContain(result.headers['x-request-id']);
    const entries = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.code === 'INTERNAL_ERROR')).toBe(true);
    expect(
      entries.some((entry) => entry.status === 500 && entry.durationMs >= 0),
    ).toBe(true);
  });

  it('uses the specified success and pagination envelopes', async () => {
    const probe = express();
    probe.get('/one', (_req, res) => {
      sendData(res, { id: 'example' }, 201);
    });
    probe.get('/list', (_req, res) => {
      sendList(res, [], { page: 1, limit: 20, total: 0 });
    });
    expect((await request(probe).get('/one').expect(201)).body).toEqual({
      data: { id: 'example' },
    });
    expect((await request(probe).get('/list').expect(200)).body).toEqual({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });
});
