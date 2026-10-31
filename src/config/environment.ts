import { isIP } from 'node:net';
import { z } from 'zod';

const proxyEntry = (value: string) => {
  if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) return true;
  const [address = '', prefix, extra] = value.split('/');
  const family = isIP(address);
  return (
    !extra &&
    family !== 0 &&
    (prefix === undefined ||
      (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
  );
};

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: z
      .string()
      .min(1)
      .refine(
        (value) => /^mongodb(?:\+srv)?:\/\/\S+$/.test(value),
        'Must be a MongoDB connection URI',
      ),
    MONGODB_DATABASE: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-zA-Z0-9_-]+$/),
    DNS_SERVERS: z
      .string()
      .optional()
      .transform((value) =>
        value ? value.split(',').map((entry) => entry.trim()) : [],
      )
      .refine(
        (entries) => entries.every((entry) => isIP(entry) !== 0),
        'Use comma-separated DNS server IP addresses',
      ),
    SESSION_SECRET: z.string().min(32).max(1024),
    FRONTEND_ORIGIN: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        url.origin === value &&
        !url.username &&
        !url.password
      );
    }, 'Must be an exact HTTP(S) origin without a path or credentials'),
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((value) => value.split(',').map((entry) => entry.trim()))
      .refine(
        (entries) =>
          (entries.length === 1 && entries[0] === 'false') ||
          entries.every(proxyEntry),
        'Use false or explicit proxy IPs/CIDRs',
      )
      .transform((entries) => (entries[0] === 'false' ? false : entries)),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      !value.FRONTEND_ORIGIN.startsWith('https://')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['FRONTEND_ORIGIN'],
        message: 'Production requires HTTPS',
      });
    }
  });

export class ConfigurationError extends Error {
  constructor(public readonly fields: string[]) {
    super(`Invalid configuration: ${fields.join(', ')}. Check .env.example.`);
    this.name = 'ConfigurationError';
  }
}

export function parseEnvironment(source: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigurationError([
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  }
  return result.data;
}

export type Environment = ReturnType<typeof parseEnvironment>;

export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const DATE_FILTER_TIMEZONE = 'Asia/Dhaka';

// Used by the session middleware in milestone 2. No domain means host-only.
export function sessionCookieOptions(mode: Environment['NODE_ENV']) {
  return {
    httpOnly: true,
    secure: mode === 'production',
    sameSite: 'lax' as const,
    maxAge: SESSION_LIFETIME_MS,
    path: '/',
  };
}
