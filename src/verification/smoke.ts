import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  csrfResponseSchema,
  currentUserResponseSchema,
} from '../modules/auth/auth.schemas.js';
import { decisionResponseSchema } from '../modules/registrations/registration.schemas.js';
import { managementSchemas } from '../http/management-openapi.js';
import { dashboardResponseSchema } from '../modules/dashboards/dashboard.schemas.js';
import { filterResponseSchema } from '../modules/dashboards/filter.schemas.js';

export class SmokeClient {
  cookie = '';
  constructor(
    readonly baseUrl: string,
    readonly origin?: string,
  ) {}
  async send(
    method: string,
    path: string,
    status: number,
    body?: unknown,
    token?: string,
  ) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(this.origin ? { Origin: this.origin } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-CSRF-Token': token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== status)
      throw new Error(
        `Smoke check failed: ${method} ${path.split('?')[0]} expected ${status}, received ${response.status}`,
      );
    for (const cookie of response.headers.getSetCookie()) {
      if (!cookie.startsWith('doctor_tracker.sid=')) continue;
      if (
        this.baseUrl.startsWith('https://') &&
        cookie.includes('Max-Age=0') === false &&
        !cookie.includes('Expires=Thu, 01 Jan 1970')
      ) {
        if (
          !/; Secure/i.test(cookie) ||
          !/; HttpOnly/i.test(cookie) ||
          !/; SameSite=Lax/i.test(cookie) ||
          /; Domain=/i.test(cookie)
        )
          throw new Error('Smoke check failed: cookie policy');
      }
      this.cookie = cookie.split(';')[0]!;
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
  async mutation(method: string, path: string, status: number, body?: unknown) {
    const csrf = csrfResponseSchema.parse(
      await this.send('GET', '/api/v1/auth/csrf', 200),
    ).data.csrfToken;
    return this.send(method, path, status, body, csrf);
  }
  async login(email: string, password: string) {
    return currentUserResponseSchema.parse(
      await this.mutation('POST', '/api/v1/auth/login', 200, {
        email,
        password,
      }),
    ).data;
  }
}
export async function runSmoke(input: {
  baseUrl: string;
  origin?: string | undefined;
  adminEmail: string;
  adminPassword: string;
  fixturePassword: string;
}) {
  const publicClient = new SmokeClient(input.baseUrl, input.origin);
  await publicClient.send('GET', '/health/ready', 200);
  await publicClient.send('GET', '/health/live', 200);
  await publicClient.send('GET', '/api/v1/dashboard', 401);
  await publicClient.send('POST', '/api/v1/auth/login', 403, {
    email: input.adminEmail,
    password: input.adminPassword,
  });
  const admin = new SmokeClient(input.baseUrl, input.origin);
  await admin.login(input.adminEmail, input.adminPassword);
  await admin.send('GET', '/api/v1/docs/openapi.json', 200);
  const nonce = randomUUID();
  const accounts = [];
  for (const role of ['doctor', 'patient'] as const) {
    const email = `smoke-${role}-${nonce}@example.test`;
    const client = new SmokeClient(input.baseUrl, input.origin);
    const registration = currentUserResponseSchema.parse(
      await client.mutation('POST', '/api/v1/auth/register', 201, {
        name: `Synthetic Smoke ${role}`,
        email,
        password: input.fixturePassword,
        role,
        profile:
          role === 'doctor'
            ? {
                specialization: 'Synthetic Smoke Specialty',
                hospital: 'Synthetic Smoke Hospital',
                phone: '+8801700000000',
              }
            : {
                dateOfBirth: '1995-02-28',
                gender: 'undisclosed',
                phone: '+8801800000000',
              },
      }),
    ).data;
    await client.login(email, input.fixturePassword);
    await client.send('GET', '/api/v1/dashboard', 403);
    const decision = decisionResponseSchema.parse(
      await admin.mutation(
        'PUT',
        `/api/v1/registrations/${registration.id}/decision`,
        200,
        {
          decision: 'approve',
          mode: 'create',
          ...(role === 'patient'
            ? {
                patientClinical: {
                  condition: 'Synthetic Smoke Observation',
                  status: 'stable',
                },
              }
            : {}),
        },
      ),
    ).data;
    if (!decision.profileId)
      throw new Error('Smoke check failed: approval did not link a profile');
    const me = currentUserResponseSchema.parse(
      await client.send('GET', '/api/v1/auth/me', 200),
    );
    if (me.data.status !== 'active')
      throw new Error(
        'Smoke check failed: existing session did not observe approval',
      );
    accounts.push({ role, client, profileId: decision.profileId });
  }
  const doctor = accounts.find((account) => account.role === 'doctor')!;
  const patient = accounts.find((account) => account.role === 'patient')!;
  const pair = `/api/v1/doctors/${doctor.profileId}/patients/${patient.profileId}`;
  await admin.mutation('PUT', pair, 200);
  await admin.mutation('PUT', pair, 200);
  await doctor.client.send(
    'GET',
    `/api/v1/me/patients/${patient.profileId}`,
    200,
  );
  const profile = managementSchemas.PatientResponse.parse(
    await patient.client.send('GET', '/api/v1/me/profile', 200),
  ).data;
  await doctor.client.mutation(
    'PATCH',
    `/api/v1/me/patients/${patient.profileId}/clinical`,
    200,
    { revision: profile.revision, status: 'under_treatment' },
  );
  await doctor.client.mutation(
    'PATCH',
    `/api/v1/me/patients/${patient.profileId}/clinical`,
    409,
    { revision: profile.revision, status: 'stable' },
  );
  const notePath = `/api/v1/me/patients/${patient.profileId}/note`;
  await doctor.client.mutation('PUT', notePath, 200, {
    revision: 0,
    note: 'Synthetic smoke private note',
  });
  await patient.client.send('GET', notePath, 403);
  for (const account of [admin, doctor.client, patient.client])
    dashboardResponseSchema.parse(
      await account.send('GET', '/api/v1/dashboard', 200),
    );
  filterResponseSchema.parse(
    await doctor.client.send('GET', '/api/v1/filters', 200),
  );
  await patient.client.send('GET', '/api/v1/filters', 403);
  await admin.mutation('DELETE', pair, 204);
  await doctor.client.send('GET', notePath, 404);
  await admin.mutation('PUT', pair, 200);
  const empty = managementSchemas.NoteResponse.parse(
    await doctor.client.send('GET', notePath, 200),
  );
  if (empty.data.note !== null || empty.data.revision !== 0)
    throw new Error('Smoke check failed: unlink retained a note');
  await admin.mutation('DELETE', `/api/v1/patients/${patient.profileId}`, 204);
  await patient.client.send('GET', '/api/v1/dashboard', 403);
  await doctor.client.send(
    'GET',
    `/api/v1/me/patients/${patient.profileId}`,
    404,
  );
  const replay = new SmokeClient(input.baseUrl, input.origin);
  replay.cookie = admin.cookie;
  await admin.mutation('POST', '/api/v1/auth/logout', 204);
  await replay.send('GET', '/api/v1/auth/me', 401);
  await doctor.client.mutation('POST', '/api/v1/auth/logout', 204);
  await patient.client.mutation('POST', '/api/v1/auth/logout', 204);
  return {
    passed: true,
    scenarios: [
      'readiness',
      'CSRF rejection',
      'registration',
      'pending denial',
      'approval visible in existing sessions',
      'duplicate links',
      'clinical revision conflict',
      'private notes',
      'role dashboards',
      'scoped filters',
      'unlink and relink',
      'patient deletion and account disablement',
      'logout and replay denial',
    ],
    residualData:
      'One synthetic doctor profile and two account submissions remain per run; the patient profile is deleted.',
  };
}
export const smokeConfigurationSchema = z.object({
  SMOKE_BASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  }),
  SMOKE_ORIGIN: z.url().optional(),
  SMOKE_ADMIN_EMAIL: z.email(),
  SMOKE_ADMIN_PASSWORD: z.string().min(12).max(128),
  SMOKE_FIXTURE_PASSWORD: z.string().min(12).max(128),
  SMOKE_ALLOW_WRITES: z.literal('true'),
});
