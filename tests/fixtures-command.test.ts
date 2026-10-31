import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { parseEnvironment } from '../src/config/environment.js';
import { connectDatabase } from '../src/database/connection.js';
import { setupIndexes } from '../src/database/indexes.js';
import {
  assertFixtureTarget,
  demoCredentials,
  fixtureId,
  performanceSizeSchema,
  seedDemo,
  seedPerformance,
} from '../src/database/fixtures.js';
import { createLogger } from '../src/logging/logger.js';
import { User } from '../src/modules/auth/user.model.js';
import { Doctor } from '../src/modules/doctors/doctor.model.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { DoctorPatient } from '../src/modules/assignments/doctor-patient.model.js';
import { verifyPassword } from '../src/modules/auth/password.js';
import { validEnvironment, doctorInput } from './fixtures.js';

let replica: MongoMemoryReplSet;
let disconnect: (() => Promise<void>) | undefined;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  disconnect = await connectDatabase(
    parseEnvironment({ ...validEnvironment, MONGODB_URI: replica.getUri() }),
    createLogger('silent'),
  );
  await setupIndexes();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Doctor.deleteMany({}),
    Patient.deleteMany({}),
    DoctorPatient.deleteMany({}),
  ]);
});
afterAll(async () => {
  await disconnect?.();
  await replica?.stop();
});
const credentials = demoCredentials({
  DEMO_ADMIN_EMAIL: 'synthetic-admin@example.test',
  DEMO_ADMIN_PASSWORD: 'synthetic-admin-password',
  DEMO_DOCTOR_EMAIL: 'synthetic-doctor@example.test',
  DEMO_DOCTOR_PASSWORD: 'synthetic-doctor-password',
  DEMO_PATIENT_EMAIL: 'synthetic-patient@example.test',
  DEMO_PATIENT_PASSWORD: 'synthetic-patient-password',
});
describe('explicit fixture targets', () => {
  it('refuses missing/mismatched selection, production performance writes, and demo performance writes', () => {
    const config = parseEnvironment(validEnvironment);
    expect(() => assertFixtureTarget(config, {}, 'performance')).toThrow();
    expect(() =>
      assertFixtureTarget(
        config,
        { FIXTURE_DATABASE: 'another_test' },
        'performance',
      ),
    ).toThrow();
    expect(() =>
      assertFixtureTarget(
        { ...config, MONGODB_DATABASE: 'doctor_tracker_demo' },
        { FIXTURE_DATABASE: 'doctor_tracker_demo' },
        'performance',
      ),
    ).toThrow();
    expect(() =>
      assertFixtureTarget(
        { ...config, NODE_ENV: 'production' },
        { FIXTURE_DATABASE: config.MONGODB_DATABASE },
        'performance',
      ),
    ).toThrow();
    expect(() =>
      assertFixtureTarget(
        config,
        { FIXTURE_DATABASE: config.MONGODB_DATABASE },
        'demo',
      ),
    ).toThrow();
    expect(() =>
      assertFixtureTarget(
        { ...config, MONGODB_DATABASE: 'live' },
        { FIXTURE_DATABASE: 'live', SEED_DEMO: 'true' },
        'demo',
      ),
    ).toThrow();
    expect(() =>
      assertFixtureTarget(
        config,
        { FIXTURE_DATABASE: config.MONGODB_DATABASE },
        'performance',
      ),
    ).not.toThrow();
    expect(() =>
      assertFixtureTarget(
        {
          ...config,
          NODE_ENV: 'production',
          MONGODB_DATABASE: 'doctor_tracker_demo',
        },
        { FIXTURE_DATABASE: 'doctor_tracker_demo', SEED_DEMO: 'true' },
        'demo',
      ),
    ).not.toThrow();
  });
  it('requires distinct external credentials and bounded fixture sizes', () => {
    expect(() => demoCredentials({})).toThrow();
    expect(() =>
      demoCredentials({
        DEMO_ADMIN_EMAIL: 'same@example.test',
        DEMO_ADMIN_PASSWORD: 'synthetic-password',
        DEMO_DOCTOR_EMAIL: 'same@example.test',
        DEMO_DOCTOR_PASSWORD: 'synthetic-password',
        DEMO_PATIENT_EMAIL: 'same@example.test',
        DEMO_PATIENT_PASSWORD: 'synthetic-password',
      }),
    ).toThrow();
    expect(performanceSizeSchema.parse({})).toEqual({
      doctors: 100,
      patients: 10_000,
    });
    expect(
      performanceSizeSchema.safeParse({ patients: 1_000_001 }).success,
    ).toBe(false);
    expect(performanceSizeSchema.safeParse({ doctors: 0 }).success).toBe(false);
  });
});
describe('repeatable synthetic seeds', () => {
  it('creates all roles, pending registrations, statuses, shared and unassigned patients with isolated notes', async () => {
    await seedDemo(credentials);
    expect(await Doctor.countDocuments({})).toBe(3);
    expect(await Patient.countDocuments({})).toBe(6);
    expect(await User.countDocuments({ status: 'active' })).toBe(3);
    expect(await User.countDocuments({ status: 'pending' })).toBe(2);
    expect(await Patient.distinct('status')).toHaveLength(5);
    expect(
      await DoctorPatient.countDocuments({
        patientId: fixtureId('demo:patient:0'),
      }),
    ).toBe(2);
    expect(
      await DoctorPatient.countDocuments({
        patientId: fixtureId('demo:patient:5'),
      }),
    ).toBe(0);
    expect(
      await DoctorPatient.countDocuments({
        doctorId: fixtureId('demo:doctor:2'),
      }),
    ).toBe(0);
    const notes = await DoctorPatient.find({
      patientId: fixtureId('demo:patient:0'),
    })
      .select('+privateNote')
      .lean();
    expect(new Set(notes.map((note) => note.privateNote)).size).toBe(2);
    for (const role of ['admin', 'doctor', 'patient'] as const) {
      const user = await User.findOne({ role, status: 'active' }).select(
        '+passwordHash',
      );
      expect(
        await verifyPassword(user!.passwordHash, credentials[role].password),
      ).toBe(true);
    }
  });
  it('is idempotent and preserves edited records, account decisions and existing passwords', async () => {
    await seedDemo(credentials);
    const patient = await Patient.findById(fixtureId('demo:patient:0'));
    patient!.condition = 'Preserved edit';
    await patient!.save();
    const pending = await User.findById(fixtureId('demo:pending:doctor'));
    pending!.status = 'rejected';
    await pending!.save();
    const result = await seedDemo({
      ...credentials,
      admin: {
        ...credentials.admin,
        password: 'replacement-synthetic-password',
      },
    });
    expect(result.created).toBe(0);
    expect((await Patient.findById(patient!._id))!.condition).toBe(
      'Preserved edit',
    );
    expect((await User.findById(pending!._id))!.status).toBe('rejected');
    const admin = await User.findById(fixtureId('demo:user:admin')).select(
      '+passwordHash',
    );
    expect(
      await verifyPassword(admin!.passwordHash, credentials.admin.password),
    ).toBe(true);
  });
  it('rolls back collisions and failed writes without claiming existing profiles', async () => {
    const existing = await Doctor.create({
      ...doctorInput,
      email: credentials.doctor.email,
    });
    await expect(seedDemo(credentials)).rejects.toThrow();
    expect(await Doctor.countDocuments({})).toBe(1);
    expect(await User.countDocuments({})).toBe(0);
    await existing.deleteOne();
    const original = Patient.prototype.save;
    vi.spyOn(Patient.prototype, 'save').mockImplementationOnce(
      async function () {
        throw new Error('Forced fixture failure');
      },
    );
    await expect(seedDemo(credentials)).rejects.toThrow(
      'Forced fixture failure',
    );
    Patient.prototype.save = original;
    expect(await Doctor.countDocuments({})).toBe(0);
    expect(await Patient.countDocuments({})).toBe(0);
    expect(await DoctorPatient.countDocuments({})).toBe(0);
  });
  it('generates repeatable separate performance fixtures through validated writes', async () => {
    await seedPerformance({ doctors: 3, patients: 25 });
    expect(await Doctor.countDocuments({})).toBe(3);
    expect(await Patient.countDocuments({})).toBe(25);
    expect(await User.countDocuments({})).toBe(0);
    const assignments = await DoctorPatient.countDocuments({});
    expect(assignments).toBeGreaterThan(22);
    expect((await seedPerformance({ doctors: 3, patients: 25 })).created).toBe(
      0,
    );
    expect(await DoctorPatient.countDocuments({})).toBe(assignments);
    const patient = await Patient.findOne({
      searchKeys: /^synthetic condition 1/,
    })
      .select('+conditionKey')
      .lean();
    expect(patient?.conditionKey).toMatch(/^synthetic condition 1/);
    expect(mongoose.connection.name).toBe(validEnvironment.MONGODB_DATABASE);
  });
});
