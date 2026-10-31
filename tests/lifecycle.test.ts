import { fork, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validEnvironment } from './fixtures.js';
import mongoose from 'mongoose';
import { hashPassword } from '../src/modules/auth/password.js';

let replica: MongoMemoryReplSet;
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  }
  children.clear();
});
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
});
afterAll(async () => {
  await replica?.stop();
});

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function collect(child: ChildProcess) {
  children.add(child);
  let logs = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  return () => logs;
}

describe('server process lifecycle', () => {
  it('preserves an authenticated session across a full server process restart', async () => {
    const port = await freePort();
    const mongo = new mongoose.mongo.MongoClient(replica.getUri());
    await mongo.connect();
    const email = 'restart-admin@example.test';
    const password = 'synthetic-restart-password';
    await mongo
      .db(validEnvironment.MONGODB_DATABASE)
      .collection('users')
      .insertOne({
        name: 'Restart Admin',
        email,
        passwordHash: await hashPassword(password),
        role: 'admin',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      });
    const recorded: (() => string)[] = [];
    async function launch() {
      const child = fork(
        fileURLToPath(new URL('./support/server-process.ts', import.meta.url)),
        {
          execArgv: ['--import', 'tsx'],
          silent: true,
          env: {
            ...process.env,
            ...validEnvironment,
            MONGODB_URI: replica.getUri(),
            PORT: String(port),
            LOG_LEVEL: 'info',
          },
        },
      );
      recorded.push(collect(child));
      await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error('Server exited before ready');
        }),
      ]);
      return child;
    }
    async function stop(child: ChildProcess) {
      const exited = once(child, 'exit');
      if (process.platform === 'win32') child.send('SIGTERM');
      else child.kill('SIGTERM');
      const [code] = await exited;
      expect(code).toBe(0);
    }
    const base = `http://127.0.0.1:${port}/api/v1/auth`;
    try {
      const initial = await launch();
      const csrf = await fetch(`${base}/csrf`);
      const token = (await csrf.json()).data.csrfToken as string;
      const anonymousCookie = csrf.headers.getSetCookie()[0]!.split(';')[0]!;
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: {
          Cookie: anonymousCookie,
          'X-CSRF-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
      const account = (await login.json()).data;
      const sessionCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
      await stop(initial);
      const restarted = await launch();
      const me = await fetch(`${base}/me`, {
        headers: { Cookie: sessionCookie },
      });
      expect(me.status).toBe(200);
      expect((await me.json()).data.id).toBe(account.id);
      await stop(restarted);
      const logs = recorded.map((read) => read()).join('\n');
      expect(logs).toContain('HTTP request completed');
      for (const secret of [
        email,
        password,
        sessionCookie,
        token,
        '$argon2id$',
      ]) {
        expect(logs).not.toContain(secret);
      }
    } finally {
      await mongo.close();
    }
  });

  it('disconnects MongoDB when the HTTP port is already in use', async () => {
    const occupied = createServer();
    // Reserve the same IPv4 wildcard as the hosted server. Windows can permit
    // a separate IPv4 bind when only the default IPv6 listener is occupied.
    occupied.listen(0, '0.0.0.0');
    await once(occupied, 'listening');
    try {
      const port = (occupied.address() as { port: number }).port;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/server.ts'],
        {
          env: {
            ...process.env,
            ...validEnvironment,
            MONGODB_URI: replica.getUri(),
            PORT: String(port),
            LOG_LEVEL: 'info',
          },
        },
      );
      const logs = collect(child);
      const [code] = await once(child, 'exit');
      expect(code).toBe(1);
      expect(logs()).toContain('Database disconnected');
      expect(logs()).not.toContain('HTTP server listening');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'starts against a replica set and drains on %s',
    async (signal) => {
      const port = await freePort();
      const child = fork(
        fileURLToPath(new URL('./support/server-process.ts', import.meta.url)),
        {
          execArgv: ['--import', 'tsx'],
          silent: true,
          env: {
            ...process.env,
            ...validEnvironment,
            MONGODB_URI: replica.getUri(),
            PORT: String(port),
            LOG_LEVEL: 'info',
          },
        },
      );
      const logs = collect(child);
      const exited = once(child, 'exit');
      try {
        await Promise.race([
          once(child, 'message'),
          exited.then(() => {
            throw new Error(`Child exited before ready: ${logs()}`);
          }),
        ]);
        const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
        expect(ready.status).toBe(200);
        await ready.body?.cancel();
        if (process.platform === 'win32') child.send(signal);
        else child.kill(signal);
        const [code] = await exited;
        expect(code).toBe(0);
        expect(logs()).toContain('Shutdown completed');
        expect(logs()).not.toContain(replica.getUri());
        await expect(
          fetch(`http://127.0.0.1:${port}/health/live`),
        ).rejects.toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    },
  );

  it('fails safely before listening when configuration is invalid', async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts'],
      {
        env: {
          ...process.env,
          ...validEnvironment,
          MONGODB_URI: 'invalid-sensitive-uri',
          SESSION_SECRET: 'private',
          PORT: String(port),
        },
      },
    );
    const logs = collect(child);
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(logs()).toContain('Invalid configuration');
    expect(logs()).not.toMatch(/invalid-sensitive-uri|: private/);
    await expect(
      fetch(`http://127.0.0.1:${port}/health/live`),
    ).rejects.toThrow();
  });

  it('exits without opening HTTP when the database cannot connect', async () => {
    const port = await freePort();
    const unreachablePort = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts'],
      {
        env: {
          ...process.env,
          ...validEnvironment,
          MONGODB_URI: `mongodb://synthetic:private@127.0.0.1:${unreachablePort}/`,
          PORT: String(port),
          LOG_LEVEL: 'info',
        },
      },
    );
    const logs = collect(child);
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(logs()).toContain('Database connection failed');
    expect(logs()).not.toMatch(/synthetic|private@/);
    await expect(
      fetch(`http://127.0.0.1:${port}/health/live`),
    ).rejects.toThrow();
  });
});
