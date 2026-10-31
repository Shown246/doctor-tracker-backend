import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  DATE_FILTER_TIMEZONE,
  parseEnvironment,
  sessionCookieOptions,
} from '../src/config/environment.js';
import { validEnvironment } from './fixtures.js';

describe('environment configuration', () => {
  it('validates settings and preserves restrictive defaults', () => {
    const config = parseEnvironment(validEnvironment);
    expect(config.PORT).toBe(4000);
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.DNS_SERVERS).toEqual([]);
    expect(DATE_FILTER_TIMEZONE).toBe('Asia/Dhaka');
    expect(sessionCookieOptions('production')).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 28_800_000,
      path: '/',
    });
    expect(sessionCookieOptions('development').secure).toBe(false);
  });

  it.each([
    { MONGODB_URI: '' },
    { MONGODB_URI: 'https://invalid.example' },
    { MONGODB_DATABASE: 'unsafe/name' },
    { SESSION_SECRET: 'short' },
    { NODE_ENV: 'staging' },
    { PORT: '65536' },
    { PORT: '0' },
    { FRONTEND_ORIGIN: 'https://example.test/path' },
    { FRONTEND_ORIGIN: 'https://user:password@example.test' },
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '1' },
    { TRUST_PROXY: '10.0.0.0/33' },
    { DNS_SERVERS: 'not-an-ip' },
    { LOG_LEVEL: 'invalid' },
  ])('rejects invalid settings: %j', (change) => {
    expect(() => parseEnvironment({ ...validEnvironment, ...change })).toThrow(
      ConfigurationError,
    );
  });

  it('reports field names without reflecting credentials', () => {
    try {
      parseEnvironment({
        ...validEnvironment,
        MONGODB_URI: 'bad-secret-uri',
        SESSION_SECRET: 'secret',
      });
      expect.fail('Expected invalid configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain('MONGODB_URI');
      expect((error as Error).message).not.toContain('bad-secret-uri');
      expect((error as Error).message).not.toContain(': secret');
    }
  });

  it('requires HTTPS in production and accepts explicit proxies and resolvers', () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, NODE_ENV: 'production' }),
    ).toThrow(ConfigurationError);
    const config = parseEnvironment({
      ...validEnvironment,
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: 'https://example.test',
      TRUST_PROXY: 'loopback,10.0.0.0/8,::1',
      DNS_SERVERS: '1.1.1.1,8.8.8.8',
    });
    expect(config.TRUST_PROXY).toEqual(['loopback', '10.0.0.0/8', '::1']);
    expect(config.DNS_SERVERS).toEqual(['1.1.1.1', '8.8.8.8']);
  });
});
