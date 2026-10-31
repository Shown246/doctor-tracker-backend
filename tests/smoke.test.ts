import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { setupIndexes } from '../src/database/indexes.js';
import { User } from '../src/modules/auth/user.model.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { runSmoke } from '../src/verification/smoke.js';
import { validEnvironment } from './fixtures.js';
import { createServer } from 'node:net';

let replica: MongoMemoryReplSet;
let running: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('No test port'));
      server.close(() => resolve(address.port));
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
  running = await startServer({
    ...validEnvironment,
    PORT: String(port),
    MONGODB_URI: replica.getUri(),
    FRONTEND_ORIGIN: baseUrl,
  });
  await setupIndexes();
  await User.create({
    name: 'Synthetic Smoke Admin',
    email: 'smoke-admin@example.test',
    passwordHash: await hashPassword('synthetic-smoke-admin-password'),
    role: 'admin',
    status: 'active',
  });
});
afterAll(async () => {
  await running?.shutdown();
  await replica?.stop();
});
it('runs the deployable cookie-aware acceptance client against an independent HTTP server', async () => {
  const result = await runSmoke({
    baseUrl,
    origin: baseUrl,
    adminEmail: 'smoke-admin@example.test',
    adminPassword: 'synthetic-smoke-admin-password',
    fixturePassword: 'synthetic-smoke-fixture-password',
  });
  expect(result.passed).toBe(true);
  expect(result.scenarios).toHaveLength(13);
});
