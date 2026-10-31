import type { z } from 'zod';
import type { Types } from 'mongoose';
import { Doctor } from './doctor.model.js';
import { User } from '../auth/user.model.js';
import { DoctorPatient } from '../assignments/doctor-patient.model.js';
import { ApiError } from '../../errors/api-error.js';
import { normalizeSearch } from '../../database/schema-helpers.js';
import { transaction } from '../../database/transaction.js';
import { doctorDto, doctorProjection } from '../../http/dtos.js';
import { listFilter, listResult, listSort } from '../../http/list-query.js';
import type {
  doctorCreateSchema,
  doctorPatchSchema,
  doctorQuerySchema,
} from './doctor.schemas.js';
import { assertRole } from '../auth/access.js';
import type { CurrentUser } from '../auth/auth.schemas.js';

export async function createDoctor(
  input: z.infer<typeof doctorCreateSchema>,
  account: CurrentUser,
) {
  await assertRole(account, 'admin');
  return doctorDto(await Doctor.create(input));
}
export async function doctorDetail(id: string, account: CurrentUser) {
  await assertRole(account, 'admin');
  const record = await Doctor.findById(id).select(doctorProjection).lean();
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Doctor not found');
  return doctorDto(record);
}
export async function editDoctor(
  id: string,
  input: z.infer<typeof doctorPatchSchema>,
  account: CurrentUser,
) {
  await assertRole(account, 'admin');
  return transaction(async (session) => {
    const record = await Doctor.findById(id).session(session);
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Doctor not found');
    if (
      input.email !== undefined &&
      input.email !== record.email &&
      (await User.exists({ doctorId: id }).session(session))
    )
      throw new ApiError(
        409,
        'EMAIL_IMMUTABLE',
        'Linked profile email cannot change',
      );
    record.set(input);
    // Shares a write with approval, including a same-value patch.
    record.increment();
    await record.save({ session });
    return doctorDto(record);
  });
}
export async function listDoctors(
  query: z.infer<typeof doctorQuerySchema>,
  account: CurrentUser,
) {
  await assertRole(account, 'admin');
  const filter = {
    ...listFilter(query),
    ...(query.specialization
      ? { specializationKey: normalizeSearch(query.specialization) }
      : {}),
    ...(query.hospital ? { hospitalKey: normalizeSearch(query.hospital) } : {}),
  };
  const [records, total] = await Promise.all([
    Doctor.find(filter)
      .select(doctorProjection)
      .sort(listSort(query))
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Doctor.countDocuments(filter),
  ]);
  const counts = await DoctorPatient.aggregate<{
    _id: Types.ObjectId;
    count: number;
  }>([
    { $match: { doctorId: { $in: records.map((record) => record._id) } } },
    { $group: { _id: '$doctorId', count: { $sum: 1 } } },
  ]);
  const byId = new Map(
    counts.map((count) => [count._id.toString(), count.count]),
  );
  return listResult(
    records.map((record) => ({
      ...doctorDto(record),
      patientCount: byId.get(record._id.toString()) ?? 0,
    })),
    total,
    query,
  );
}
