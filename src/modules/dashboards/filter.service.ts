import { Types } from 'mongoose';
import type { PipelineStage } from 'mongoose';
import type { z } from 'zod';
import type { CurrentUser } from '../auth/auth.schemas.js';
import { assertRole } from '../auth/access.js';
import { Doctor } from '../doctors/doctor.model.js';
import { Patient } from '../patients/patient.model.js';
import { DoctorPatient } from '../assignments/doctor-patient.model.js';
import { ApiError } from '../../errors/api-error.js';
import {
  listFilter,
  listQuerySchema,
  listResult,
} from '../../http/list-query.js';
import type { filterQuerySchema } from './filter.schemas.js';

export function filterPipeline(
  query: z.infer<typeof filterQuerySchema>,
  doctorId?: string,
): PipelineStage[] {
  const key = query.field === 'status' ? 'status' : `${query.field}Key`;
  const prefix = listFilter(
    listQuerySchema.parse({ search: query.search }),
  ).searchKeys;
  const match = { [key]: { $gt: '', ...(prefix ? { $regex: prefix } : {}) } };
  const pipeline: PipelineStage[] = doctorId
    ? [
        { $match: { doctorId: new Types.ObjectId(doctorId) } },
        { $project: { patientId: 1 } },
        {
          $lookup: {
            from: 'patients',
            localField: 'patientId',
            foreignField: '_id',
            pipeline: [{ $match: match }, { $project: { [key]: 1 } }],
            as: 'patient',
          },
        },
        { $unwind: '$patient' },
        { $replaceWith: '$patient' },
      ]
    : [{ $match: match }];
  pipeline.push(
    { $group: { _id: `$${key}` } },
    { $sort: { _id: 1 } },
    {
      $facet: {
        records: [
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          { $project: { _id: 0, value: '$_id', label: '$_id' } },
        ],
        count: [{ $count: 'total' }],
      },
    },
  );
  return pipeline;
}
export async function filterOptions(
  account: CurrentUser,
  query: z.infer<typeof filterQuerySchema>,
) {
  await assertRole(account, 'admin', 'doctor');
  const doctors =
    query.field === 'specialization' || query.field === 'hospital';
  if (account.role === 'doctor' && doctors)
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only patient filters are available to doctors',
    );
  const model =
    account.role === 'doctor' ? DoctorPatient : doctors ? Doctor : Patient;
  const [result] = await model
    .aggregate<{
      records: { value: string; label: string }[];
      count: { total: number }[];
    }>(
      filterPipeline(
        query,
        account.role === 'doctor' ? account.profileId! : undefined,
      ),
    )
    .allowDiskUse(true);
  return listResult(result?.records ?? [], result?.count[0]?.total ?? 0, query);
}
