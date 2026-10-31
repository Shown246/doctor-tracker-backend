import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { Environment } from '../config/environment.js';
import { ApiError } from '../errors/api-error.js';
import { Doctor } from '../modules/doctors/doctor.model.js';
import { Patient, patientStatuses } from '../modules/patients/patient.model.js';
import { DoctorPatient } from '../modules/assignments/doctor-patient.model.js';
import { User } from '../modules/auth/user.model.js';
import { hashPassword } from '../modules/auth/password.js';
import { transaction } from './transaction.js';

export function fixtureId(key: string) {
  return new Types.ObjectId(
    createHash('sha256')
      .update(`doctor-tracker-synthetic-v1:${key}`)
      .digest('hex')
      .slice(0, 24),
  );
}
export function assertFixtureTarget(
  config: Environment,
  source: NodeJS.ProcessEnv,
  mode: 'demo' | 'performance',
) {
  if (
    source.FIXTURE_DATABASE !== config.MONGODB_DATABASE ||
    (mode === 'performance' &&
      (config.NODE_ENV === 'production' ||
        !/_(development|test)$/.test(config.MONGODB_DATABASE))) ||
    (mode === 'demo' &&
      (!/_(development|test|demo)$/.test(config.MONGODB_DATABASE) ||
        source.SEED_DEMO !== 'true'))
  ) {
    throw new ApiError(
      400,
      'FIXTURE_TARGET_REQUIRED',
      'Explicitly select an allowed fixture database; see docs/data-and-performance.md',
    );
  }
}
const credential = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(128),
});
export function demoCredentials(source: NodeJS.ProcessEnv) {
  const read = (role: string) =>
    credential.parse({
      email: source[`DEMO_${role}_EMAIL`],
      password: source[`DEMO_${role}_PASSWORD`],
    });
  const result = {
    admin: read('ADMIN'),
    doctor: read('DOCTOR'),
    patient: read('PATIENT'),
  };
  if (new Set(Object.values(result).map((item) => item.email)).size !== 3)
    throw new ApiError(
      400,
      'INVALID_SEED_CREDENTIALS',
      'Demo emails must be distinct',
    );
  return result;
}
export async function seedDemo(
  credentials: ReturnType<typeof demoCredentials>,
) {
  const hashes = {
    admin: await hashPassword(credentials.admin.password),
    doctor: await hashPassword(credentials.doctor.password),
    patient: await hashPassword(credentials.patient.password),
  };
  return transaction(async (session) => {
    let created = 0;
    for (let index = 0; index < 3; index += 1) {
      const _id = fixtureId(`demo:doctor:${index}`);
      const email =
        index === 0
          ? credentials.doctor.email
          : `demo-doctor-${index}@example.test`;
      const existing = await Doctor.findById(_id).session(session);
      if (existing && existing.email !== email)
        throw new ApiError(
          409,
          'SEED_CONFLICT',
          'Seed credentials differ from the existing fixture',
        );
      if (!existing) {
        await new Doctor({
          _id,
          name: `Dr Synthetic ${index + 1}`,
          email,
          specialization: ['Cardiology', 'Neurology', 'General Medicine'][
            index
          ],
          hospital: 'Synthetic Demo Hospital',
          phone: '+8801700000000',
        }).save({ session });
        created += 1;
      }
    }
    for (let index = 0; index < 6; index += 1) {
      const _id = fixtureId(`demo:patient:${index}`);
      const email =
        index === 0
          ? credentials.patient.email
          : `demo-patient-${index}@example.test`;
      const existing = await Patient.findById(_id).session(session);
      if (existing && existing.email !== email)
        throw new ApiError(
          409,
          'SEED_CONFLICT',
          'Seed credentials differ from the existing fixture',
        );
      if (!existing) {
        await new Patient({
          _id,
          name: `Synthetic Patient ${index + 1}`,
          email,
          dateOfBirth: '1995-02-28',
          gender: 'undisclosed',
          phone: '+8801800000000',
          address: 'Synthetic Demo Address',
          condition:
            index === 0
              ? undefined
              : ['Routine Observation', 'Synthetic Follow-up'][index % 2],
          status: patientStatuses[index % patientStatuses.length],
        }).save({ session });
        created += 1;
      }
      // The final patient remains unassigned; doctor 3 has no patients.
      if (index < 5)
        for (const doctorIndex of index === 0 ? [0, 1] : [index % 2]) {
          const doctorId = fixtureId(`demo:doctor:${doctorIndex}`);
          if (
            !(await DoctorPatient.exists({ doctorId, patientId: _id }).session(
              session,
            ))
          ) {
            await new DoctorPatient({
              _id: fixtureId(`demo:assignment:${doctorIndex}:${index}`),
              doctorId,
              patientId: _id,
              privateNote: `Synthetic private note for doctor ${doctorIndex + 1}`,
              noteRevision: 1,
              noteUpdatedAt: new Date(),
            }).save({ session });
            created += 1;
          }
        }
    }
    for (const role of ['admin', 'doctor', 'patient'] as const) {
      const _id = fixtureId(`demo:user:${role}`);
      const existing = await User.findById(_id).session(session);
      if (
        existing &&
        (existing.email !== credentials[role].email || existing.role !== role)
      )
        throw new ApiError(
          409,
          'SEED_CONFLICT',
          'Seed account does not match the existing fixture',
        );
      if (!existing) {
        await new User({
          _id,
          name: `Synthetic ${role}`,
          email: credentials[role].email,
          passwordHash: hashes[role],
          role,
          status: 'active',
          ...(role === 'doctor'
            ? { doctorId: fixtureId('demo:doctor:0') }
            : role === 'patient'
              ? { patientId: fixtureId('demo:patient:0') }
              : {}),
        }).save({ session });
        created += 1;
      }
    }
    for (const role of ['doctor', 'patient'] as const) {
      const _id = fixtureId(`demo:pending:${role}`);
      if (!(await User.exists({ _id }).session(session))) {
        await new User({
          _id,
          name: `Pending Synthetic ${role}`,
          email: `demo-pending-${role}@example.test`,
          passwordHash: hashes[role],
          role,
          status: 'pending',
          pendingRegistration:
            role === 'doctor'
              ? {
                  doctor: {
                    specialization: 'General Medicine',
                    hospital: 'Synthetic Demo Hospital',
                    phone: '+8801700000000',
                  },
                }
              : {
                  patient: {
                    dateOfBirth: '1995-02-28',
                    gender: 'undisclosed',
                    phone: '+8801800000000',
                    address: 'Synthetic Demo Address',
                  },
                },
        }).save({ session });
        created += 1;
      }
    }
    return { created };
  });
}

export const performanceSizeSchema = z.strictObject({
  doctors: z.coerce.number().int().min(1).max(10_000).default(100),
  patients: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
});
export async function seedPerformance(
  size: z.infer<typeof performanceSizeSchema>,
) {
  let created = 0;
  const anchor = new Date('2026-10-31T12:00:00Z');
  for (let start = 0; start < size.doctors; start += 50) {
    await Promise.all(
      Array.from(
        { length: Math.min(50, size.doctors - start) },
        async (_, offset) => {
          const index = start + offset;
          const _id = fixtureId(`perf:doctor:${index}`);
          if (!(await Doctor.exists({ _id }))) {
            const date = new Date(
              anchor.getTime() - (index % 365) * 86_400_000,
            );
            await new Doctor({
              _id,
              name: `Synthetic Doctor ${String(index).padStart(6, '0')}`,
              email: `perf-doctor-${index}@example.test`,
              specialization: ['Cardiology', 'Neurology', 'General Medicine'][
                index % 3
              ],
              hospital: `Synthetic Hospital ${index % 10}`,
              phone: '+8801700000000',
              createdAt: date,
              updatedAt: date,
            }).save();
            created += 1;
          }
        },
      ),
    );
  }
  for (let start = 0; start < size.patients; start += 50) {
    await Promise.all(
      Array.from(
        { length: Math.min(50, size.patients - start) },
        async (_, offset) => {
          const index = start + offset;
          const _id = fixtureId(`perf:patient:${index}`);
          const date = new Date(anchor.getTime() - (index % 365) * 86_400_000);
          if (!(await Patient.exists({ _id }))) {
            await new Patient({
              _id,
              name: `Synthetic Patient ${String(index).padStart(7, '0')}`,
              email: `perf-patient-${index}@example.test`,
              dateOfBirth: '1995-02-28',
              gender: 'undisclosed',
              phone: '+8801800000000',
              condition: `Synthetic Condition ${index % 40}`,
              status: patientStatuses[index % 5],
              createdAt: date,
              updatedAt: date,
            }).save();
            created += 1;
          }
          // Leave 1/10 patients unassigned and share 1/7 between adjacent doctors.
          if (index % 10 !== 0)
            for (const doctorIndex of new Set(
              index % 7 === 0 && size.doctors > 1
                ? [index % size.doctors, (index + 1) % size.doctors]
                : [index % size.doctors],
            )) {
              const doctorId = fixtureId(`perf:doctor:${doctorIndex}`);
              if (!(await DoctorPatient.exists({ doctorId, patientId: _id }))) {
                await new DoctorPatient({
                  _id: fixtureId(`perf:assignment:${doctorIndex}:${index}`),
                  doctorId,
                  patientId: _id,
                  assignedAt: date,
                  createdAt: date,
                  updatedAt: date,
                }).save();
                created += 1;
              }
            }
        },
      ),
    );
  }
  return { created, doctors: size.doctors, patients: size.patients };
}
