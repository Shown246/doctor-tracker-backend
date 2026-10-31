import type { InferSchemaType, Types } from 'mongoose';
import type { Doctor } from '../modules/doctors/doctor.model.js';
import type { Patient } from '../modules/patients/patient.model.js';
import type { User } from '../modules/auth/user.model.js';

type WithId<T> = T & { _id: Types.ObjectId };
type DoctorRecord = WithId<InferSchemaType<typeof Doctor.schema>>;
type PatientRecord = WithId<InferSchemaType<typeof Patient.schema>>;
type UserRecord = WithId<InferSchemaType<typeof User.schema>>;

// Inclusion projections also apply to lean() queries, where transforms do not run.
export const doctorProjection = {
  name: 1,
  specialization: 1,
  hospital: 1,
  phone: 1,
  email: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;
export const patientProjection = {
  name: 1,
  dateOfBirth: 1,
  gender: 1,
  phone: 1,
  email: 1,
  address: 1,
  condition: 1,
  status: 1,
  revision: 1,
  lastClinicalUpdateAt: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;
export const accountProjection = {
  name: 1,
  email: 1,
  role: 1,
  status: 1,
} as const;

export function doctorDto(record: DoctorRecord) {
  return {
    id: record._id.toString(),
    name: record.name,
    specialization: record.specialization,
    hospital: record.hospital,
    phone: record.phone,
    email: record.email,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function patientDto(record: PatientRecord) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const age =
    Number(today.slice(0, 4)) -
    Number(record.dateOfBirth.slice(0, 4)) -
    (today.slice(5) < record.dateOfBirth.slice(5) ? 1 : 0);
  return {
    id: record._id.toString(),
    name: record.name,
    dateOfBirth: record.dateOfBirth,
    age,
    gender: record.gender,
    phone: record.phone,
    email: record.email,
    address: record.address,
    condition: record.condition,
    status: record.status,
    revision: record.revision,
    lastClinicalUpdateAt: record.lastClinicalUpdateAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function accountDto(record: UserRecord) {
  return {
    id: record._id.toString(),
    name: record.name,
    email: record.email,
    role: record.role,
    status: record.status,
  };
}
