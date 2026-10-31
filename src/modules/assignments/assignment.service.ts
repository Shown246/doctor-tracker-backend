import { Types } from 'mongoose';
import type { InferSchemaType } from 'mongoose';
import { transaction } from '../../database/transaction.js';
import { ApiError } from '../../errors/api-error.js';
import { listResult } from '../../http/list-query.js';
import { doctorDto, doctorProjection } from '../../http/dtos.js';
import { Doctor } from '../doctors/doctor.model.js';
import { Patient } from '../patients/patient.model.js';
import { assertActiveAccount, assertRole } from '../auth/access.js';
import type { CurrentUser } from '../auth/auth.schemas.js';
import { DoctorPatient } from './doctor-patient.model.js';
import {
  lockPatient,
  notFound,
  revisionConflict,
} from '../patients/patient.service.js';

export async function linkPatient(
  doctorId: string,
  patientId: string,
  account: CurrentUser,
) {
  await assertRole(account, 'admin');
  return transaction(async (session) => {
    if (!(await Doctor.exists({ _id: doctorId }).session(session)))
      throw new ApiError(404, 'NOT_FOUND', 'Doctor not found');
    await lockPatient(patientId, session);
    let record = await DoctorPatient.findOne({ doctorId, patientId }).session(
      session,
    );
    if (!record) {
      record = new DoctorPatient({ doctorId, patientId });
      await record.save({ session });
    }
    return {
      doctorId: record.doctorId.toString(),
      patientId: record.patientId.toString(),
      assignedAt: record.assignedAt,
    };
  });
}
export async function unlinkPatient(
  doctorId: string,
  patientId: string,
  account: CurrentUser,
) {
  await assertRole(account, 'admin');
  return transaction(async (session) => {
    if (!(await Doctor.exists({ _id: doctorId }).session(session)))
      throw new ApiError(404, 'NOT_FOUND', 'Doctor not found');
    await lockPatient(patientId, session);
    await DoctorPatient.deleteOne({ doctorId, patientId }).session(session);
  });
}
function noteDto(record: {
  privateNote?: string | null | undefined;
  noteRevision: number;
  noteUpdatedAt?: Date | null | undefined;
}) {
  return {
    note: record.privateNote ?? null,
    revision: record.noteRevision,
    updatedAt: record.noteUpdatedAt ?? null,
  };
}
async function assertDoctor(account: CurrentUser) {
  await assertActiveAccount(account);
  if (account.role !== 'doctor')
    throw new ApiError(403, 'FORBIDDEN', 'Access is forbidden');
}
export async function readNote(patientId: string, account: CurrentUser) {
  await assertDoctor(account);
  const record = await DoctorPatient.findOne({
    doctorId: account.profileId,
    patientId,
  })
    .select('+privateNote')
    .lean();
  if (!record || !(await Patient.exists({ _id: patientId }))) throw notFound();
  return noteDto(record);
}
export async function writeNote(
  patientId: string,
  revision: number,
  note: string | undefined,
  account: CurrentUser,
) {
  await assertDoctor(account);
  return transaction(async (session) => {
    const record = await DoctorPatient.findOne({
      doctorId: account.profileId,
      patientId,
    })
      .select('+privateNote')
      .session(session);
    if (!record || !(await Patient.exists({ _id: patientId }).session(session)))
      throw notFound();
    if (record.noteRevision !== revision) throw revisionConflict();
    record.set('privateNote', note);
    record.noteRevision += 1;
    record.noteUpdatedAt = new Date();
    await record.save({ session });
    return noteDto(record);
  });
}
export async function reviewNotes(
  patientId: string,
  query: { page: number; limit: number },
  account: CurrentUser,
) {
  await assertRole(account, 'admin');
  if (!(await Patient.exists({ _id: patientId }))) throw notFound();
  const filter = {
    patientId: new Types.ObjectId(patientId),
    privateNote: { $type: 'string' },
  };
  const [result] = await DoctorPatient.aggregate<{
    records: {
      doctor: InferSchemaType<typeof Doctor.schema> & { _id: Types.ObjectId };
      privateNote: string;
      noteRevision: number;
      noteUpdatedAt?: Date;
    }[];
    count: { total: number }[];
  }>([
    { $match: filter },
    {
      $facet: {
        records: [
          { $sort: { noteUpdatedAt: -1, _id: -1 } },
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
          {
            $project: {
              doctor: 1,
              privateNote: 1,
              noteRevision: 1,
              noteUpdatedAt: 1,
            },
          },
        ],
        count: [{ $count: 'total' }],
      },
    },
  ]);
  return listResult(
    (result?.records ?? []).map((record) => ({
      doctor: doctorDto(record.doctor),
      ...noteDto(record),
    })),
    result?.count[0]?.total ?? 0,
    query,
  );
}
