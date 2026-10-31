import mongoose from 'mongoose';
import type { InferSchemaType, Types } from 'mongoose';
import { ApiError } from '../../errors/api-error.js';
import { User } from '../auth/user.model.js';
import { Doctor } from '../doctors/doctor.model.js';
import { Patient } from '../patients/patient.model.js';
import { currentUserProjection } from '../auth/auth.service.js';
import {
  registrationDetailSchema,
  registrationSummarySchema,
} from './registration.schemas.js';
import type {
  DecisionInput,
  registrationQuerySchema,
} from './registration.schemas.js';
import type { z } from 'zod';

export const registrationProjection = {
  ...currentUserProjection,
  pendingRegistration: 1,
  createdAt: 1,
  updatedAt: 1,
  __v: 1,
} as const;
type RegistrationRecord = InferSchemaType<typeof User.schema> & {
  _id: Types.ObjectId;
};
const registrationFilter = {
  role: { $in: ['doctor', 'patient'] },
  pendingRegistration: { $exists: true },
} as const;
function summary(record: RegistrationRecord) {
  return registrationSummarySchema.parse({
    id: record._id.toString(),
    name: record.name,
    email: record.email,
    role: record.role,
    status: record.status,
    profileId:
      (record.role === 'doctor'
        ? record.doctorId
        : record.patientId
      )?.toString() ?? null,
    ...(record.status === 'rejected' && record.rejectionReason
      ? { rejectionReason: record.rejectionReason }
      : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}
function detail(record: RegistrationRecord) {
  const doctor = record.pendingRegistration?.doctor;
  const patient = record.pendingRegistration?.patient;
  const profile =
    record.role === 'doctor' && doctor
      ? {
          specialization: doctor.specialization,
          hospital: doctor.hospital,
          phone: doctor.phone,
        }
      : patient
        ? {
            dateOfBirth: patient.dateOfBirth,
            gender: patient.gender,
            phone: patient.phone,
            ...(patient.address ? { address: patient.address } : {}),
          }
        : undefined;
  return registrationDetailSchema.parse({ ...summary(record), profile });
}
export async function listRegistrations(
  query: z.infer<typeof registrationQuerySchema>,
) {
  const filter = {
    ...registrationFilter,
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
  };
  const [records, total] = await Promise.all([
    User.find(filter)
      .select({ ...currentUserProjection, createdAt: 1, updatedAt: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    User.countDocuments(filter),
  ]);
  return {
    data: records.map(summary),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}
export async function registrationDetail(id: string) {
  const record = await User.findOne({ ...registrationFilter, _id: id })
    .select(registrationProjection)
    .lean();
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Registration not found');
  return detail(record);
}

const conflict = () =>
  new ApiError(
    409,
    'REGISTRATION_CONFLICT',
    'Registration or profile is no longer available for this decision',
  );
export async function decideRegistration(id: string, input: DecisionInput) {
  const session = await mongoose.startSession();
  try {
    // Each driver retry loads fresh documents. Avoid retaining document state
    // across retries (including nested submissions with strict schemas).
    return await session.withTransaction(
      async () => {
        const user = await User.findOne({ ...registrationFilter, _id: id })
          .select(registrationProjection)
          .session(session);
        if (!user)
          throw new ApiError(404, 'NOT_FOUND', 'Registration not found');
        if (user.status !== 'pending') throw conflict();
        if (
          user.doctorId ||
          user.patientId ||
          (user.role === 'doctor'
            ? !user.pendingRegistration?.doctor
            : !user.pendingRegistration?.patient)
        )
          throw conflict();
        if (input.decision === 'reject') {
          user.status = 'rejected';
          user.set('rejectionReason', input.reason);
        } else {
          if (input.mode === 'create') {
            if (user.role === 'doctor') {
              if (input.patientClinical)
                throw new ApiError(
                  400,
                  'VALIDATION_ERROR',
                  'Doctor approval cannot include patient clinical fields',
                );
              if (await Doctor.exists({ email: user.email }).session(session))
                throw conflict();
              const submitted = user.pendingRegistration!.doctor!;
              const doctor = new Doctor({
                name: user.name,
                email: user.email,
                specialization: submitted.specialization,
                hospital: submitted.hospital,
                phone: submitted.phone,
              });
              await doctor.save({ session });
              user.doctorId = doctor._id;
            } else {
              if (!input.patientClinical)
                throw new ApiError(
                  400,
                  'VALIDATION_ERROR',
                  'New patient approval requires condition and status confirmation',
                );
              if (await Patient.exists({ email: user.email }).session(session))
                throw conflict();
              const submitted = user.pendingRegistration!.patient!;
              const patient = new Patient({
                name: user.name,
                email: user.email,
                dateOfBirth: submitted.dateOfBirth,
                gender: submitted.gender,
                phone: submitted.phone,
                address: submitted.address,
                condition: input.patientClinical.condition || undefined,
                status: input.patientClinical.status,
              });
              await patient.save({ session });
              user.patientId = patient._id;
            }
          } else if (user.role === 'doctor') {
            const doctor = await Doctor.findOne({
              _id: input.profileId,
              email: user.email,
            }).session(session);
            if (
              !doctor ||
              (await User.exists({ doctorId: doctor._id }).session(session))
            )
              throw conflict();
            doctor.increment();
            await doctor.save({ session });
            user.doctorId = doctor._id;
          } else {
            const patient = await Patient.findOne({
              _id: input.profileId,
              email: user.email,
            }).session(session);
            if (
              !patient ||
              (await User.exists({ patientId: patient._id }).session(session))
            )
              throw conflict();
            patient.increment();
            await patient.save({ session });
            user.patientId = patient._id;
          }
          user.status = 'active';
          user.set('rejectionReason', undefined);
        }
        await user.save({ session });
        return detail(user);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    )
      throw conflict();
    throw error;
  } finally {
    await session.endSession();
  }
}
