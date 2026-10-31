import mongoose, { Types } from 'mongoose';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config/environment.js';
import {
  connectDatabase,
  isDatabaseReady,
} from '../src/database/connection.js';
import { setupIndexes } from '../src/database/indexes.js';
import {
  isValidBirthDate,
  normalizeSearch,
  searchKeys,
} from '../src/database/schema-helpers.js';
import { accountDto, doctorDto, patientDto } from '../src/http/dtos.js';
import { createLogger } from '../src/logging/logger.js';
import { DoctorPatient } from '../src/modules/assignments/doctor-patient.model.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import { provisionAdmin } from '../src/modules/auth/provision-admin.js';
import { User } from '../src/modules/auth/user.model.js';
import { Doctor } from '../src/modules/doctors/doctor.model.js';
import { Patient } from '../src/modules/patients/patient.model.js';
import { doctorInput, patientInput, validEnvironment } from './fixtures.js';

const logger = createLogger('silent');
let replica: MongoMemoryReplSet;
let disconnect: (() => Promise<void>) | undefined;
let storedHash: string;
const adminInput = {
  name: 'Example Admin',
  email: 'admin@example.test',
  password: 'synthetic-test-password',
};

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    disconnect = await connectDatabase(
      parseEnvironment({ ...validEnvironment, MONGODB_URI: replica.getUri() }),
      logger,
    );
    await setupIndexes();
    storedHash = await hashPassword('synthetic-test-password');
  } catch (error) {
    await mongoose.disconnect();
    await replica.stop();
    throw error;
  }
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
  try {
    await disconnect?.();
  } finally {
    await replica?.stop();
  }
});

describe('models and explicit indexes', () => {
  it('creates indexes repeatably and never relies on automatic creation', async () => {
    await setupIndexes();
    for (const model of [User, Doctor, Patient, DoctorPatient]) {
      expect(model.schema.options.autoIndex).toBe(false);
      expect(model.schema.options.autoCreate).toBe(false);
    }
    const indexes = await DoctorPatient.collection.indexes();
    expect(
      indexes.some(
        (index) =>
          index.unique && index.key.doctorId === 1 && index.key.patientId === 1,
      ),
    ).toBe(true);
  });

  it('normalizes emails and derives searchable full fields and word prefixes on save', async () => {
    const doctor = await Doctor.create({
      ...doctorInput,
      email: '  DOCTOR@Example.TEST  ',
    });
    expect(doctor.email).toBe('doctor@example.test');
    const stored = await Doctor.findById(doctor._id).select(
      '+searchKeys +nameKey +specializationKey',
    );
    expect(stored?.searchKeys).toContain('example hospital');
    expect(stored?.searchKeys).toContain('hospital');
    doctor.name = 'Dr New Name';
    await doctor.save();
    const renamed = await Doctor.findOne({ searchKeys: /^new/ });
    expect(renamed?._id).toEqual(doctor._id);
    await expect(Doctor.create(doctorInput)).rejects.toMatchObject({
      code: 11000,
    });
    const patient = await Patient.create(patientInput);
    expect(patient.revision).toBe(0);
    expect(patient.status).toBe('unassessed');
    expect(normalizeSearch('  ＴＥＳＴ   Name ')).toBe('test name');
    expect(searchKeys(['Same same', 'same'])).toEqual(['same same', 'same']);
  });

  it('allows absent and blank patient emails but enforces uniqueness when supplied', async () => {
    await Patient.create([
      patientInput,
      { ...patientInput, email: '' },
      { ...patientInput, email: '   ' },
    ]);
    expect(await Patient.countDocuments({ email: { $exists: false } })).toBe(3);
    await Patient.create({ ...patientInput, email: ' PATIENT@example.test ' });
    await expect(
      Patient.create({ ...patientInput, email: 'patient@example.test' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('validates real date-only births, field bounds, clinical status and integer revisions', async () => {
    for (const date of [
      '2023-02-29',
      '1995-02-30',
      '1995-01-01T00:00:00Z',
      '9999-12-31',
      '1899-01-01',
    ]) {
      expect(isValidBirthDate(date)).toBe(false);
      await expect(
        Patient.create({ ...patientInput, dateOfBirth: date }),
      ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    }
    expect(isValidBirthDate('2000-02-29')).toBe(true);
    await expect(
      Patient.create({ ...patientInput, revision: 0.5 }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    await expect(
      new Patient({ ...patientInput, status: 'invalid' }).validate(),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    await expect(
      Doctor.create({ ...doctorInput, name: 'x'.repeat(121) }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    await expect(
      new Doctor({ ...doctorInput, email: undefined }).validate(),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
  });

  it('enforces one account per profile, immutable roles, and role/profile consistency', async () => {
    const doctorId = new Types.ObjectId();
    const patientId = new Types.ObjectId();
    await User.create({
      name: 'Doctor',
      email: 'one@example.test',
      passwordHash: storedHash,
      role: 'doctor',
      status: 'active',
      doctorId,
    });
    await expect(
      User.create({
        name: 'Other',
        email: 'two@example.test',
        passwordHash: storedHash,
        role: 'doctor',
        status: 'active',
        doctorId,
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await User.create({
      name: 'Patient',
      email: 'patient-one@example.test',
      passwordHash: storedHash,
      role: 'patient',
      status: 'active',
      patientId,
    });
    await expect(
      User.create({
        name: 'Other',
        email: 'patient-two@example.test',
        passwordHash: storedHash,
        role: 'patient',
        status: 'active',
        patientId,
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      User.create({
        name: 'Mismatch',
        email: 'mismatch@example.test',
        passwordHash: storedHash,
        role: 'doctor',
        status: 'active',
        patientId,
      }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    await expect(
      User.create({
        name: 'Missing',
        email: 'missing@example.test',
        passwordHash: storedHash,
        role: 'patient',
        status: 'active',
      }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    const user = await User.findOne({ email: 'one@example.test' });
    user!.role = 'admin';
    await expect(user!.save()).rejects.toBeInstanceOf(
      mongoose.Error.ValidationError,
    );
    expect((await User.findById(user!._id))?.role).toBe('doctor');
  });

  it('stores pending registration details without creating active profiles', async () => {
    const pending = await User.create({
      name: 'Applicant',
      email: 'applicant@example.test',
      passwordHash: storedHash,
      role: 'patient',
      pendingRegistration: {
        patient: {
          dateOfBirth: '1990-01-01',
          gender: 'other',
          phone: '0123456789',
        },
      },
    });
    expect(pending.status).toBe('pending');
    expect(await Patient.countDocuments()).toBe(0);
    expect(
      (await User.findById(pending._id))?.pendingRegistration,
    ).toBeUndefined();
    await expect(
      User.create({
        name: 'Bad',
        email: 'bad@example.test',
        passwordHash: storedHash,
        role: 'patient',
      }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
  });

  it('enforces many-to-many pair uniqueness and hides private notes', async () => {
    const doctorId = new Types.ObjectId();
    const patientId = new Types.ObjectId();
    const association = await DoctorPatient.create({
      doctorId,
      patientId,
      privateNote: 'Private example note',
    });
    await expect(
      DoctorPatient.create({ doctorId, patientId }),
    ).rejects.toMatchObject({ code: 11000 });
    await DoctorPatient.create({ doctorId: new Types.ObjectId(), patientId });
    await DoctorPatient.create({ doctorId, patientId: new Types.ObjectId() });
    expect(
      (await DoctorPatient.findById(association._id))?.privateNote,
    ).toBeUndefined();
    expect(
      (await DoctorPatient.findById(association._id).select('+privateNote'))
        ?.privateNote,
    ).toBe('Private example note');
    await DoctorPatient.deleteOne({ _id: association._id });
    expect(
      await DoctorPatient.findById(association._id).select('+privateNote'),
    ).toBeNull();
  });

  it('rejects update paths that bypass derived fields or document validation', async () => {
    const doctor = await Doctor.create(doctorInput);
    await expect(
      Doctor.updateOne({ _id: doctor._id }, { name: 'Bypass' }),
    ).rejects.toThrow('document.save');
    await expect(
      Doctor.findByIdAndUpdate(doctor._id, { name: 'Bypass' }),
    ).rejects.toThrow('document.save');
    await expect(Doctor.insertMany([doctorInput])).rejects.toThrow(
      'model.create',
    );
    await expect(
      Doctor.bulkWrite([
        {
          updateOne: {
            filter: { _id: doctor._id },
            update: { name: 'Bypass' },
          },
        },
      ]),
    ).rejects.toThrow('validated document writes');
  });

  it('supports transaction rollback on the replica set', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await Patient.create([patientInput], { session });
          await Doctor.create([doctorInput], { session });
          throw new Error('Rollback probe');
        }),
      ).rejects.toThrow('Rollback probe');
      expect(await Patient.countDocuments()).toBe(0);
      expect(await Doctor.countDocuments()).toBe(0);
    } finally {
      await session.endSession();
    }
  });

  it('returns explicit DTOs without hashes, registration details, notes, or search internals', async () => {
    const doctor = await Doctor.create(doctorInput);
    const patient = await Patient.create(patientInput);
    const user = await User.create({
      name: 'Admin',
      email: 'admin@example.test',
      passwordHash: storedHash,
      role: 'admin',
      status: 'active',
    });
    expect(Object.keys(doctorDto(doctor))).not.toContain('searchKeys');
    expect(Object.keys(patientDto(patient))).not.toContain(
      'lastClinicalEditor',
    );
    expect(Object.keys(accountDto(user))).toEqual([
      'id',
      'name',
      'email',
      'role',
      'status',
    ]);
    const fetched = await User.findById(user._id);
    expect(fetched?.passwordHash).toBeUndefined();
  });
});

describe('private admin provisioning', () => {
  it('rejects invalid credentials without creating accounts', async () => {
    await expect(
      provisionAdmin({ ...adminInput, password: 'short' }),
    ).rejects.toThrow();
    await expect(
      provisionAdmin({ ...adminInput, email: 'invalid' }),
    ).rejects.toThrow();
    expect(await User.countDocuments()).toBe(0);
  });

  it('provisions through the actual command without disclosing credentials', async () => {
    const run = async () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/commands/create-admin.ts'],
        {
          env: {
            ...process.env,
            ...validEnvironment,
            MONGODB_URI: replica.getUri(),
            LOG_LEVEL: 'info',
            ADMIN_NAME: adminInput.name,
            ADMIN_EMAIL: adminInput.email,
            ADMIN_PASSWORD: adminInput.password,
          },
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [code] = await once(child, 'exit');
      expect(output).not.toContain(adminInput.password);
      expect(output).not.toContain('$argon2id$');
      return { code, output };
    };
    const created = await run();
    expect(created.code).toBe(0);
    expect(created.output).toContain('Admin account created');
    const duplicate = await run();
    expect(duplicate.code).toBe(1);
    expect(await User.countDocuments()).toBe(1);
  });

  it('creates an active admin with a verifiable Argon2id password', async () => {
    const result = await provisionAdmin({
      ...adminInput,
      email: ' ADMIN@Example.TEST ',
    });
    expect(result).toMatchObject({ role: 'admin', status: 'active' });
    expect(result).not.toHaveProperty('passwordHash');
    const stored = await User.findById(result.id).select('+passwordHash');
    expect(stored?.email).toBe('admin@example.test');
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(
      await verifyPassword(stored!.passwordHash, adminInput.password),
    ).toBe(true);
    expect(
      await verifyPassword(stored!.passwordHash, 'wrong-synthetic-password'),
    ).toBe(false);
    expect(await verifyPassword('invalid-hash', adminInput.password)).toBe(
      false,
    );
  });

  it('refuses duplicate accounts and never promotes an existing patient', async () => {
    await provisionAdmin(adminInput);
    await expect(provisionAdmin(adminInput)).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
    await User.create({
      name: 'Patient',
      email: 'patient@example.test',
      passwordHash: storedHash,
      role: 'patient',
      status: 'active',
      patientId: new Types.ObjectId(),
    });
    await expect(
      provisionAdmin({ ...adminInput, email: 'patient@example.test' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
    expect((await User.findOne({ email: 'patient@example.test' }))?.role).toBe(
      'patient',
    );
  });

  it('handles simultaneous provisioning without overwriting', async () => {
    const results = await Promise.allSettled([
      provisionAdmin(adminInput),
      provisionAdmin(adminInput),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await User.countDocuments({ email: adminInput.email })).toBe(1);
  });
});

describe('database readiness', () => {
  it('reflects a real connection loss and leaves liveness healthy', async () => {
    const app = createApp({
      config: parseEnvironment(validEnvironment),
      logger,
      isDatabaseReady,
    });
    await request(app).get('/health/ready').expect(200);
    await disconnect!();
    expect(await isDatabaseReady()).toBe(false);
    await request(app).get('/health/ready').expect(503);
    await request(app).get('/health/live').expect(200);
    disconnect = await connectDatabase(
      parseEnvironment({ ...validEnvironment, MONGODB_URI: replica.getUri() }),
      logger,
    );
  });
});
