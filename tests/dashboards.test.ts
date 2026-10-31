import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config/environment.js';
import { connectDatabase } from '../src/database/connection.js';
import { setupIndexes } from '../src/database/indexes.js';
import { createLogger } from '../src/logging/logger.js';
import { User } from '../src/modules/auth/user.model.js';
import { Doctor } from '../src/modules/doctors/doctor.model.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { DoctorPatient } from '../src/modules/assignments/doctor-patient.model.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { doctorInput, patientInput, validEnvironment } from './fixtures.js';
import {
  dashboardRange,
  zeroFill,
} from '../src/modules/dashboards/dashboard.time.js';
import {
  dashboardQuerySchema,
  dashboardResponseSchema,
} from '../src/modules/dashboards/dashboard.schemas.js';
import { filterResponseSchema } from '../src/modules/dashboards/filter.schemas.js';
import { createOpenApiDocument } from '../src/http/openapi.js';
import { Script } from 'node:vm';

let replica: MongoMemoryReplSet;
let disconnect: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let config: ReturnType<typeof parseEnvironment>;
let passwordHash: string;
const password = 'synthetic-dashboard-password';
const logger = createLogger('silent');
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
  passwordHash = await hashPassword(password);
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Doctor.deleteMany({}),
    Patient.deleteMany({}),
    DoctorPatient.deleteMany({}),
    mongoose.connection.collection('sessions').deleteMany({}),
    mongoose.connection.collection('authRateLimits').deleteMany({}),
  ]);
  app = createApp({ config, logger, isDatabaseReady: async () => true });
});
afterAll(async () => {
  await disconnect?.();
  await replica?.stop();
});
async function login(
  role: 'admin' | 'doctor' | 'patient',
  suffix = '',
  status: 'active' | 'pending' | 'rejected' = 'active',
) {
  const email = `${role}${suffix}@example.test`;
  const profile =
    status !== 'active'
      ? null
      : role === 'doctor'
        ? await Doctor.create({ ...doctorInput, email })
        : role === 'patient'
          ? await Patient.create({ ...patientInput, email })
          : null;
  const user = await User.create({
    name: `Example ${role}`,
    email,
    passwordHash,
    role,
    status,
    ...(profile
      ? role === 'doctor'
        ? { doctorId: profile._id }
        : { patientId: profile._id }
      : {}),
    ...(status !== 'active'
      ? {
          pendingRegistration:
            role === 'patient'
              ? {
                  patient: {
                    dateOfBirth: '1995-02-28',
                    gender: 'undisclosed',
                    phone: '123',
                  },
                }
              : {
                  doctor: {
                    specialization: 'Cardiology',
                    hospital: 'Example Hospital',
                    phone: '123',
                  },
                },
        }
      : {}),
  });
  const agent = request.agent(app);
  const csrf = await agent.get('/api/v1/auth/csrf');
  await agent
    .post('/api/v1/auth/login')
    .set('X-CSRF-Token', csrf.body.data.csrfToken)
    .send({ email, password })
    .expect(200);
  return { agent, user, profile, id: profile?._id.toString() ?? '' };
}
async function link(
  doctorId: string,
  patientId: string,
  assignedAt = new Date(),
) {
  return DoctorPatient.create({
    doctorId,
    patientId,
    assignedAt,
    privateNote: 'HIDDEN PRIVATE NOTE',
    noteRevision: 1,
  });
}
const range = '?from=2026-10-01&to=2026-10-31';
describe('dashboard calendar contract', () => {
  it('defaults to thirty inclusive Dhaka calendar days', () => {
    expect(dashboardRange({}, new Date('2026-10-31T18:01:00Z'))).toEqual({
      from: '2026-10-03',
      to: '2026-11-01',
      interval: 'day',
      timezone: 'Asia/Dhaka',
    });
    expect(dashboardRange({ to: '2026-03-01' })?.from).toBe('2026-01-31');
    const upper = dashboardRange({ from: '9999-12-01', to: '9999-12-31' })!;
    expect(zeroFill(upper, [])).toHaveLength(31);
    const upperMonthly = dashboardRange({
      from: '9999-01-01',
      to: '9999-12-31',
    })!;
    expect(zeroFill(upperMonthly, [])).toHaveLength(12);
  });
  it('switches after ninety days and fills partial months including leap day', () => {
    expect(
      dashboardRange({ from: '2026-01-01', to: '2026-03-31' })?.interval,
    ).toBe('day');
    const monthly = dashboardRange({ from: '2024-01-31', to: '2024-04-30' })!;
    expect(monthly.interval).toBe('month');
    expect(zeroFill(monthly, [{ _id: '2024-03-01', count: 3 }])).toEqual([
      { date: '2024-01-01', count: 0 },
      { date: '2024-02-01', count: 0 },
      { date: '2024-03-01', count: 3 },
      { date: '2024-04-01', count: 0 },
    ]);
    expect(
      dashboardQuerySchema.safeParse({ from: '2025-01-01', to: '2025-12-31' })
        .success,
    ).toBe(true);
  });
  it.each([
    { from: '2026-10-31', to: '2026-10-30' },
    { from: '2024-01-01', to: '2024-12-31' },
    { from: '2026-02-30' },
    { to: 'abc' },
    { from: '0000-01-01' },
    { doctorId: 'other' },
    { from: ['2026-01-01'] },
  ])('rejects invalid or oversized ranges %j', (query) => {
    expect(dashboardQuerySchema.safeParse(query).success).toBe(false);
  });
});
describe('role-scoped dashboards', () => {
  it('returns zero-filled empty admin and doctor dashboards', async () => {
    const admin = await login('admin');
    const empty = await admin.agent
      .get(`/api/v1/dashboard${range}`)
      .expect(200);
    expect(dashboardResponseSchema.safeParse(empty.body).success).toBe(true);
    expect(empty.headers['cache-control']).toBe('private, no-store');
    expect(empty.body.data).toMatchObject({
      role: 'admin',
      totalDoctors: 0,
      totalPatients: 0,
      patientsPerDoctor: [],
    });
    expect(empty.body.data.patientCreationTrend).toHaveLength(31);
    expect(
      empty.body.data.patientCreationTrend.every(
        (bucket: { count: number }) => bucket.count === 0,
      ),
    ).toBe(true);
    const doctor = await login('doctor');
    const result = await doctor.agent
      .get(`/api/v1/dashboard${range}`)
      .expect(200);
    expect(result.body.data).toMatchObject({
      role: 'doctor',
      assignedPatientCount: 0,
      recentAssignments: [],
    });
    expect(dashboardResponseSchema.safeParse(result.body).success).toBe(true);
  });
  it('counts shared patients once and includes doctors without patients', async () => {
    const admin = await login('admin');
    const first = await login('doctor', '1');
    const second = await login('doctor', '2');
    const zero = await Doctor.create({
      ...doctorInput,
      email: 'zero@example.test',
    });
    const patient = await Patient.create({
      ...patientInput,
      status: 'critical',
    });
    await Patient.create({
      ...patientInput,
      name: 'Unassigned',
      status: 'stable',
    });
    await link(first.id, patient.id);
    await link(second.id, patient.id);
    const result = await admin.agent
      .get(`/api/v1/dashboard${range}`)
      .expect(200);
    expect(result.body.data).toMatchObject({
      totalDoctors: 3,
      totalPatients: 2,
    });
    expect(
      result.body.data.patientsPerDoctor.map(
        (item: { patientCount: number }) => item.patientCount,
      ),
    ).toEqual([1, 1, 0]);
    expect(result.body.data.patientsPerDoctor[2].doctorId).toBe(zero.id);
    expect(result.body.data.patientStatusDistribution).toContainEqual({
      status: 'critical',
      count: 1,
    });
    expect(result.body.data.patientStatusDistribution).toContainEqual({
      status: 'unassessed',
      count: 0,
    });
    expect(dashboardResponseSchema.safeParse(result.body).success).toBe(true);
    expect(JSON.stringify(result.body)).not.toMatch(
      /HIDDEN|privateNote|passwordHash|searchKeys/,
    );
  });
  it('uses inclusive Dhaka boundaries, zero days and partial monthly totals', async () => {
    const admin = await login('admin');
    for (const instant of [
      '2026-09-30T17:59:59Z',
      '2026-09-30T18:00:00Z',
      '2026-10-31T17:59:59.999Z',
      '2026-10-31T18:00:00Z',
    ]) {
      await new Patient({
        ...patientInput,
        createdAt: new Date(instant),
        updatedAt: new Date(instant),
      }).save();
    }
    const result = await admin.agent
      .get(`/api/v1/dashboard${range}`)
      .expect(200);
    expect(result.body.data.totalPatients).toBe(4);
    expect(result.body.data.patientCreationTrend[0]).toEqual({
      date: '2026-10-01',
      count: 1,
    });
    expect(result.body.data.patientCreationTrend[30]).toEqual({
      date: '2026-10-31',
      count: 1,
    });
    expect(result.body.data.patientCreationTrend[1].count).toBe(0);
    const monthly = await admin.agent
      .get('/api/v1/dashboard?from=2026-07-31&to=2026-10-31')
      .expect(200);
    expect(monthly.body.data.range.interval).toBe('month');
    expect(monthly.body.data.patientCreationTrend).toEqual([
      { date: '2026-07-01', count: 0 },
      { date: '2026-08-01', count: 0 },
      { date: '2026-09-01', count: 1 },
      { date: '2026-10-01', count: 2 },
    ]);
  });
  it('scopes doctor totals, recent records and trends to current assignments', async () => {
    const doctor = await login('doctor');
    const other = await login('doctor', 'other');
    const patient = await Patient.create({
      ...patientInput,
      status: 'critical',
    });
    const hidden = await Patient.create({
      ...patientInput,
      name: 'HIDDEN PATIENT',
      status: 'recovered',
    });
    const assignment = await link(
      doctor.id,
      patient.id,
      new Date('2026-10-04T18:00:00Z'),
    );
    await link(other.id, hidden.id);
    await link(other.id, patient.id);
    const result = await doctor.agent
      .get(`/api/v1/dashboard${range}`)
      .expect(200);
    expect(result.body.data.assignedPatientCount).toBe(1);
    expect(result.body.data.patientStatusDistribution).toContainEqual({
      status: 'critical',
      count: 1,
    });
    expect(result.body.data.patientStatusDistribution).toContainEqual({
      status: 'recovered',
      count: 0,
    });
    expect(result.body.data.assignmentTrend[4]).toEqual({
      date: '2026-10-05',
      count: 1,
    });
    expect(result.body.data.recentAssignments).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toMatch(
      /HIDDEN|privateNote|noteRevision/,
    );
    expect(dashboardResponseSchema.safeParse(result.body).success).toBe(true);
    await assignment.deleteOne();
    const after = await doctor.agent
      .get(`/api/v1/dashboard${range}`)
      .expect(200);
    expect(after.body.data.assignedPatientCount).toBe(0);
    expect(
      after.body.data.assignmentTrend.every(
        (bucket: { count: number }) => bucket.count === 0,
      ),
    ).toBe(true);
  });
  it('returns only own patient clinical fields and bounded linked-doctor summaries', async () => {
    const patient = await login('patient');
    const record = await Patient.findById(patient.id);
    record!.lastClinicalUpdateAt = new Date('2026-10-30T12:00:00Z');
    await record!.save();
    for (let index = 0; index < 12; index += 1) {
      const doctor = await Doctor.create({
        ...doctorInput,
        email: `summary${index}@example.test`,
      });
      await link(doctor.id, patient.id);
    }
    await Patient.create({
      ...patientInput,
      name: 'HIDDEN PATIENT',
      condition: 'HIDDEN CONDITION',
    });
    const result = await patient.agent.get('/api/v1/dashboard').expect(200);
    expect(result.body.data).toMatchObject({
      role: 'patient',
      patient: {
        id: patient.id,
        condition: patientInput.condition,
        status: 'unassessed',
        lastClinicalUpdateAt: '2026-10-30T12:00:00.000Z',
      },
      linkedDoctorCount: 12,
    });
    expect(result.body.data.linkedDoctors).toHaveLength(10);
    expect(dashboardResponseSchema.safeParse(result.body).success).toBe(true);
    expect(JSON.stringify(result.body)).not.toMatch(
      /HIDDEN|privateNote|noteRevision|email|phone|totalPatients/,
    );
  });
  it('bounds top ten and recent assignments with deterministic count ties', async () => {
    const admin = await login('admin');
    const doctor = await login('doctor');
    for (let index = 0; index < 11; index += 1) {
      await Doctor.create({
        ...doctorInput,
        email: `top${index}@example.test`,
      });
      const patient = await Patient.create({ ...patientInput });
      await link(doctor.id, patient.id, new Date(1_790_000_000_000 + index));
    }
    const result = await admin.agent.get('/api/v1/dashboard').expect(200);
    expect(result.body.data.patientsPerDoctor).toHaveLength(10);
    expect(result.body.data.patientsPerDoctor[0]).toMatchObject({
      doctorId: doctor.id,
      patientCount: 11,
    });
    const ties = result.body.data.patientsPerDoctor
      .slice(1)
      .map((item: { doctorId: string }) => item.doctorId);
    expect(ties).toEqual([...ties].sort());
    const recent = await doctor.agent.get('/api/v1/dashboard').expect(200);
    expect(recent.body.data.recentAssignments).toHaveLength(10);
    expect(
      recent.body.data.recentAssignments[0].assignedAt >
        recent.body.data.recentAssignments[9].assignedAt,
    ).toBe(true);
  });
});
describe('scoped filter option lookup', () => {
  it('normalizes, deduplicates, sorts and paginates all admin fields', async () => {
    const admin = await login('admin');
    await Doctor.create({
      ...doctorInput,
      specialization: ' CARDIOLOGY ',
      hospital: 'Hospital B',
    });
    await Doctor.create({
      ...doctorInput,
      email: 'second@example.test',
      specialization: 'cardiology',
      hospital: 'Hospital A',
    });
    await Doctor.create({
      ...doctorInput,
      email: 'third@example.test',
      specialization: 'Neurology',
    });
    await Patient.create({
      ...patientInput,
      condition: ' ROUTINE   OBSERVATION ',
      status: 'stable',
    });
    await Patient.create({
      ...patientInput,
      condition: 'routine observation',
      status: 'critical',
    });
    const specs = await admin.agent
      .get('/api/v1/filters?field=specialization&limit=1&page=2')
      .expect(200);
    expect(specs.body).toEqual({
      data: [{ value: 'neurology', label: 'neurology' }],
      meta: { page: 2, limit: 1, total: 2, totalPages: 2 },
    });
    const conditions = await admin.agent.get('/api/v1/filters').expect(200);
    expect(conditions.body.data).toEqual([
      { value: 'routine observation', label: 'routine observation' },
    ]);
    expect(filterResponseSchema.safeParse(conditions.body).success).toBe(true);
    const hospitals = await admin.agent
      .get('/api/v1/filters?field=hospital&search=HOSPITAL')
      .expect(200);
    expect(
      hospitals.body.data.map((item: { value: string }) => item.value),
    ).toEqual(['hospital a', 'hospital b']);
    const statuses = await admin.agent
      .get('/api/v1/filters?field=status')
      .expect(200);
    expect(
      statuses.body.data.map((item: { value: string }) => item.value),
    ).toEqual(['critical', 'stable']);
  });
  it('does not reveal unassigned/other doctors’ filter values or totals', async () => {
    const doctor = await login('doctor');
    const other = await login('doctor', 'other');
    const visible = await Patient.create({
      ...patientInput,
      condition: 'Visible',
      status: 'stable',
    });
    const hidden = await Patient.create({
      ...patientInput,
      condition: 'HIDDEN',
      status: 'critical',
    });
    await link(doctor.id, visible.id);
    await link(other.id, hidden.id);
    await link(other.id, visible.id);
    const result = await doctor.agent.get('/api/v1/filters').expect(200);
    expect(result.body.data).toEqual([{ value: 'visible', label: 'visible' }]);
    expect(result.body.meta.total).toBe(1);
    const statuses = await doctor.agent
      .get('/api/v1/filters?field=status')
      .expect(200);
    expect(statuses.body.data).toEqual([{ value: 'stable', label: 'stable' }]);
    const hiddenSearch = await doctor.agent
      .get('/api/v1/filters?search=hidden')
      .expect(200);
    expect(hiddenSearch.body.meta.total).toBe(0);
    await DoctorPatient.deleteMany({ doctorId: doctor.id });
    const empty = await doctor.agent.get('/api/v1/filters').expect(200);
    expect(empty.body).toEqual({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    await doctor.agent.get('/api/v1/filters?field=hospital').expect(403);
    await doctor.agent.get('/api/v1/filters?field=specialization').expect(403);
  });
  it('escapes regex search and bounds option lists', async () => {
    const admin = await login('admin');
    for (let index = 0; index < 105; index += 1)
      await Patient.create({
        ...patientInput,
        condition: `Option ${String(index).padStart(3, '0')}`,
      });
    await Patient.create({ ...patientInput, condition: 'A.* literal' });
    const literal = await admin.agent
      .get('/api/v1/filters?search=A.*')
      .expect(200);
    expect(literal.body.data).toEqual([
      { value: 'a.* literal', label: 'a.* literal' },
    ]);
    const first = await admin.agent
      .get('/api/v1/filters?limit=100')
      .expect(200);
    expect(first.body.data).toHaveLength(100);
    expect(first.body.meta.total).toBe(106);
    const later = await admin.agent
      .get('/api/v1/filters?limit=100&page=2')
      .expect(200);
    expect(later.body.data).toHaveLength(6);
    for (const query of [
      'limit=101',
      'field=doctorId',
      'page=0',
      'doctorId=other',
      'search[$regex]=.*',
    ])
      await admin.agent.get(`/api/v1/filters?${query}`).expect(400);
  });
});
describe('analytics and documentation access', () => {
  const paths = [
    '/dashboard',
    '/filters',
    '/docs',
    '/docs/openapi.json',
    '/docs/app.js',
    '/docs/style.css',
  ];
  it('denies anonymous sessions on all protected resources', async () => {
    for (const path of paths)
      await request(app).get(`/api/v1${path}`).expect(401);
  });
  it.each([
    ['doctor', 'pending'],
    ['doctor', 'rejected'],
    ['patient', 'pending'],
    ['patient', 'rejected'],
  ] as const)(
    'denies %s %s accounts on all resources',
    async (role, status) => {
      const account = await login(role, status, status);
      for (const path of paths)
        await account.agent.get(`/api/v1${path}`).expect(403);
    },
  );
  it.each(['admin', 'doctor', 'patient'] as const)(
    'denies a disabled %s session on every protected resource',
    async (role) => {
      const account = await login(role);
      account.user.status = 'disabled';
      await account.user.save();
      for (const path of paths)
        await account.agent.get(`/api/v1${path}`).expect(403);
    },
  );
  it('checks current status and profile existence on every request', async () => {
    const doctor = await login('doctor');
    await doctor.agent.get('/api/v1/dashboard').expect(200);
    await Doctor.deleteOne({ _id: doctor.id });
    await doctor.agent.get('/api/v1/dashboard').expect(403);
    await doctor.agent.get('/api/v1/filters').expect(403);
    const admin = await login('admin');
    admin.user.status = 'disabled';
    await admin.user.save();
    for (const path of paths)
      await admin.agent.get(`/api/v1${path}`).expect(403);
  });
  it('denies patient filters, doctor/patient docs and identity injection', async () => {
    for (const role of ['doctor', 'patient'] as const) {
      const account = await login(role);
      for (const path of paths.filter((path) => path.startsWith('/docs')))
        await account.agent.get(`/api/v1${path}`).expect(403);
      await account.agent.get('/api/v1/dashboard?patientId=other').expect(400);
      if (role === 'patient')
        await account.agent.get('/api/v1/filters').expect(403);
    }
  });
  it('serves admin-only interactive docs and the identical contract with CSP and no-store', async () => {
    const admin = await login('admin');
    const docs = await admin.agent.get('/api/v1/docs').expect(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.headers['cache-control']).toBe('private, no-store');
    expect(docs.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
    expect(docs.text).toContain('Send request');
    const js = await admin.agent.get('/api/v1/docs/app.js').expect(200);
    expect(() => new Script(js.text)).not.toThrow();
    expect(js.text).toContain('X-CSRF-Token');
    await admin.agent.get('/api/v1/docs/style.css').expect(200);
    const spec = await admin.agent.get('/api/v1/docs/openapi.json').expect(200);
    expect(spec.body).toEqual(createOpenApiDocument());
  });
});
