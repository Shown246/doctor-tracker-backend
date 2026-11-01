import { Types } from 'mongoose';
import type { ClientSession, PipelineStage, InferSchemaType } from 'mongoose';
import type { z } from 'zod';
import { ApiError } from '../../errors/api-error.js';
import { normalizeSearch } from '../../database/schema-helpers.js';
import { transaction } from '../../database/transaction.js';
import {
  doctorDto,
  doctorProjection,
  patientDto,
  patientProjection,
} from '../../http/dtos.js';
import { listFilter, listResult, listSort } from '../../http/list-query.js';
import { DoctorPatient } from '../assignments/doctor-patient.model.js';
import type { Doctor } from '../doctors/doctor.model.js';
import { User } from '../auth/user.model.js';
import { assertActiveAccount, assertRole } from '../auth/access.js';
import type { CurrentUser } from '../auth/auth.schemas.js';
import { Patient } from './patient.model.js';
import type {
  clinicalPatchSchema,
  contactPatchSchema,
  patientPatchSchema,
  patientQuerySchema,
} from './patient.schemas.js';

export const notFound = () =>
  new ApiError(404, 'NOT_FOUND', 'Patient not found');
export const revisionConflict = () =>
  new ApiError(
    409,
    'REVISION_CONFLICT',
    'The record has changed; reload before editing',
  );
export async function lockPatient(id: string, session: ClientSession) {
  const patient = await Patient.findById(id).session(session);
  if (!patient) throw notFound();
  // A real version write makes all relationship mutations conflict with deletion.
  patient.increment();
  await patient.save({ session });
  return patient;
}
async function linkedDoctorList(
  patientId: string,
  query: { page: number; limit: number },
) {
  const pipeline: PipelineStage[] = [
    { $match: { patientId: new Types.ObjectId(patientId) } },
    { $project: { doctorId: 1, assignedAt: 1 } },
    {
      $facet: {
        records: [
          { $sort: { assignedAt: -1, _id: -1 } },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          {
            $lookup: {
              from: 'doctors',
              localField: 'doctorId',
              foreignField: '_id',
              pipeline: [{ $project: doctorProjection }],
              as: 'doctor',
            },
          },
          { $unwind: '$doctor' },
          { $replaceWith: '$doctor' },
        ],
        count: [{ $count: 'total' }],
      },
    },
  ];
  const [result] = await DoctorPatient.aggregate<{
    records: (InferSchemaType<typeof Doctor.schema> & {
      _id: Types.ObjectId;
    })[];
    count: { total: number }[];
  }>(pipeline);
  return listResult(
    (result?.records ?? []).map(doctorDto),
    result?.count[0]?.total ?? 0,
    query,
  );
}
export async function linkedDoctors(
  query: { page: number; limit: number },
  account: CurrentUser,
) {
  await assertRole(account, 'patient');
  return linkedDoctorList(account.profileId!, query);
}
export async function patientDetail(
  id: string,
  account: CurrentUser,
  query: { page: number; limit: number },
) {
  await assertRole(account, 'admin', 'doctor');
  const doctorId = account.role === 'doctor' ? account.profileId : undefined;
  if (doctorId && !(await DoctorPatient.exists({ doctorId, patientId: id })))
    throw notFound();
  const record = await Patient.findById(id).select(patientProjection).lean();
  if (!record) throw notFound();
  const doctors = await linkedDoctorList(id, query);
  return {
    ...patientDto(record),
    linkedDoctors: doctors.data,
    linkedDoctorCount: doctors.meta.total,
    linkedDoctorsMeta: doctors.meta,
  };
}
export async function editPatient(
  id: string,
  input: z.infer<typeof patientPatchSchema>,
  account: CurrentUser,
) {
  await assertActiveAccount(account);
  if (account.role !== 'admin')
    throw new ApiError(403, 'FORBIDDEN', 'Access is forbidden');
  return transaction(async (session) => {
    const patient = await Patient.findById(id).session(session);
    if (!patient) throw notFound();
    if (
      input.email !== undefined &&
      (input.email ?? undefined) !== patient.email &&
      (await User.exists({ patientId: id }).session(session))
    )
      throw new ApiError(
        409,
        'EMAIL_IMMUTABLE',
        'Linked profile email cannot change',
      );
    if (input.name !== undefined) patient.name = input.name;
    if (input.dateOfBirth !== undefined)
      patient.dateOfBirth = input.dateOfBirth;
    if (input.gender !== undefined) patient.gender = input.gender;
    if (input.phone !== undefined) patient.phone = input.phone;
    if (input.email !== undefined)
      patient.set('email', input.email || undefined);
    if (input.address !== undefined)
      patient.set('address', input.address || undefined);
    if (input.condition !== undefined)
      patient.set('condition', input.condition || undefined);
    if (input.status !== undefined) patient.status = input.status;
    if (input.condition !== undefined || input.status !== undefined) {
      if (patient.revision !== input.revision) throw revisionConflict();
      patient.revision += 1;
      patient.lastClinicalEditor = new Types.ObjectId(account.id);
      patient.lastClinicalUpdateAt = new Date();
    }
    patient.increment();
    await patient.save({ session });
    return patientDto(patient);
  });
}
export async function listPatients(
  query: z.infer<typeof patientQuerySchema>,
  account: CurrentUser,
  scopedDoctorId?: string,
) {
  await assertRole(account, 'admin', 'doctor');
  const doctorId =
    account.role === 'doctor' ? account.profileId : scopedDoctorId;
  const plan = patientListPlan(query, doctorId ?? undefined);
  const [result] = await plan.model.aggregate<{
    records: (InferSchemaType<typeof Patient.schema> & {
      _id: Types.ObjectId;
    })[];
    count: { total: number }[];
  }>(plan.pipeline);
  return listResult(
    (result?.records ?? []).map(patientDto),
    result?.count[0]?.total ?? 0,
    query,
  );
}
export function patientListPlan(
  query: z.infer<typeof patientQuerySchema>,
  doctorId?: string,
) {
  const filter = {
    ...listFilter(query),
    ...(query.condition
      ? { conditionKey: normalizeSearch(query.condition) }
      : {}),
    ...(query.status ? { status: query.status } : {}),
  };
  // Start scoped queries at the indexed assignments, then join only those patients.
  const scopes = [
    ...new Set(
      [doctorId, query.doctorId]
        .filter((id): id is string => !!id)
        .map((id) => id.toLowerCase()),
    ),
  ];
  const pipeline: PipelineStage[] = scopes.length
    ? [
        { $match: { doctorId: new Types.ObjectId(scopes[0]!) } },
        { $project: { patientId: 1 } },
        {
          $lookup: {
            from: 'patients',
            localField: 'patientId',
            foreignField: '_id',
            pipeline: [
              { $match: filter },
              { $project: { ...patientProjection, nameKey: 1 } },
            ],
            as: 'patient',
          },
        },
        { $unwind: '$patient' },
        { $replaceWith: '$patient' },
        { $sort: listSort(query) },
      ]
    : [{ $match: filter }, { $sort: listSort(query) }];
  // A supplied doctor filter intersects the authenticated/path doctor scope.
  for (const scope of scopes.slice(1))
    pipeline.push(
      {
        $lookup: {
          from: 'doctorPatients',
          localField: '_id',
          foreignField: 'patientId',
          pipeline: [
            { $match: { doctorId: new Types.ObjectId(scope) } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'scope',
        },
      },
      { $match: { 'scope.0': { $exists: true } } },
    );
  pipeline.push({
    $facet: {
      records: [
        { $skip: (query.page - 1) * query.limit },
        { $limit: query.limit },
        { $project: patientProjection },
      ],
      count: [{ $count: 'total' }],
    },
  });
  return { model: scopes.length ? DoctorPatient : Patient, pipeline };
}
export async function updateClinical(
  id: string,
  input: z.infer<typeof clinicalPatchSchema>,
  account: CurrentUser,
) {
  await assertActiveAccount(account);
  if (account.role !== 'doctor')
    throw new ApiError(403, 'FORBIDDEN', 'Access is forbidden');
  return transaction(async (session) => {
    const assignment = await DoctorPatient.findOne({
      doctorId: account.profileId,
      patientId: id,
    }).session(session);
    if (!assignment) throw notFound();
    // Reading the association alone does not serialize against unlink. Version
    // writes force a transaction retry, which rechecks the current assignment.
    assignment.increment();
    await assignment.save({ session });
    const patient = await Patient.findById(id).session(session);
    if (!patient) throw notFound();
    if (patient.revision !== input.revision) throw revisionConflict();
    if (input.condition !== undefined)
      patient.set('condition', input.condition || undefined);
    if (input.status !== undefined) patient.status = input.status;
    patient.revision += 1;
    patient.lastClinicalEditor = new Types.ObjectId(account.id);
    patient.lastClinicalUpdateAt = new Date();
    await patient.save({ session });
    return patientDto(patient);
  });
}
export async function editContact(
  input: z.infer<typeof contactPatchSchema>,
  account: CurrentUser,
) {
  await assertActiveAccount(account);
  if (account.role !== 'patient')
    throw new ApiError(403, 'FORBIDDEN', 'Access is forbidden');
  return transaction(async (session) => {
    const patient = await Patient.findOne({
      _id: account.profileId,
      email: account.email,
    }).session(session);
    if (!patient) throw notFound();
    if (input.phone !== undefined) patient.phone = input.phone;
    if (input.address !== undefined)
      patient.set('address', input.address || undefined);
    patient.increment();
    await patient.save({ session });
    return patientDto(patient);
  });
}
export async function deletePatient(id: string, account: CurrentUser) {
  await assertRole(account, 'admin');
  return transaction(async (session) => {
    const patient = await lockPatient(id, session);
    await DoctorPatient.deleteMany({ patientId: id }).session(session);
    const user = await User.findOne({ patientId: id }).session(session);
    if (user) {
      user.status = 'disabled';
      user.set('patientId', undefined);
      await user.save({ session });
    }
    await patient.deleteOne({ session });
  });
}
