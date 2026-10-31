import { Types } from 'mongoose';
import type { PipelineStage } from 'mongoose';
import { assertActiveAccount } from '../auth/access.js';
import type { CurrentUser } from '../auth/auth.schemas.js';
import { Doctor } from '../doctors/doctor.model.js';
import { Patient, patientStatuses } from '../patients/patient.model.js';
import { DoctorPatient } from '../assignments/doctor-patient.model.js';
import { ApiError } from '../../errors/api-error.js';
import { dashboardRange, trendMatch, zeroFill } from './dashboard.time.js';
import type { DashboardRange } from './dashboard.time.js';
import type {
  AdminDashboard,
  DoctorDashboard,
  PatientDashboard,
} from './dashboard.schemas.js';

export function trendPipeline(
  field: string,
  range: DashboardRange,
): PipelineStage[] {
  return [
    { $match: { [field]: trendMatch(range) } },
    {
      $group: {
        _id: {
          $dateToString: {
            date: `$${field}`,
            format: range.interval === 'day' ? '%Y-%m-%d' : '%Y-%m-01',
            timezone: range.timezone,
          },
        },
        count: { $sum: 1 },
      },
    },
  ];
}
export const topDoctorsPipeline: PipelineStage[] = [
  { $project: { patientCount: { $literal: 0 } } },
  {
    $unionWith: {
      coll: 'doctorPatients',
      pipeline: [{ $group: { _id: '$doctorId', patientCount: { $sum: 1 } } }],
    },
  },
  { $group: { _id: '$_id', patientCount: { $max: '$patientCount' } } },
  { $sort: { patientCount: -1, _id: 1 } },
  { $limit: 10 },
  {
    $lookup: {
      from: 'doctors',
      localField: '_id',
      foreignField: '_id',
      pipeline: [{ $project: { name: 1 } }],
      as: 'doctor',
    },
  },
  { $unwind: '$doctor' },
  {
    $project: {
      _id: 0,
      doctorId: { $toString: '$_id' },
      name: '$doctor.name',
      patientCount: 1,
    },
  },
];
type StatusCount = { _id: (typeof patientStatuses)[number]; count: number };
function distribution(rows: StatusCount[]) {
  const counts = new Map(rows.map((row) => [row._id, row.count]));
  return patientStatuses.map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
}
async function adminDashboard(range: DashboardRange): Promise<AdminDashboard> {
  const [
    totalDoctors,
    totalPatients,
    patientsPerDoctor,
    doctors,
    patients,
    statuses,
  ] = await Promise.all([
    Doctor.countDocuments({}),
    Patient.countDocuments({}),
    Doctor.aggregate<AdminDashboard['patientsPerDoctor'][number]>(
      topDoctorsPipeline,
    ).allowDiskUse(true),
    Doctor.aggregate<{ _id: string; count: number }>(
      trendPipeline('createdAt', range),
    ),
    Patient.aggregate<{ _id: string; count: number }>(
      trendPipeline('createdAt', range),
    ),
    Patient.aggregate<StatusCount>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);
  return {
    role: 'admin',
    range,
    totalDoctors,
    totalPatients,
    patientsPerDoctor,
    doctorCreationTrend: zeroFill(range, doctors),
    patientCreationTrend: zeroFill(range, patients),
    patientStatusDistribution: distribution(statuses),
  };
}
async function doctorDashboard(
  account: CurrentUser,
  range: DashboardRange,
): Promise<DoctorDashboard> {
  const match = { doctorId: new Types.ObjectId(account.profileId!) };
  const [statuses, recent, trend] = await Promise.all([
    DoctorPatient.aggregate<StatusCount>([
      { $match: match },
      { $project: { patientId: 1 } },
      {
        $lookup: {
          from: 'patients',
          localField: 'patientId',
          foreignField: '_id',
          pipeline: [{ $project: { status: 1 } }],
          as: 'patient',
        },
      },
      { $unwind: '$patient' },
      { $group: { _id: '$patient.status', count: { $sum: 1 } } },
    ]),
    DoctorPatient.aggregate<
      Omit<DoctorDashboard['recentAssignments'][number], 'assignedAt'> & {
        assignedAt: Date;
      }
    >([
      { $match: match },
      { $sort: { assignedAt: -1, _id: -1 } },
      { $limit: 10 },
      { $project: { patientId: 1, assignedAt: 1 } },
      {
        $lookup: {
          from: 'patients',
          localField: 'patientId',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1, status: 1 } }],
          as: 'patient',
        },
      },
      { $unwind: '$patient' },
      {
        $project: {
          _id: 0,
          patientId: { $toString: '$patientId' },
          name: '$patient.name',
          status: '$patient.status',
          assignedAt: 1,
        },
      },
    ]),
    DoctorPatient.aggregate<{ _id: string; count: number }>([
      { $match: match },
      ...trendPipeline('assignedAt', range),
    ]),
  ]);
  return {
    role: 'doctor',
    range,
    assignedPatientCount: statuses.reduce((sum, row) => sum + row.count, 0),
    patientStatusDistribution: distribution(statuses),
    recentAssignments: recent.map((row) => ({
      ...row,
      assignedAt: row.assignedAt.toISOString(),
    })),
    assignmentTrend: zeroFill(range, trend),
  };
}
async function patientDashboard(
  account: CurrentUser,
): Promise<PatientDashboard> {
  const patient = await Patient.findById(account.profileId)
    .select('condition status lastClinicalUpdateAt')
    .lean();
  if (!patient) throw new ApiError(404, 'NOT_FOUND', 'Patient not found');
  const match = { patientId: patient._id };
  const [linkedDoctorCount, linkedDoctors] = await Promise.all([
    DoctorPatient.countDocuments(match),
    DoctorPatient.aggregate<PatientDashboard['linkedDoctors'][number]>([
      { $match: match },
      { $sort: { assignedAt: -1, _id: -1 } },
      { $limit: 10 },
      { $project: { doctorId: 1 } },
      {
        $lookup: {
          from: 'doctors',
          localField: 'doctorId',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1, specialization: 1, hospital: 1 } }],
          as: 'doctor',
        },
      },
      { $unwind: '$doctor' },
      {
        $project: {
          _id: 0,
          id: { $toString: '$doctor._id' },
          name: '$doctor.name',
          specialization: '$doctor.specialization',
          hospital: '$doctor.hospital',
        },
      },
    ]),
  ]);
  return {
    role: 'patient',
    patient: {
      id: patient._id.toString(),
      condition: patient.condition ?? null,
      status: patient.status,
      lastClinicalUpdateAt: patient.lastClinicalUpdateAt?.toISOString() ?? null,
    },
    linkedDoctorCount,
    linkedDoctors,
  };
}
export async function dashboard(
  account: CurrentUser,
  query: { from?: string | undefined; to?: string | undefined },
) {
  await assertActiveAccount(account);
  const range = dashboardRange(query);
  if (!range)
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid dashboard range');
  if (account.role === 'admin') return adminDashboard(range);
  if (account.role === 'doctor') return doctorDashboard(account, range);
  return patientDashboard(account);
}
