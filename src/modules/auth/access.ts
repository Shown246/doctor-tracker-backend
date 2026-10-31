import type { RequestHandler } from 'express';
import { ApiError } from '../../errors/api-error.js';
import { Doctor } from '../doctors/doctor.model.js';
import { Patient } from '../patients/patient.model.js';
import { DoctorPatient } from '../assignments/doctor-patient.model.js';
import type { CurrentUser } from './auth.schemas.js';
import { objectIdSchema } from './auth.schemas.js';
import {
  doctorDto,
  doctorProjection,
  patientDto,
  patientProjection,
} from '../../http/dtos.js';
import type { ClientSession } from 'mongoose';

export const requireAuthentication: RequestHandler = (
  request,
  _response,
  next,
) => {
  if (!request.account)
    return next(
      new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required'),
    );
  if (request.account.status === 'disabled')
    return next(new ApiError(403, 'ACCOUNT_DISABLED', 'Account is disabled'));
  next();
};

export async function assertActiveAccount(account: CurrentUser) {
  if (account.status !== 'active')
    throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Account approval is required');
  if (account.role === 'admin') return;
  const filter = { _id: account.profileId, email: account.email };
  const exists =
    account.profileId &&
    (account.role === 'doctor'
      ? await Doctor.exists(filter)
      : await Patient.exists(filter));
  if (!exists)
    throw new ApiError(
      403,
      'PROFILE_UNAVAILABLE',
      'Linked profile is unavailable',
    );
}

export async function assertRole(
  account: CurrentUser,
  ...roles: CurrentUser['role'][]
) {
  await assertActiveAccount(account);
  if (!roles.includes(account.role))
    throw new ApiError(403, 'FORBIDDEN', 'Access is forbidden');
}

export const requireActiveAccount: RequestHandler = async (
  request,
  _response,
  next,
) => {
  if (!request.account)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required');
  await assertActiveAccount(request.account);
  next();
};

export function allowRoles(...roles: CurrentUser['role'][]): RequestHandler {
  return (request, _response, next) => {
    if (!request.account)
      return next(
        new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required'),
      );
    if (!roles.includes(request.account.role))
      return next(new ApiError(403, 'FORBIDDEN', 'Access is forbidden'));
    next();
  };
}

export async function ownProfile(account: CurrentUser) {
  await assertActiveAccount(account);
  if (account.role === 'admin')
    throw new ApiError(403, 'FORBIDDEN', 'This role has no profile');
  if (account.role === 'doctor') {
    const doctor = await Doctor.findOne({
      _id: account.profileId,
      email: account.email,
    })
      .select(doctorProjection)
      .lean();
    if (doctor) return doctorDto(doctor);
  } else {
    const patient = await Patient.findOne({
      _id: account.profileId,
      email: account.email,
    })
      .select(patientProjection)
      .lean();
    if (patient) return patientDto(patient);
  }
  throw new ApiError(404, 'NOT_FOUND', 'Profile not found');
}

// A scope read alone is not a write lock. Clinical writes additionally serialize
// against unlinking with an association version write in patient.service.ts.
export async function requirePatientScope(
  account: CurrentUser,
  patientId: string,
  session?: ClientSession,
) {
  objectIdSchema.parse(patientId);
  await assertActiveAccount(account);
  const options = session ? { session } : {};
  if (
    account.role === 'patient' &&
    account.profileId !== patientId.toLowerCase()
  ) {
    throw new ApiError(404, 'NOT_FOUND', 'Patient not found');
  }
  if (
    account.role === 'doctor' &&
    !(await DoctorPatient.exists({
      doctorId: account.profileId,
      patientId,
    }).setOptions(options))
  ) {
    throw new ApiError(404, 'NOT_FOUND', 'Patient not found');
  }
  if (!(await Patient.exists({ _id: patientId }).setOptions(options)))
    throw new ApiError(404, 'NOT_FOUND', 'Patient not found');
  return {
    patientId,
    ...(account.role === 'doctor' ? { doctorId: account.profileId! } : {}),
  };
}
