import express from 'express';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app.js';
import {
  parseEnvironment,
  SESSION_LIFETIME_MS,
} from '../src/config/environment.js';
import { connectDatabase } from '../src/database/connection.js';
import { setupIndexes } from '../src/database/indexes.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestContext } from '../src/middleware/request-context.js';
import { createLogger } from '../src/logging/logger.js';
import { User } from '../src/modules/auth/user.model.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import { Doctor } from '../src/modules/doctors/doctor.model.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { DoctorPatient } from '../src/modules/assignments/doctor-patient.model.js';
import {
  allowRoles,
  ownProfile,
  requireActiveAccount,
  requireAuthentication,
  requirePatientScope,
} from '../src/modules/auth/access.js';
import {
  sessionSecurity,
  SESSION_COOKIE_NAME,
} from '../src/modules/auth/session.js';
import { validEnvironment, doctorInput, patientInput } from './fixtures.js';
import { AUTH_LIMITS } from '../src/modules/auth/throttle.js';

const logger = createLogger('silent');
const password = 'synthetic-auth-password';
let replica: MongoMemoryReplSet;
let disconnect: (() => Promise<void>) | undefined;
let config: ReturnType<typeof parseEnvironment>;
let app: ReturnType<typeof createApp>;
let storedHash: string;
const doctorSubmission = {
  name: doctorInput.name,
  email: doctorInput.email,
  password,
  role: 'doctor',
  profile: {
    specialization: doctorInput.specialization,
    hospital: doctorInput.hospital,
    phone: doctorInput.phone,
  },
};
const patientSubmission = {
  name: patientInput.name,
  email: 'patient@example.test',
  password,
  role: 'patient',
  profile: {
    dateOfBirth: patientInput.dateOfBirth,
    gender: patientInput.gender,
    phone: patientInput.phone,
    address: 'Synthetic address',
  },
};
const sessions = () => mongoose.connection.collection('sessions');
const counters = () => mongoose.connection.collection('authRateLimits');
const cookies = (result: request.Response) =>
  result.headers['set-cookie'] as unknown as string[];
const cookie = (result: request.Response) => cookies(result)[0]!.split(';')[0]!;

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  config = parseEnvironment({
    ...validEnvironment,
    MONGODB_URI: replica.getUri(),
  });
  disconnect = await connectDatabase(config, logger);
  await setupIndexes();
  storedHash = await hashPassword(password);
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Doctor.deleteMany({}),
    Patient.deleteMany({}),
    DoctorPatient.deleteMany({}),
    sessions().deleteMany({}),
    counters().deleteMany({}),
  ]);
  app = createApp({ config, logger, isDatabaseReady: async () => true });
});
afterAll(async () => {
  await disconnect?.();
  await replica?.stop();
});

async function csrf(agent: ReturnType<typeof request.agent>) {
  const result = await agent.get('/api/v1/auth/csrf').expect(200);
  return result.body.data.csrfToken as string;
}
async function pending(role: 'doctor' | 'patient' = 'doctor', email?: string) {
  const input = role === 'doctor' ? doctorSubmission : patientSubmission;
  return User.create({
    name: input.name,
    email: email ?? input.email,
    role,
    passwordHash: storedHash,
    pendingRegistration: { [role]: input.profile },
  });
}
async function active(role: 'admin' | 'doctor' | 'patient', suffix = '') {
  const email = `${role}${suffix}@example.test`;
  const profile =
    role === 'doctor'
      ? await Doctor.create({ ...doctorInput, email })
      : role === 'patient'
        ? await Patient.create({ ...patientInput, email })
        : null;
  return User.create({
    name: `Example ${role}`,
    email,
    passwordHash: storedHash,
    role,
    status: 'active',
    ...(role === 'doctor'
      ? { doctorId: profile!._id }
      : role === 'patient'
        ? { patientId: profile!._id }
        : {}),
  });
}
async function loginAs(user: { email: string }) {
  const agent = request.agent(app);
  const initialToken = await csrf(agent);
  const result = await agent
    .post('/api/v1/auth/login')
    .set('X-CSRF-Token', initialToken)
    .send({ email: user.email, password })
    .expect(200);
  const token = await csrf(agent);
  return { agent, token, cookie: cookie(result), initialToken, result };
}
async function adminSession() {
  return loginAs(await active('admin'));
}
const approveNew = { decision: 'approve', mode: 'create' };
const approvePatient = {
  ...approveNew,
  patientClinical: { condition: 'Reviewed condition', status: 'stable' },
};

describe('public registration and strict contracts', () => {
  it.each(['doctor', 'patient'] as const)(
    'keeps %s registration pending, hashes passwords and creates no profile',
    async (role) => {
      const agent = request.agent(app);
      const token = await csrf(agent);
      const input = role === 'doctor' ? doctorSubmission : patientSubmission;
      const result = await agent
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', token)
        .send({ ...input, email: `  ${input.email.toUpperCase()}  ` })
        .expect(201);
      expect(result.body.data).toMatchObject({
        role,
        status: 'pending',
        email: input.email,
        profileId: null,
      });
      expect(Object.keys(result.body.data).sort()).toEqual(
        ['id', 'name', 'email', 'role', 'status', 'profileId'].sort(),
      );
      expect(await Doctor.countDocuments()).toBe(0);
      expect(await Patient.countDocuments()).toBe(0);
      const user = await User.findById(result.body.data.id).select(
        '+passwordHash +pendingRegistration',
      );
      expect(await verifyPassword(user!.passwordHash, password)).toBe(true);
      expect(user!.pendingRegistration?.[role]).toBeTruthy();
      await agent.get('/api/v1/auth/me').expect(401); // Registration does not log in.
      await agent
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', token)
        .send(input)
        .expect(409);
    },
  );

  it.each([
    { role: 'admin' },
    { status: 'active' },
    { doctorId: new Types.ObjectId().toString() },
    { patientId: new Types.ObjectId().toString() },
    { profileId: new Types.ObjectId().toString() },
    { passwordHash: '$argon2id$fake' },
    { pendingRegistration: {} },
    { rejectionReason: 'Injected' },
    { profile: { ...doctorSubmission.profile, privateNote: 'Injected' } },
    {
      profile: {
        ...doctorSubmission.profile,
        patient: patientSubmission.profile,
      },
    },
    { password: 'short' },
    { name: ' ' },
    { email: 'invalid' },
  ])('rejects escalation and unsupported input %j', async (change) => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', token)
      .send({ ...doctorSubmission, ...change })
      .expect(400);
    expect(await User.countDocuments()).toBe(0);
  });
  it.each(['2023-02-29', '9999-01-01', '1990-01-01T00:00:00Z'])(
    'rejects invalid birth date %s',
    async (dateOfBirth) => {
      const agent = request.agent(app);
      const token = await csrf(agent);
      await agent
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', token)
        .send({
          ...patientSubmission,
          profile: { ...patientSubmission.profile, dateOfBirth },
        })
        .expect(400);
    },
  );
});

describe('CSRF and browser origins', () => {
  it('requires tokens for all mutations, rejects invalid and cross-session tokens', async () => {
    for (const path of ['register', 'login', 'logout']) {
      await request(app).post(`/api/v1/auth/${path}`).send({}).expect(403);
    }
    const first = request.agent(app);
    const second = request.agent(app);
    const firstToken = await csrf(first);
    const secondToken = await csrf(second);
    expect(firstToken).not.toBe(secondToken);
    for (const token of [
      firstToken,
      'x'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(64),
    ]) {
      const result = await second
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', token)
        .send(doctorSubmission)
        .expect(403);
      expect(result.body.error.code).toBe('CSRF_INVALID');
    }
    expect(await User.countDocuments()).toBe(0);
  });
  it.each(['https://evil.test', 'null', 'http://localhost:3000.evil.test'])(
    'rejects disallowed origin %s',
    async (origin) => {
      const result = await request(app)
        .get('/api/v1/auth/csrf')
        .set('Origin', origin)
        .expect(403);
      expect(result.body.error.code).toBe('ORIGIN_FORBIDDEN');
      expect(result.headers['set-cookie']).toBeUndefined();
    },
  );
  it('validates Referer and Fetch Metadata, permits exact configured origins and non-browser clients', async () => {
    await request(app)
      .get('/api/v1/auth/csrf')
      .set('Referer', 'https://evil.test/login')
      .expect(403);
    await request(app)
      .get('/api/v1/auth/csrf')
      .set('Referer', 'malformed')
      .expect(403);
    await request(app)
      .get('/api/v1/auth/csrf')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
    await request(app)
      .get('/api/v1/auth/csrf')
      .set('Origin', config.FRONTEND_ORIGIN)
      .expect(200);
    await request(app)
      .get('/api/v1/auth/csrf')
      .set('Referer', `${config.FRONTEND_ORIGIN}/login`)
      .expect(200);
    await request(app).get('/api/v1/auth/csrf').expect(200);
  });
});

describe('login, session persistence, current user and logout', () => {
  it('fails closed when an authenticated stored session has no absolute deadline', async () => {
    const client = await loginAs(await active('admin'));
    const stored = await sessions().findOne({});
    const data = JSON.parse(stored!.session as string);
    delete data.expiresAt;
    await sessions().updateOne(
      { _id: stored!._id },
      { $set: { session: JSON.stringify(data) } },
    );
    await client.agent.get('/api/v1/auth/me').expect(401);
    expect(await sessions().countDocuments()).toBe(0);
  });

  it.each(['pending', 'rejected'] as const)(
    'allows %s status lookup and logout with a rotated session and CSRF token',
    async (status) => {
      const user = await pending();
      user.status = status;
      if (status === 'rejected') user.rejectionReason = 'Synthetic rejection';
      await user.save();
      const agent = request.agent(app);
      const before = await agent.get('/api/v1/auth/csrf');
      const oldCookie = cookie(before);
      const result = await agent
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', before.body.data.csrfToken)
        .send({ email: user.email, password })
        .expect(200);
      expect(cookie(result)).not.toBe(oldCookie);
      expect(result.body.data.status).toBe(status);
      if (status === 'rejected')
        expect(result.body.data.rejectionReason).toBe('Synthetic rejection');
      expect(JSON.stringify(result.body)).not.toMatch(
        /password|pendingRegistration|specialization/,
      );
      await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', oldCookie)
        .expect(401);
      const me = await agent.get('/api/v1/auth/me').expect(200);
      expect(me.headers['cache-control']).toBe('private, no-store');
      await agent
        .post('/api/v1/auth/logout')
        .set('X-CSRF-Token', before.body.data.csrfToken)
        .send({})
        .expect(403);
      const token = await csrf(agent);
      expect(token).not.toBe(before.body.data.csrfToken);
      const logout = await agent
        .post('/api/v1/auth/logout')
        .set('X-CSRF-Token', token)
        .send({})
        .expect(204);
      expect(cookies(logout)[0]).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cookies(logout)[0]).toMatch(/HttpOnly/);
      expect(cookies(logout)[0]).not.toContain('Domain=');
      await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', cookie(result))
        .expect(401);
      expect(await sessions().countDocuments()).toBe(0);
    },
  );
  it('uses generic credential failures and denies disabled login', async () => {
    const user = await active('admin');
    const agent = request.agent(app);
    const token = await csrf(agent);
    const failures = [];
    for (const input of [
      { email: user.email, password: 'wrong-test-password' },
      { email: 'missing@example.test', password },
    ]) {
      const result = await agent
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', token)
        .send(input)
        .expect(401);
      failures.push({
        code: result.body.error.code,
        message: result.body.error.message,
      });
    }
    user.status = 'disabled';
    await user.save();
    const disabled = await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', token)
      .send({ email: user.email, password })
      .expect(401);
    expect(failures[0]).toEqual(failures[1]);
    expect(disabled.body.error.code).toBe(failures[0]!.code);
  });
  it('denies existing disabled/deleted sessions immediately and still permits disabled logout', async () => {
    const user = await active('admin');
    const client = await loginAs(user);
    user.status = 'disabled';
    await user.save();
    await client.agent.get('/api/v1/auth/me').expect(403);
    await client.agent
      .post('/api/v1/auth/logout')
      .set('X-CSRF-Token', client.token)
      .expect(204);
    const other = await active('admin', '-other');
    const deleted = await loginAs(other);
    await User.deleteOne({ _id: other._id });
    await deleted.agent.get('/api/v1/auth/me').expect(401);
  });
  it('stores only identity, CSRF and expiry metadata and fixes cookie/store expiry across activity', async () => {
    const client = await loginAs(await active('admin'));
    const stored = await sessions().findOne({});
    const data = JSON.parse(stored!.session as string);
    expect(Object.keys(data).sort()).toEqual(
      ['cookie', 'userId', 'expiresAt', 'csrfToken'].sort(),
    );
    expect(data.expiresAt - Date.now()).toBeGreaterThan(
      SESSION_LIFETIME_MS - 10_000,
    );
    expect(data.expiresAt - Date.now()).toBeLessThanOrEqual(
      SESSION_LIFETIME_MS,
    );
    expect((stored!.expires as Date).getTime()).toBe(data.expiresAt);
    const originalCookie = cookies(client.result)[0]!;
    expect(originalCookie).toMatch(/HttpOnly/);
    expect(originalCookie).toMatch(/SameSite=Lax/);
    expect(originalCookie).not.toMatch(/Domain=|Secure/);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    try {
      await client.agent.get('/api/v1/auth/me').expect(200);
      const refreshed = await client.agent.get('/api/v1/auth/csrf').expect(200);
      expect(refreshed.body.data.csrfToken).toBe(client.token);
      if (refreshed.headers['set-cookie'])
        expect(cookies(refreshed)[0]!.match(/Expires=[^;]+/)?.[0]).toBe(
          originalCookie.match(/Expires=[^;]+/)?.[0],
        );
      const after = await sessions().findOne({});
      expect((after!.expires as Date).getTime()).toBe(data.expiresAt);
      expect(JSON.parse(after!.session as string).expiresAt).toBe(
        data.expiresAt,
      );
    } finally {
      clock.mockRestore();
    }
    const indexes = await sessions().indexes();
    expect(
      indexes.some(
        (index) => index.key.expires === 1 && index.expireAfterSeconds === 0,
      ),
    ).toBe(true);
  });
  it('rejects absolute expiry independently of MongoDB TTL cleanup', async () => {
    const client = await loginAs(await active('admin'));
    const stored = await sessions().findOne({});
    const data = JSON.parse(stored!.session as string);
    data.expiresAt = Date.now() - 1;
    await sessions().updateOne(
      { _id: stored!._id },
      { $set: { session: JSON.stringify(data) } },
    );
    const result = await client.agent.get('/api/v1/auth/me').expect(401);
    expect(result.body.error.code).toBe('SESSION_EXPIRED');
    expect(await sessions().countDocuments()).toBe(0);
    expect(result.headers['set-cookie']).toBeTruthy();
  });
  it('rejects expired store entries and tampered cookies', async () => {
    const client = await loginAs(await active('admin'));
    await sessions().updateMany(
      {},
      { $set: { expires: new Date(Date.now() - 1000) } },
    );
    await client.agent.get('/api/v1/auth/me').expect(401);
    await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=s%3Aforged.signature`)
      .expect(401);
  });
  it('sets production Secure host-only cookies only over trusted HTTPS', async () => {
    const production = createApp({
      config: {
        ...config,
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://portal.example.test',
        TRUST_PROXY: ['loopback'],
      },
      logger,
      isDatabaseReady: async () => true,
    });
    const secure = await request(production)
      .get('/api/v1/auth/csrf')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    expect(cookies(secure)[0]).toMatch(/; Secure/);
    expect(cookies(secure)[0]).toMatch(/; HttpOnly/);
    expect(cookies(secure)[0]).not.toMatch(/Domain=/);
    const insecure = await request(production)
      .get('/api/v1/auth/csrf')
      .expect(200);
    expect(insecure.headers['set-cookie']).toBeUndefined();
  });
  it('reuses a MongoDB session with a recreated application', async () => {
    const user = await active('admin');
    const client = await loginAs(user);
    const restarted = createApp({
      config,
      logger,
      isDatabaseReady: async () => true,
    });
    const result = await request(restarted)
      .get('/api/v1/auth/me')
      .set('Cookie', client.cookie)
      .expect(200);
    expect(result.body.data.id).toBe(user.id);
  });
});

describe('admin registration review and atomic decisions', () => {
  it('allows only one concurrent decision linking an existing profile', async () => {
    const user = await pending('patient');
    const profile = await Patient.create({
      ...patientInput,
      email: user.email,
    });
    const admin = await adminSession();
    const body = { decision: 'approve', mode: 'link', profileId: profile.id };
    const results = await Promise.all([
      admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(body),
      admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await Patient.countDocuments()).toBe(1);
    expect((await User.findById(user.id))!.patientId!.toString()).toBe(
      profile.id,
    );
  });

  it('paginates, filters and projects list/detail responses without secrets', async () => {
    const first = await pending();
    await pending('patient');
    const admin = await adminSession();
    const result = await admin.agent
      .get('/api/v1/registrations?role=doctor&status=pending&limit=1&page=1')
      .expect(200);
    expect(result.body.meta).toEqual({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
    });
    expect(result.body.data[0].id).toBe(first.id);
    expect(result.body.data[0].profile).toBeUndefined();
    const detail = await admin.agent
      .get(`/api/v1/registrations/${first.id}`)
      .expect(200);
    expect(detail.body.data.profile).toEqual(doctorSubmission.profile);
    expect(JSON.stringify(detail.body)).not.toMatch(
      /password|session|searchKeys|__v/,
    );
    expect(
      (await admin.agent.get('/api/v1/registrations?page=10').expect(200)).body
        .data,
    ).toEqual([]);
    for (const query of [
      'limit=101',
      'page=0',
      'role=admin',
      'status=invalid',
      'unknown=value',
      'role=doctor&role=patient',
    ]) {
      await admin.agent.get(`/api/v1/registrations?${query}`).expect(400);
    }
    await admin.agent.get('/api/v1/registrations/invalid').expect(400);
    await admin.agent
      .get(`/api/v1/registrations/${new Types.ObjectId()}`)
      .expect(404);
    const adminUser = await User.findOne({ role: 'admin' });
    await admin.agent.get(`/api/v1/registrations/${adminUser!.id}`).expect(404);
  });
  it.each([
    'anonymous',
    'pending',
    'rejected',
    'disabled',
    'doctor',
    'patient',
  ] as const)('rejects %s registration review and decisions', async (state) => {
    const applicant = await pending('doctor', 'applicant@example.test');
    let agent: ReturnType<typeof request.agent>;
    let token: string;
    if (state === 'anonymous') {
      agent = request.agent(app);
      token = await csrf(agent);
    } else {
      const user =
        state === 'doctor' || state === 'patient' || state === 'disabled'
          ? await active(state === 'disabled' ? 'admin' : state)
          : await pending('patient');
      if (state === 'rejected') {
        user.status = 'rejected';
        await user.save();
      }
      const client = await loginAs(user);
      agent = client.agent;
      token = client.token;
      if (state === 'disabled') {
        user.status = 'disabled';
        await user.save();
      }
    }
    const expected = state === 'anonymous' ? 401 : 403;
    await agent.get('/api/v1/registrations').expect(expected);
    await agent.get(`/api/v1/registrations/${applicant.id}`).expect(expected);
    await agent
      .put(`/api/v1/registrations/${applicant.id}/decision`)
      .set('X-CSRF-Token', token)
      .send(approveNew)
      .expect(expected);
  });
  it.each(['doctor', 'patient'] as const)(
    'creates and activates a %s profile atomically; existing login sees current state',
    async (role) => {
      const user = await pending(role);
      const client = await loginAs(user);
      const admin = await adminSession();
      const result = await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(role === 'doctor' ? approveNew : approvePatient)
        .expect(200);
      const profileId = result.body.data.profileId;
      expect(result.body.data.status).toBe('active');
      const me = await client.agent.get('/api/v1/auth/me').expect(200);
      expect(me.body.data.profileId).toBe(profileId);
      expect(me.body.data.status).toBe('active');
      if (role === 'doctor')
        expect(await Doctor.findById(profileId).lean()).toMatchObject({
          ...doctorInput,
        });
      else
        expect(await Patient.findById(profileId).lean()).toMatchObject({
          condition: 'Reviewed condition',
          status: 'stable',
          revision: 0,
          email: user.email,
        });
      await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(approveNew)
        .expect(409);
    },
  );
  it.each(['doctor', 'patient'] as const)(
    'links an existing matching unclaimed %s without overwriting its data',
    async (role) => {
      const user = await pending(role);
      const profile =
        role === 'doctor'
          ? await Doctor.create({ ...doctorInput, name: 'Existing Doctor' })
          : await Patient.create({
              ...patientInput,
              email: user.email,
              name: 'Existing Patient',
              status: 'critical',
            });
      const admin = await adminSession();
      await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(role === 'doctor' ? approveNew : approvePatient)
        .expect(409);
      const result = await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send({ decision: 'approve', mode: 'link', profileId: profile.id })
        .expect(200);
      expect(result.body.data.profileId).toBe(profile.id);
      expect(
        (await Doctor.countDocuments()) + (await Patient.countDocuments()),
      ).toBe(1);
      if (role === 'patient')
        expect((await Patient.findById(profile.id))!.status).toBe('critical');
    },
  );
  it('requires explicit clinical confirmation for new patients and rejects decision injection', async () => {
    const user = await pending('patient');
    const admin = await adminSession();
    for (const body of [
      approveNew,
      { ...approvePatient, role: 'admin' },
      { ...approvePatient, profileId: new Types.ObjectId().toString() },
      { decision: 'approve', mode: 'link' },
      { decision: 'reject', status: 'active' },
      { ...approveNew, patientClinical: { condition: 'x', status: 'invalid' } },
    ]) {
      await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(body)
        .expect(400);
    }
    expect(await Patient.countDocuments()).toBe(0);
  });
  it.each(['doctor', 'patient'] as const)(
    'rejects mismatched and already claimed %s profiles',
    async (role) => {
      const user = await pending(role);
      const owner = await active(role, '-owner');
      const admin = await adminSession();
      const profileId = (
        role === 'doctor' ? owner.doctorId : owner.patientId
      )!.toString();
      await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send({ decision: 'approve', mode: 'link', profileId })
        .expect(409);
      // Corrupt legacy ownership is still unclaimable even if its profile email matches.
      if (role === 'doctor') {
        const profile = await Doctor.findById(profileId);
        profile!.email = user.email;
        await profile!.save();
      } else {
        const profile = await Patient.findById(profileId);
        profile!.email = user.email;
        await profile!.save();
      }
      await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send({ decision: 'approve', mode: 'link', profileId })
        .expect(409);
      expect((await User.findById(user.id))!.status).toBe('pending');
    },
  );
  it('retains rejected submissions and exposes only the rejection reason to the applicant', async () => {
    const user = await pending();
    const client = await loginAs(user);
    const admin = await adminSession();
    await admin.agent
      .put(`/api/v1/registrations/${user.id}/decision`)
      .set('X-CSRF-Token', admin.token)
      .send({ decision: 'reject', reason: 'Please contact the administrator' })
      .expect(200);
    const me = await client.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.rejectionReason).toBe(
      'Please contact the administrator',
    );
    expect(me.body.data.status).toBe('rejected');
    expect(me.body.data.profileId).toBeNull();
    expect(me.body.data.profile).toBeUndefined();
    expect(
      (await admin.agent.get(`/api/v1/registrations/${user.id}`).expect(200))
        .body.data.profile,
    ).toEqual(doctorSubmission.profile);
    expect(await Doctor.countDocuments()).toBe(0);
  });
  it.each(['approve', 'reject'] as const)(
    'resolves concurrent approve/%s decisions with one winner',
    async (decision) => {
      const user = await pending();
      const admin = await adminSession();
      const responses = await Promise.all([
        admin.agent
          .put(`/api/v1/registrations/${user.id}/decision`)
          .set('X-CSRF-Token', admin.token)
          .send(approveNew),
        admin.agent
          .put(`/api/v1/registrations/${user.id}/decision`)
          .set('X-CSRF-Token', admin.token)
          .send(decision === 'approve' ? approveNew : { decision: 'reject' }),
      ]);
      expect(
        responses.map((result) => result.status).sort(),
        JSON.stringify(responses.map((result) => result.body)),
      ).toEqual([200, 409]);
      expect(await Doctor.countDocuments()).toBe(
        (await User.findById(user.id))!.status === 'active' ? 1 : 0,
      );
    },
  );
  it('rolls back profile creation if the final account write fails', async () => {
    const user = await pending('patient');
    const admin = await adminSession();
    const failure = vi
      .spyOn(User.prototype, 'save')
      .mockRejectedValueOnce(new Error('Sensitive write failure'));
    try {
      const result = await admin.agent
        .put(`/api/v1/registrations/${user.id}/decision`)
        .set('X-CSRF-Token', admin.token)
        .send(approvePatient)
        .expect(500);
      expect(JSON.stringify(result.body)).not.toContain(
        'Sensitive write failure',
      );
    } finally {
      failure.mockRestore();
    }
    expect(await Patient.countDocuments()).toBe(0);
    expect((await User.findById(user.id))!.status).toBe('pending');
  });
});

function protectedProbe() {
  const probe = express();
  probe.use(
    requestContext(logger),
    express.json(),
    ...sessionSecurity(config),
    requireAuthentication,
    requireActiveAccount,
  );
  probe.get('/admin', allowRoles('admin'), (_req, res) =>
    res.json({ data: 'admin' }),
  );
  probe.get('/profile', allowRoles('doctor', 'patient'), async (req, res) =>
    res.json({ data: await ownProfile(req.account!) }),
  );
  probe.get('/patients/:id', async (req, res) => {
    await requirePatientScope(req.account!, req.params.id as string);
    res.json({ data: { id: req.params.id } });
  });
  probe.patch(
    '/patients/:id/clinical',
    allowRoles('admin', 'doctor'),
    async (req, res) => {
      await requirePatientScope(req.account!, req.params.id as string);
      res.status(204).end();
    },
  );
  probe.get('/notes/:id', allowRoles('doctor'), async (req, res) => {
    const scope = await requirePatientScope(
      req.account!,
      req.params.id as string,
    );
    const assignment = await DoctorPatient.findOne({
      doctorId: scope.doctorId!,
      patientId: scope.patientId,
    })
      .select('+privateNote')
      .lean();
    res.json({ data: { note: assignment?.privateNote } });
  });
  probe.use(errorHandler(logger));
  return probe;
}

describe('reusable role, status, identity and assignment access guards', () => {
  it.each([
    'anonymous',
    'pending',
    'rejected',
    'disabled',
    'admin',
    'doctor',
    'patient',
  ] as const)('enforces %s portal access', async (state) => {
    const probe = protectedProbe();
    let sessionCookie = '';
    if (state !== 'anonymous') {
      const user =
        state === 'pending' || state === 'rejected'
          ? await pending()
          : await active(state === 'disabled' ? 'admin' : state);
      if (state === 'rejected') {
        user.status = 'rejected';
        await user.save();
      }
      const client = await loginAs(user);
      sessionCookie = client.cookie;
      if (state === 'disabled') {
        user.status = 'disabled';
        await user.save();
      }
    }
    const get = (path: string) =>
      request(probe).get(path).set('Cookie', sessionCookie);
    await get('/admin').expect(
      state === 'anonymous' ? 401 : state === 'admin' ? 200 : 403,
    );
    await get('/profile').expect(
      state === 'anonymous'
        ? 401
        : state === 'doctor' || state === 'patient'
          ? 200
          : 403,
    );
  });
  it('checks manipulated patient IDs and isolates each doctor private note', async () => {
    const doctor = await active('doctor');
    const other = await active('doctor', '-other');
    const patient = await active('patient');
    const unassigned = await Patient.create(patientInput);
    await DoctorPatient.create({
      doctorId: doctor.doctorId!,
      patientId: patient.patientId!,
      privateNote: 'Own private note',
    });
    await DoctorPatient.create({
      doctorId: other.doctorId!,
      patientId: patient.patientId!,
      privateNote: 'Other doctor secret',
    });
    const docClient = await loginAs(doctor);
    const patientClient = await loginAs(patient);
    const adminClient = await adminSession();
    const probe = protectedProbe();
    const get = (path: string, sessionCookie: string) =>
      request(probe).get(path).set('Cookie', sessionCookie);
    await get(`/patients/${patient.patientId}`, docClient.cookie).expect(200);
    await get(`/patients/${unassigned.id}`, docClient.cookie).expect(404);
    await get(`/patients/${new Types.ObjectId()}`, docClient.cookie).expect(
      404,
    );
    await get('/patients/invalid', docClient.cookie).expect(400);
    await get(`/patients/${patient.patientId}`, patientClient.cookie).expect(
      200,
    );
    await get(`/patients/${unassigned.id}`, patientClient.cookie).expect(404);
    await get(`/patients/${unassigned.id}`, adminClient.cookie).expect(200);
    await request(probe)
      .patch(`/patients/${patient.patientId}/clinical`)
      .set('Cookie', docClient.cookie)
      .set('X-CSRF-Token', docClient.token)
      .expect(204);
    await request(probe)
      .patch(`/patients/${unassigned.id}/clinical`)
      .set('Cookie', docClient.cookie)
      .set('X-CSRF-Token', docClient.token)
      .expect(404);
    await request(probe)
      .patch(`/patients/${patient.patientId}/clinical`)
      .set('Cookie', patientClient.cookie)
      .set('X-CSRF-Token', patientClient.token)
      .expect(403);
    const note = await get(
      `/notes/${patient.patientId}`,
      docClient.cookie,
    ).expect(200);
    expect(note.body.data.note).toBe('Own private note');
    expect(JSON.stringify(note.body)).not.toContain('Other doctor secret');
    await get(`/notes/${patient.patientId}`, patientClient.cookie).expect(403);
    await DoctorPatient.deleteOne({
      doctorId: doctor.doctorId!,
      patientId: patient.patientId!,
    });
    await get(`/patients/${patient.patientId}`, docClient.cookie).expect(404);
  });
  it.each(['doctor', 'patient'] as const)(
    'rechecks %s profile existence and email after login',
    async (role) => {
      const user = await active(role);
      const client = await loginAs(user);
      const probe = protectedProbe();
      const get = () =>
        request(probe).get('/profile').set('Cookie', client.cookie);
      await get().expect(200);
      if (role === 'doctor') {
        const profile = await Doctor.findById(user.doctorId);
        profile!.email = 'changed@example.test';
        await profile!.save();
      } else {
        const profile = await Patient.findById(user.patientId);
        profile!.email = 'changed@example.test';
        await profile!.save();
      }
      await get().expect(403);
      await client.agent.get('/api/v1/auth/me').expect(403);
      if (role === 'doctor') await Doctor.deleteOne({ _id: user.doctorId });
      else await Patient.deleteOne({ _id: user.patientId });
      await get().expect(403);
    },
  );
});

describe('shared authentication throttling', () => {
  it('atomically enforces concurrent registration limits and permits the next window', async () => {
    const agent = request.agent(app);
    const first = await agent.get('/api/v1/auth/csrf').expect(200);
    const token = first.body.data.csrfToken as string;
    const sessionCookie = cookie(first);
    const current = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(current);
    try {
      const results = await Promise.all(
        Array.from({ length: AUTH_LIMITS.registration.limit + 5 }, () =>
          request(app).post('/api/v1/auth/register').set('Cookie', ''),
        ),
      );
      // CSRF failures do not consume attempts.
      expect(results.every((result) => result.status === 403)).toBe(true);
      const attempts = await Promise.all(
        Array.from({ length: AUTH_LIMITS.registration.limit + 5 }, () =>
          request(app)
            .post('/api/v1/auth/register')
            .set('Cookie', sessionCookie)
            .set('X-CSRF-Token', token)
            .send({}),
        ),
      );
      expect(attempts.filter((result) => result.status === 400)).toHaveLength(
        AUTH_LIMITS.registration.limit,
      );
      expect(attempts.filter((result) => result.status === 429)).toHaveLength(
        5,
      );
      clock.mockReturnValue(current + AUTH_LIMITS.registration.windowMs);
      await agent
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', token)
        .send({})
        .expect(400);
    } finally {
      clock.mockRestore();
    }
  });
  it('limits registration by IP and returns a safe error with retry information', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    for (let attempt = 0; attempt < AUTH_LIMITS.registration.limit; attempt++) {
      await agent
        .post('/api/v1/auth/register')
        .set('X-CSRF-Token', token)
        .send({})
        .expect(400);
    }
    const result = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', token)
      .send(doctorSubmission)
      .expect(429);
    expect(result.body.error.code).toBe('RATE_LIMITED');
    expect(Number(result.headers['retry-after'])).toBeGreaterThan(0);
    expect(result.body.error.requestId).toBeTruthy();
    expect(await User.countDocuments()).toBe(0);
  });
  it('limits repeated account/IP logins across recreated applications without storing raw identities', async () => {
    const user = await active('admin');
    const client = await loginAs(user);
    const restarted = createApp({
      config,
      logger,
      isDatabaseReady: async () => true,
    });
    // One successful login has already consumed one attempt.
    for (
      let attempt = 1;
      attempt < AUTH_LIMITS.loginAccountIp.limit;
      attempt++
    ) {
      await request(restarted)
        .post('/api/v1/auth/login')
        .set('Cookie', client.cookie)
        .set('X-CSRF-Token', client.token)
        .send({
          email: ` ${user.email.toUpperCase()} `,
          password: 'incorrect-password',
        })
        .expect(401);
    }
    await client.agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', client.token)
      .send({ email: user.email, password })
      .expect(429);
    const stored = JSON.stringify(await counters().find({}).toArray());
    expect(stored).not.toContain(user.email);
    expect(stored).not.toContain('127.0.0.1');
    expect(stored).not.toContain(password);
  });
  it('limits IP-wide attempts even when email addresses vary', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    for (let attempt = 0; attempt < AUTH_LIMITS.loginIp.limit; attempt++) {
      await agent
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', token)
        .send({ email: `missing${attempt}@example.test`, password: 'short' })
        .expect(400);
    }
    await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', token)
      .send({ email: 'other@example.test', password })
      .expect(429);
  });
});
