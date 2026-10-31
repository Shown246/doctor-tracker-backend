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
import { parseEnvironment } from '../src/config/environment.js';
import { connectDatabase } from '../src/database/connection.js';
import { setupIndexes } from '../src/database/indexes.js';
import { createLogger } from '../src/logging/logger.js';
import { User } from '../src/modules/auth/user.model.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { Doctor } from '../src/modules/doctors/doctor.model.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { DoctorPatient } from '../src/modules/assignments/doctor-patient.model.js';
import { doctorInput, patientInput, validEnvironment } from './fixtures.js';
import {
  listFilter,
  listQuerySchema,
  listSort,
} from '../src/http/list-query.js';
import { managementSchemas } from '../src/http/management-openapi.js';

const logger = createLogger('silent');
const password = 'synthetic-management-password';
let replica: MongoMemoryReplSet;
let disconnect: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let config: ReturnType<typeof parseEnvironment>;
let storedHash: string;
const missing = () => new Types.ObjectId().toString();
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
    mongoose.connection.collection('sessions').deleteMany({}),
    mongoose.connection.collection('authRateLimits').deleteMany({}),
  ]);
  app = createApp({ config, logger, isDatabaseReady: async () => true });
});
afterAll(async () => {
  await disconnect?.();
  await replica?.stop();
});
async function login(role: 'admin' | 'doctor' | 'patient', suffix = '') {
  const email = `${role}${suffix}@example.test`;
  const profile =
    role === 'doctor'
      ? await Doctor.create({ ...doctorInput, email })
      : role === 'patient'
        ? await Patient.create({ ...patientInput, email })
        : null;
  const user = await User.create({
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
  const agent = request.agent(app);
  const initial = await agent.get('/api/v1/auth/csrf');
  await agent
    .post('/api/v1/auth/login')
    .set('X-CSRF-Token', initial.body.data.csrfToken)
    .send({ email, password })
    .expect(200);
  const token = (await agent.get('/api/v1/auth/csrf')).body.data
    .csrfToken as string;
  return { agent, token, user, profile, id: profile?._id.toString() ?? '' };
}

describe('shared list validation', () => {
  it('uses historical Dhaka timezone rules and calendar days across offset transitions', () => {
    expect(
      listFilter(
        listQuerySchema.parse({ from: '2009-06-20', to: '2009-06-20' }),
      ),
    ).toEqual({
      createdAt: {
        $gte: new Date('2009-06-19T17:00:00Z'),
        $lt: new Date('2009-06-20T17:00:00Z'),
      },
    });
    expect(
      listFilter(
        listQuerySchema.parse({ from: '2009-12-31', to: '2009-12-31' }),
      ),
    ).toEqual({
      createdAt: {
        $gte: new Date('2009-12-30T17:00:00Z'),
        $lt: new Date('2009-12-31T18:00:00Z'),
      },
    });
  });
  it('defaults pagination, escapes literal search and uses stable sorting', () => {
    expect(listQuerySchema.parse({})).toMatchObject({
      page: 1,
      limit: 20,
      sort: '-createdAt',
    });
    expect(listSort(listQuerySchema.parse({ sort: 'name' }))).toEqual({
      nameKey: 1,
      _id: 1,
    });
    const regex = listFilter(listQuerySchema.parse({ search: ' A.* (B) ' }))
      .searchKeys as RegExp;
    expect(regex.test('a.* (b) suffix')).toBe(true);
    expect(regex.test('anything b')).toBe(false);
  });
  it.each([
    { page: '' },
    { page: '0' },
    { page: '1.5' },
    { page: ['1'] },
    { limit: '101' },
    { limit: '-1' },
    { sort: '$where' },
    { from: '2025-02-29' },
    { to: '2025-02-30' },
    { from: '2025-02-02', to: '2025-02-01' },
    { $where: 'true' },
  ])('rejects malformed query %j', (query) => {
    expect(listQuerySchema.safeParse(query).success).toBe(false);
  });
  it('uses inclusive Dhaka days and an exclusive next-day boundary', () => {
    expect(
      listFilter(
        listQuerySchema.parse({ from: '2026-10-31', to: '2026-10-31' }),
      ),
    ).toEqual({
      createdAt: {
        $gte: new Date('2026-10-30T18:00:00Z'),
        $lt: new Date('2026-10-31T18:00:00Z'),
      },
    });
  });
});

describe('admin doctor management', () => {
  it('creates, reads and edits normalized profiles and derived search keys', async () => {
    const admin = await login('admin');
    const result = await admin.agent
      .post('/api/v1/doctors')
      .set('X-CSRF-Token', admin.token)
      .send({ ...doctorInput, email: ' NEW@EXAMPLE.TEST ' })
      .expect(201);
    const id = result.body.data.id as string;
    managementSchemas.DoctorResponse.parse(result.body);
    expect(result.body.data.email).toBe('new@example.test');
    expect(result.body.data).not.toHaveProperty('searchKeys');
    await admin.agent.get(`/api/v1/doctors/${id}`).expect(200);
    await admin.agent
      .patch(`/api/v1/doctors/${id}`)
      .set('X-CSRF-Token', admin.token)
      .send({ name: 'Dr Changed', specialization: 'Neurology' })
      .expect(200);
    expect(
      (await Doctor.findById(id).select('+nameKey +searchKeys'))!.searchKeys,
    ).toContain('neurology');
    await admin.agent
      .post('/api/v1/doctors')
      .set('X-CSRF-Token', admin.token)
      .send({ ...doctorInput, email: 'new@example.test' })
      .expect(409);
    for (const input of [
      {},
      { role: 'admin' },
      { nameKey: 'inject' },
      { email: 'bad' },
      { phone: '' },
    ])
      await admin.agent
        .patch(`/api/v1/doctors/${id}`)
        .set('X-CSRF-Token', admin.token)
        .send(input)
        .expect(400);
    await admin.agent.get(`/api/v1/doctors/${missing()}`).expect(404);
    await admin.agent.get('/api/v1/doctors/invalid').expect(400);
  });
  it('prevents linked email changes and requires admin, active sessions and CSRF', async () => {
    const admin = await login('admin');
    const doctor = await login('doctor');
    await admin.agent
      .patch(`/api/v1/doctors/${doctor.id}`)
      .set('X-CSRF-Token', admin.token)
      .send({ email: 'changed@example.test' })
      .expect(409);
    await admin.agent
      .patch(`/api/v1/doctors/${doctor.id}`)
      .set('X-CSRF-Token', admin.token)
      .send({ email: doctor.user.email })
      .expect(200);
    await request(app).get('/api/v1/doctors').expect(401);
    await doctor.agent.get('/api/v1/doctors').expect(403);
    await admin.agent.post('/api/v1/doctors').send(doctorInput).expect(403);
  });
  it('combines filters and returns paginated counts including zero, using a grouped query', async () => {
    const admin = await login('admin');
    const a = await Doctor.create({ ...doctorInput, name: 'Dr Alpha' });
    await Doctor.create({
      ...doctorInput,
      email: 'b@example.test',
      name: 'Dr Beta',
    });
    await Doctor.create({
      ...doctorInput,
      email: 'c@example.test',
      name: 'Dr Gamma',
      hospital: 'Other',
    });
    const patient = await Patient.create(patientInput);
    await DoctorPatient.create({ doctorId: a._id, patientId: patient._id });
    const spy = vi.spyOn(DoctorPatient, 'aggregate');
    const result = await admin.agent
      .get('/api/v1/doctors')
      .query({
        hospital: 'EXAMPLE HOSPITAL',
        specialization: 'cardiology',
        search: 'dr',
        sort: 'name',
        limit: 1,
        page: 2,
      })
      .expect(200);
    expect(result.body.meta).toEqual({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    managementSchemas.DoctorListResponse.parse(result.body);
    expect(result.body.data[0]).toMatchObject({
      name: 'Dr Beta',
      patientCount: 0,
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(
      (await admin.agent.get('/api/v1/doctors').query({ search: 'alpha' })).body
        .data[0].patientCount,
    ).toBe(1);
    expect(
      (await admin.agent.get('/api/v1/doctors').query({ search: '.*' })).body
        .meta.total,
    ).toBe(0);
    expect(
      (await admin.agent.get('/api/v1/doctors').query({ page: 99 })).body.data,
    ).toEqual([]);
  });
});

describe('admin patient management', () => {
  it('atomically creates zero, one and multiple deduplicated assignments', async () => {
    const admin = await login('admin');
    const a = await Doctor.create(doctorInput);
    const b = await Doctor.create({
      ...doctorInput,
      email: 'second@example.test',
    });
    for (const doctorIds of [[], [a.id], [a.id, b.id, a.id.toUpperCase()]]) {
      const result = await admin.agent
        .post('/api/v1/patients')
        .set('X-CSRF-Token', admin.token)
        .send({ ...patientInput, doctorIds })
        .expect(201);
      expect(
        await DoctorPatient.countDocuments({ patientId: result.body.data.id }),
      ).toBe(new Set(doctorIds.map((id) => id.toLowerCase())).size);
    }
    await admin.agent
      .post('/api/v1/patients')
      .set('X-CSRF-Token', admin.token)
      .send({ ...patientInput, doctorIds: [a.id, missing()] })
      .expect(404);
    expect(await Patient.countDocuments()).toBe(3);
    const spy = vi
      .spyOn(DoctorPatient.prototype, 'save')
      .mockRejectedValueOnce(new Error('synthetic failure'));
    await admin.agent
      .post('/api/v1/patients')
      .set('X-CSRF-Token', admin.token)
      .send({ ...patientInput, doctorIds: [a.id] })
      .expect(500);
    spy.mockRestore();
    expect(await Patient.countDocuments()).toBe(3);
    expect(await DoctorPatient.countDocuments()).toBe(3);
  });
  it('validates demographics, optional emails and strict editable fields', async () => {
    const admin = await login('admin');
    for (const extra of [
      { dateOfBirth: '2025-02-29' },
      { dateOfBirth: '2999-01-01' },
      { gender: 'invalid' },
      { status: 'invalid' },
      { email: 'bad' },
      { doctorIds: ['bad'] },
      { revision: 99 },
    ])
      await admin.agent
        .post('/api/v1/patients')
        .set('X-CSRF-Token', admin.token)
        .send({ ...patientInput, ...extra })
        .expect(400);
    const created = await admin.agent
      .post('/api/v1/patients')
      .set('X-CSRF-Token', admin.token)
      .send({ ...patientInput, email: ' OPTIONAL@EXAMPLE.TEST ' })
      .expect(201);
    const id = created.body.data.id as string;
    await admin.agent
      .post('/api/v1/patients')
      .set('X-CSRF-Token', admin.token)
      .send({ ...patientInput, email: 'optional@example.test' })
      .expect(409);
    for (const body of [
      {},
      { doctorIds: [] },
      { lastClinicalEditor: missing() },
      { role: 'admin' },
      { condition: 'Edited' },
      { revision: 0 },
      { revision: 0, $set: { name: 'Injection' } },
    ])
      await admin.agent
        .patch(`/api/v1/patients/${id}`)
        .set('X-CSRF-Token', admin.token)
        .send(body)
        .expect(400);
    const edited = await admin.agent
      .patch(`/api/v1/patients/${id}`)
      .set('X-CSRF-Token', admin.token)
      .send({
        condition: 'Reviewed',
        status: 'stable',
        revision: 0,
        email: null,
        address: '',
      })
      .expect(200);
    expect(edited.body.data).toMatchObject({
      condition: 'Reviewed',
      status: 'stable',
      revision: 1,
    });
    expect(edited.body.data.email).toBeUndefined();
    expect((await Patient.findById(id))!.lastClinicalEditor?.toString()).toBe(
      admin.user.id,
    );
    await admin.agent
      .patch(`/api/v1/patients/${id}`)
      .set('X-CSRF-Token', admin.token)
      .send({ condition: 'Stale', revision: 0 })
      .expect(409);
    const patient = await login('patient');
    await admin.agent
      .patch(`/api/v1/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .send({ email: null })
      .expect(409);
    await patient.agent.get(`/api/v1/patients/${patient.id}`).expect(403);
    await admin.agent.get(`/api/v1/patients/${missing()}`).expect(404);
    await admin.agent
      .patch(`/api/v1/patients/${missing()}`)
      .set('X-CSRF-Token', admin.token)
      .send({ name: 'Missing' })
      .expect(404);
  });
  it('applies all list filters before pagination and returns safe linked-doctor detail', async () => {
    const admin = await login('admin');
    const a = await Doctor.create(doctorInput);
    const b = await Doctor.create({ ...doctorInput, email: 'b@example.test' });
    const patient = await Patient.create({ ...patientInput, status: 'stable' });
    await Patient.create({ ...patientInput, name: 'Unassigned' });
    await DoctorPatient.create({
      doctorId: a.id,
      patientId: patient.id,
      privateNote: 'secret a',
    });
    await DoctorPatient.create({
      doctorId: b.id,
      patientId: patient.id,
      privateNote: 'secret b',
    });
    const result = await admin.agent
      .get('/api/v1/patients')
      .query({
        doctorId: a.id,
        status: 'stable',
        condition: 'ROUTINE OBSERVATION',
        search: 'observation',
        sort: 'name',
        limit: '1',
      })
      .expect(200);
    expect(result.body.meta.total).toBe(1);
    expect(result.body.data[0].id).toBe(patient.id);
    const detail = await admin.agent
      .get(`/api/v1/patients/${patient.id}`)
      .expect(200);
    managementSchemas.PatientDetailResponse.parse(detail.body);
    expect(detail.body.data.linkedDoctors).toHaveLength(2);
    expect(detail.body.data.linkedDoctorCount).toBe(2);
    const secondPage = await admin.agent
      .get(`/api/v1/patients/${patient.id}`)
      .query({ page: 2, limit: 1 })
      .expect(200);
    expect(secondPage.body.data.linkedDoctors).toHaveLength(1);
    expect(secondPage.body.data.linkedDoctorsMeta).toEqual({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(JSON.stringify(detail.body)).not.toContain('secret');
    expect(JSON.stringify(result.body)).not.toContain('searchKeys');
    await admin.agent
      .get('/api/v1/patients')
      .query({ doctorId: '$ne' })
      .expect(400);
  });
  it('honors Dhaka creation-date boundaries and deterministic tie ordering', async () => {
    const admin = await login('admin');
    const records = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        Patient.create({ ...patientInput, name: `Boundary ${index}` }),
      ),
    );
    const dates = [
      '2026-10-30T17:59:59.999Z',
      '2026-10-30T18:00:00.000Z',
      '2026-10-31T17:59:59.999Z',
      '2026-10-31T18:00:00.000Z',
    ];
    for (const [index, record] of records.entries())
      await Patient.collection.updateOne(
        { _id: record._id },
        { $set: { createdAt: new Date(dates[index]!) } },
      );
    const result = await admin.agent
      .get('/api/v1/patients')
      .query({ from: '2026-10-31', to: '2026-10-31', sort: 'createdAt' })
      .expect(200);
    expect(result.body.data.map((item: { name: string }) => item.name)).toEqual(
      ['Boundary 1', 'Boundary 2'],
    );
    for (const record of records)
      await Patient.collection.updateOne(
        { _id: record._id },
        { $set: { createdAt: new Date(dates[1]!) } },
      );
    const tied = await admin.agent
      .get('/api/v1/patients')
      .query({ sort: 'createdAt', limit: 2, page: 2 })
      .expect(200);
    expect(tied.body.data.map((item: { id: string }) => item.id)).toEqual(
      records
        .map((item) => item.id)
        .sort()
        .slice(2),
    );
  });
});

describe('assignment, clinical and note workflows', () => {
  it('completes create, link, edit, note, unlink, relink and permanent deletion', async () => {
    const admin = await login('admin');
    const a = await login('doctor');
    const b = await login('doctor', 'b');
    const patient = await login('patient');
    const pair = `/api/v1/doctors/${a.id}/patients/${patient.id}`;
    const own = `/api/v1/me/patients/${patient.id}`;
    await a.agent.get(own).expect(404);
    await admin.agent
      .put(pair)
      .set('X-CSRF-Token', admin.token)
      .send({})
      .expect(200);
    await admin.agent.put(pair).set('X-CSRF-Token', admin.token).expect(200);
    await admin.agent
      .put(`/api/v1/doctors/${b.id}/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .expect(200);
    expect(await DoctorPatient.countDocuments()).toBe(2);
    expect((await a.agent.get('/api/v1/me/patients')).body.meta.total).toBe(1);
    expect((await a.agent.get(own)).body.data.age).toBeGreaterThan(0);
    expect((await a.agent.get(`${own}/note`)).body.data).toEqual({
      note: null,
      revision: 0,
      updatedAt: null,
    });
    await a.agent
      .patch(`${own}/clinical`)
      .set('X-CSRF-Token', a.token)
      .send({
        condition: 'Shared diagnosis',
        status: 'under_treatment',
        revision: 0,
      })
      .expect(200);
    const changed = await b.agent
      .patch(`${own}/clinical`)
      .set('X-CSRF-Token', b.token)
      .send({ status: 'stable', revision: 1 })
      .expect(200);
    expect(changed.body.data).toMatchObject({
      revision: 2,
      condition: 'Shared diagnosis',
      status: 'stable',
    });
    managementSchemas.PatientResponse.parse(changed.body);
    await a.agent
      .put(`${own}/note`)
      .set('X-CSRF-Token', a.token)
      .send({ note: 'Private A', revision: 0 })
      .expect(200);
    await b.agent
      .put(`${own}/note`)
      .set('X-CSRF-Token', b.token)
      .send({ note: 'Private B', revision: 0 })
      .expect(200);
    expect((await a.agent.get(`${own}/note`)).body.data.note).toBe('Private A');
    expect((await b.agent.get(`${own}/note`)).body.data.note).toBe('Private B');
    const review = await admin.agent
      .get(`/api/v1/patients/${patient.id}/doctor-notes`)
      .query({ limit: 1 })
      .expect(200);
    expect(review.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    managementSchemas.NoteListResponse.parse(review.body);
    expect(review.body.data[0].doctor.id).toBe(b.id);
    for (const path of ['/api/v1/me/profile', '/api/v1/me/doctors'])
      expect(
        JSON.stringify((await patient.agent.get(path).expect(200)).body),
      ).not.toContain('Private');
    await admin.agent.delete(pair).set('X-CSRF-Token', admin.token).expect(204);
    await admin.agent.delete(pair).set('X-CSRF-Token', admin.token).expect(204);
    await a.agent.get(own).expect(404);
    await a.agent.get(`${own}/note`).expect(404);
    await a.agent
      .patch(`${own}/clinical`)
      .set('X-CSRF-Token', a.token)
      .send({ status: 'critical', revision: 2 })
      .expect(404);
    await a.agent
      .put(`${own}/note`)
      .set('X-CSRF-Token', a.token)
      .send({ note: 'Denied', revision: 1 })
      .expect(404);
    expect((await b.agent.get(`${own}/note`)).body.data.note).toBe('Private B');
    expect(await Patient.exists({ _id: patient.id })).toBeTruthy();
    await admin.agent.put(pair).set('X-CSRF-Token', admin.token).expect(200);
    expect((await a.agent.get(`${own}/note`)).body.data).toEqual({
      note: null,
      revision: 0,
      updatedAt: null,
    });
    await admin.agent
      .delete(`/api/v1/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .expect(204);
    expect(await Patient.countDocuments()).toBe(0);
    expect(await DoctorPatient.countDocuments()).toBe(0);
    const disabled = await User.findById(patient.user.id);
    expect(disabled!.status).toBe('disabled');
    expect(disabled!.patientId).toBeUndefined();
    await patient.agent.get('/api/v1/me/profile').expect(403);
    await a.agent.get(own).expect(404);
    await b.agent.get(`${own}/note`).expect(404);
    await admin.agent
      .delete(`/api/v1/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .expect(404);
  });
  it('preserves note revisions after clearing, rejects stale/invalid notes and bounds review', async () => {
    const admin = await login('admin');
    const doctor = await login('doctor');
    const patient = await Patient.create(patientInput);
    await DoctorPatient.create({ doctorId: doctor.id, patientId: patient.id });
    const path = `/api/v1/me/patients/${patient.id}/note`;
    for (const body of [
      { note: '', revision: 0 },
      { note: 'x'.repeat(20_001), revision: 0 },
      { note: 'hi' },
      { note: 'hi', revision: -1 },
      { note: 'hi', revision: 0, doctorId: missing() },
    ])
      await doctor.agent
        .put(path)
        .set('X-CSRF-Token', doctor.token)
        .send(body)
        .expect(400);
    await doctor.agent
      .put(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ note: 'Initial', revision: 0 })
      .expect(200);
    await doctor.agent
      .put(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ note: 'Stale', revision: 0 })
      .expect(409);
    await doctor.agent
      .delete(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ revision: 0 })
      .expect(409);
    await doctor.agent
      .delete(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ revision: 1 })
      .expect(204);
    expect((await doctor.agent.get(path)).body.data).toMatchObject({
      note: null,
      revision: 2,
    });
    await doctor.agent
      .put(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ note: 'Stale after clear', revision: 1 })
      .expect(409);
    expect(
      (await admin.agent.get(`/api/v1/patients/${patient.id}/doctor-notes`))
        .body.meta.total,
    ).toBe(0);
    await doctor.agent
      .put(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ note: 'New', revision: 2 })
      .expect(200);
    await admin.agent
      .get(`/api/v1/patients/${patient.id}/doctor-notes`)
      .query({ limit: 101 })
      .expect(400);
    await admin.agent
      .get(`/api/v1/patients/${missing()}/doctor-notes`)
      .expect(404);
  });
  it('scopes both results and totals even with manipulated filters and IDs', async () => {
    const admin = await login('admin');
    const a = await login('doctor');
    const b = await login('doctor', 'b');
    const shared = await Patient.create(patientInput);
    const other = await Patient.create({ ...patientInput, name: 'Other' });
    await Patient.create({ ...patientInput, name: 'Unassigned' });
    await DoctorPatient.create({ doctorId: a.id, patientId: shared.id });
    await DoctorPatient.create({ doctorId: b.id, patientId: shared.id });
    await DoctorPatient.create({ doctorId: b.id, patientId: other.id });
    const own = await a.agent.get('/api/v1/me/patients').expect(200);
    expect(own.body.meta.total).toBe(1);
    expect(own.body.data[0].id).toBe(shared.id);
    const manipulated = await a.agent
      .get('/api/v1/me/patients')
      .query({ doctorId: b.id })
      .expect(200);
    expect(manipulated.body.meta.total).toBe(1);
    await a.agent.get(`/api/v1/me/patients/${other.id}`).expect(404);
    await a.agent.get(`/api/v1/me/patients/${other.id}/note`).expect(404);
    const nested = await admin.agent
      .get(`/api/v1/doctors/${a.id}/patients`)
      .query({ search: 'routine' })
      .expect(200);
    expect(nested.body.meta.total).toBe(1);
    await admin.agent.get(`/api/v1/doctors/${missing()}/patients`).expect(404);
    await a.agent
      .get('/api/v1/me/patients')
      .query({ doctorId: ['bad'] })
      .expect(400);
    await a.agent
      .get('/api/v1/me/patients')
      .query({ search: 'other' })
      .expect(200)
      .then((res) => expect(res.body.meta.total).toBe(0));
  });
  it('validates relationship endpoints and makes simultaneous links idempotent', async () => {
    const admin = await login('admin');
    const doctor = await Doctor.create(doctorInput);
    const patient = await Patient.create(patientInput);
    const path = `/api/v1/doctors/${doctor.id}/patients/${patient.id}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        admin.agent.put(path).set('X-CSRF-Token', admin.token),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(await DoctorPatient.countDocuments()).toBe(1);
    await admin.agent
      .put(path)
      .set('X-CSRF-Token', admin.token)
      .send({ privateNote: 'Injected' })
      .expect(400);
    await admin.agent
      .put(`/api/v1/doctors/${missing()}/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .expect(404);
    await admin.agent
      .put(`/api/v1/doctors/${doctor.id}/patients/${missing()}`)
      .set('X-CSRF-Token', admin.token)
      .expect(404);
  });
});

describe('patient self service', () => {
  it('returns own profiles and paginated doctors and permits contact fields exclusively', async () => {
    const patient = await login('patient');
    const doctor = await login('doctor');
    await DoctorPatient.create({
      doctorId: doctor.id,
      patientId: patient.id,
      privateNote: 'never visible',
    });
    const profile = await patient.agent.get('/api/v1/me/profile').expect(200);
    expect(profile.body.data.id).toBe(patient.id);
    expect((await doctor.agent.get('/api/v1/me/profile')).body.data.id).toBe(
      doctor.id,
    );
    for (const body of [
      { email: 'other@example.test' },
      { name: 'Other' },
      { dateOfBirth: '2000-01-01' },
      { condition: 'Other' },
      { status: 'stable' },
      { role: 'admin' },
      { patientId: missing() },
      { doctorIds: [] },
      { profileId: missing() },
      {},
    ])
      await patient.agent
        .patch('/api/v1/me/profile')
        .set('X-CSRF-Token', patient.token)
        .send(body)
        .expect(400);
    const edited = await patient.agent
      .patch('/api/v1/me/profile')
      .set('X-CSRF-Token', patient.token)
      .send({ phone: '+8801999999999', address: 'New Address' })
      .expect(200);
    expect(edited.body.data).toMatchObject({
      phone: '+8801999999999',
      address: 'New Address',
      revision: 0,
    });
    expect(
      (await Patient.findById(patient.id).select('+searchKeys'))!.searchKeys,
    ).toContain('address');
    const doctors = await patient.agent
      .get('/api/v1/me/doctors')
      .query({ page: 1, limit: 1 })
      .expect(200);
    expect(doctors.body.meta.total).toBe(1);
    expect(doctors.body.data[0].id).toBe(doctor.id);
    expect(JSON.stringify(doctors.body)).not.toContain('never visible');
    expect(
      (
        await patient.agent
          .get('/api/v1/me/doctors')
          .query({ page: 2, limit: 1 })
      ).body.data,
    ).toEqual([]);
    await doctor.agent
      .patch('/api/v1/me/profile')
      .set('X-CSRF-Token', doctor.token)
      .send({ phone: '123' })
      .expect(403);
  });
});

describe('transaction and concurrency guarantees', () => {
  it('rejects clinical field injection and missing, invalid or stale revisions', async () => {
    const doctor = await login('doctor');
    const patient = await Patient.create(patientInput);
    await DoctorPatient.create({ doctorId: doctor.id, patientId: patient.id });
    const path = `/api/v1/me/patients/${patient.id}/clinical`;
    for (const body of [
      { revision: 0 },
      { status: 'stable' },
      { status: 'invalid', revision: 0 },
      { condition: null, revision: 0 },
      { status: 'stable', revision: -1 },
      { phone: 'injected', revision: 0 },
      { status: 'stable', revision: 0, doctorId: missing() },
    ])
      await doctor.agent
        .patch(path)
        .set('X-CSRF-Token', doctor.token)
        .send(body)
        .expect(400);
    await doctor.agent
      .patch(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ condition: '', revision: 0 })
      .expect(200);
    const cleared = await doctor.agent
      .get(`/api/v1/me/patients/${patient.id}`)
      .expect(200);
    expect(cleared.body.data.condition).toBeUndefined();
    expect(cleared.body.data.revision).toBe(1);
    await doctor.agent
      .patch(path)
      .set('X-CSRF-Token', doctor.token)
      .send({ status: 'stable', revision: 0 })
      .expect(409);
  });
  it('returns one clinical conflict for two editors holding the same revision', async () => {
    const a = await login('doctor');
    const b = await login('doctor', 'b');
    const patient = await Patient.create(patientInput);
    await DoctorPatient.create({ doctorId: a.id, patientId: patient.id });
    await DoctorPatient.create({ doctorId: b.id, patientId: patient.id });
    const responses = await Promise.all(
      [a, b].map((doctor) =>
        doctor.agent
          .patch(`/api/v1/me/patients/${patient.id}/clinical`)
          .set('X-CSRF-Token', doctor.token)
          .send({ condition: doctor.id, revision: 0 }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect((await Patient.findById(patient.id))!.revision).toBe(1);
  });
  it('returns one note conflict for simultaneous writes and clear operations', async () => {
    const doctor = await login('doctor');
    const patient = await Patient.create(patientInput);
    await DoctorPatient.create({
      doctorId: doctor.id,
      patientId: patient.id,
      privateNote: 'Old',
    });
    const path = `/api/v1/me/patients/${patient.id}/note`;
    const responses = await Promise.all([
      doctor.agent
        .put(path)
        .set('X-CSRF-Token', doctor.token)
        .send({ note: 'New', revision: 0 }),
      doctor.agent
        .delete(path)
        .set('X-CSRF-Token', doctor.token)
        .send({ revision: 0 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect((await doctor.agent.get(path)).body.data.revision).toBe(1);
  });
  it.each(['clinical', 'note'] as const)(
    'prevents an authorized stale %s write after unlink commits',
    async (kind) => {
      const admin = await login('admin');
      const doctor = await login('doctor');
      const patient = await Patient.create(patientInput);
      await DoctorPatient.create({
        doctorId: doctor.id,
        patientId: patient.id,
      });
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = DoctorPatient.prototype.save;
      const spy = vi
        .spyOn(DoctorPatient.prototype, 'save')
        .mockImplementationOnce(async function (
          this: InstanceType<typeof DoctorPatient>,
          options,
        ) {
          entered();
          await gate;
          return original.call(this, options);
        });
      const path = `/api/v1/me/patients/${patient.id}/${kind}`;
      const write = (
        kind === 'clinical'
          ? doctor.agent.patch(path).send({ status: 'critical', revision: 0 })
          : doctor.agent.put(path).send({ note: 'Stale', revision: 0 })
      )
        .set('X-CSRF-Token', doctor.token)
        .then((result) => result);
      try {
        await waiting;
        await admin.agent
          .delete(`/api/v1/doctors/${doctor.id}/patients/${patient.id}`)
          .set('X-CSRF-Token', admin.token)
          .expect(204);
        release();
        expect((await write).status).toBe(404);
      } finally {
        release();
        spy.mockRestore();
      }
      expect((await Patient.findById(patient.id))!.status).toBe('unassessed');
      expect(await DoctorPatient.countDocuments()).toBe(0);
    },
  );
  it('does not recreate a dangling assignment when deletion wins a concurrent link', async () => {
    const admin = await login('admin');
    const doctor = await Doctor.create(doctorInput);
    const patient = await Patient.create(patientInput);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = Patient.prototype.save;
    const spy = vi
      .spyOn(Patient.prototype, 'save')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof Patient>,
        options,
      ) {
        entered();
        await gate;
        return original.call(this, options);
      });
    const linking = admin.agent
      .put(`/api/v1/doctors/${doctor.id}/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .then((result) => result);
    try {
      await waiting;
      await admin.agent
        .delete(`/api/v1/patients/${patient.id}`)
        .set('X-CSRF-Token', admin.token)
        .expect(204);
      release();
      expect((await linking).status).toBe(404);
    } finally {
      release();
      spy.mockRestore();
    }
    expect(await Patient.countDocuments()).toBe(0);
    expect(await DoctorPatient.countDocuments()).toBe(0);
  });
  it('rolls back deletion, associations, notes and account disablement when final removal fails', async () => {
    const admin = await login('admin');
    const doctor = await login('doctor');
    const patient = await login('patient');
    await DoctorPatient.create({
      doctorId: doctor.id,
      patientId: patient.id,
      privateNote: 'Preserved',
    });
    const spy = vi
      .spyOn(Patient.prototype, 'deleteOne')
      .mockRejectedValueOnce(new Error('Synthetic removal failure'));
    await admin.agent
      .delete(`/api/v1/patients/${patient.id}`)
      .set('X-CSRF-Token', admin.token)
      .expect(500);
    spy.mockRestore();
    expect(await Patient.countDocuments()).toBe(1);
    expect(
      (await DoctorPatient.findOne().select('+privateNote'))!.privateNote,
    ).toBe('Preserved');
    expect((await User.findById(patient.user.id))!.status).toBe('active');
    await patient.agent.get('/api/v1/me/profile').expect(200);
  });
});

describe('management permission matrix', () => {
  it.each([
    'anonymous',
    'pending',
    'rejected',
    'disabled',
    'admin',
    'doctor',
    'patient',
  ] as const)(
    'enforces %s permissions on every management endpoint',
    async (state) => {
      const doctor = await Doctor.create({
        ...doctorInput,
        email: 'target@example.test',
      });
      const patient = await Patient.create(patientInput);
      let client: { agent: ReturnType<typeof request.agent>; token: string };
      if (state === 'anonymous') {
        const agent = request.agent(app);
        client = {
          agent,
          token: (await agent.get('/api/v1/auth/csrf')).body.data.csrfToken,
        };
      } else {
        const session = await login(
          ['pending', 'rejected', 'disabled'].includes(state)
            ? 'admin'
            : (state as 'admin' | 'doctor' | 'patient'),
        );
        if (state === 'pending' || state === 'rejected') {
          // Simulate a current inactive non-admin state in the existing session.
          await User.collection.updateOne(
            { _id: session.user._id },
            { $set: { role: 'doctor', status: state } },
          );
        } else if (state === 'disabled') {
          session.user.status = 'disabled';
          await session.user.save();
        }
        client = session;
      }
      const adminPaths: [
        'get' | 'post' | 'patch' | 'put' | 'delete',
        string,
        object?,
      ][] = [
        ['get', '/doctors'],
        ['post', '/doctors', { ...doctorInput, email: 'created@example.test' }],
        ['get', `/doctors/${doctor.id}`],
        ['patch', `/doctors/${doctor.id}`, { hospital: 'Edited' }],
        ['get', '/patients'],
        ['post', '/patients', patientInput],
        ['get', `/patients/${patient.id}`],
        ['patch', `/patients/${patient.id}`, { name: 'Edited' }],
        ['get', `/doctors/${doctor.id}/patients`],
        ['put', `/doctors/${doctor.id}/patients/${patient.id}`],
        ['delete', `/doctors/${doctor.id}/patients/${patient.id}`],
        ['get', `/patients/${patient.id}/doctor-notes`],
        ['delete', `/patients/${patient.id}`],
      ];
      for (const [method, path, body] of adminPaths) {
        let operation = client.agent[method](`/api/v1${path}`).set(
          'X-CSRF-Token',
          client.token,
        );
        if (body) operation = operation.send(body);
        const result = await operation;
        if (state === 'admin')
          expect(result.status, `${method} ${path}`).toBe(
            method === 'post' ? 201 : method === 'delete' ? 204 : 200,
          );
        else
          expect(result.status, `${method} ${path}`).toBe(
            state === 'anonymous' ? 401 : 403,
          );
      }
      // Use a fresh patient because the admin row permanently deleted its target.
      const target = await Patient.create(patientInput);
      if (state === 'doctor') {
        const user = await User.findOne({ email: 'doctor@example.test' });
        await DoctorPatient.create({
          doctorId: user!.doctorId!,
          patientId: target.id,
        });
      }
      const doctorPaths: [
        'get' | 'patch' | 'put' | 'delete',
        string,
        object?,
      ][] = [
        ['get', '/me/patients'],
        ['get', `/me/patients/${target.id}`],
        [
          'patch',
          `/me/patients/${target.id}/clinical`,
          { status: 'stable', revision: 0 },
        ],
        ['get', `/me/patients/${target.id}/note`],
        [
          'put',
          `/me/patients/${target.id}/note`,
          { note: 'Own note', revision: 0 },
        ],
        ['delete', `/me/patients/${target.id}/note`, { revision: 1 }],
      ];
      for (const [method, path, body] of doctorPaths) {
        let operation = client.agent[method](`/api/v1${path}`).set(
          'X-CSRF-Token',
          client.token,
        );
        if (body) operation = operation.send(body);
        expect((await operation).status, `${method} ${path}`).toBe(
          state === 'doctor'
            ? method === 'delete'
              ? 204
              : 200
            : state === 'anonymous'
              ? 401
              : 403,
        );
      }
      const profileStatus = ['doctor', 'patient'].includes(state)
        ? 200
        : state === 'anonymous'
          ? 401
          : 403;
      await client.agent.get('/api/v1/me/profile').expect(profileStatus);
      const patientStatus =
        state === 'patient' ? 200 : state === 'anonymous' ? 401 : 403;
      await client.agent.get('/api/v1/me/doctors').expect(patientStatus);
      await client.agent
        .patch('/api/v1/me/profile')
        .set('X-CSRF-Token', client.token)
        .send({ phone: '123' })
        .expect(patientStatus);
    },
  );
});
