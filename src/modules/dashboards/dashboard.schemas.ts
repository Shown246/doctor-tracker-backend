import { z } from 'zod';
import { calendarDateSchema } from '../../http/list-query.js';
import { objectIdSchema } from '../auth/auth.schemas.js';
import { patientStatuses } from '../patients/patient.model.js';
import { dashboardRange } from './dashboard.time.js';

export const dashboardQuerySchema = z
  .strictObject({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
  })
  .superRefine((query, context) => {
    if (!dashboardRange(query))
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Use an ordered range of at most 365 calendar days',
      });
  });
const count = z.number().int().min(0);
export const dashboardRangeSchema = z.strictObject({
  from: calendarDateSchema,
  to: calendarDateSchema,
  timezone: z.literal('Asia/Dhaka'),
  interval: z.enum(['day', 'month']),
});
const bucket = z.strictObject({ date: calendarDateSchema, count });
const distribution = z
  .array(z.strictObject({ status: z.enum(patientStatuses), count }))
  .length(5);
export const adminDashboardSchema = z.strictObject({
  role: z.literal('admin'),
  range: dashboardRangeSchema,
  totalDoctors: count,
  totalPatients: count,
  patientsPerDoctor: z
    .array(
      z.strictObject({
        doctorId: objectIdSchema,
        name: z.string(),
        patientCount: count,
      }),
    )
    .max(10),
  doctorCreationTrend: z.array(bucket).max(90),
  patientCreationTrend: z.array(bucket).max(90),
  patientStatusDistribution: distribution,
});
export const doctorDashboardSchema = z.strictObject({
  role: z.literal('doctor'),
  range: dashboardRangeSchema,
  assignedPatientCount: count,
  patientStatusDistribution: distribution,
  recentAssignments: z
    .array(
      z.strictObject({
        patientId: objectIdSchema,
        name: z.string(),
        status: z.enum(patientStatuses),
        assignedAt: z.iso.datetime(),
      }),
    )
    .max(10),
  assignmentTrend: z.array(bucket).max(90),
});
export const patientDashboardSchema = z.strictObject({
  role: z.literal('patient'),
  patient: z.strictObject({
    id: objectIdSchema,
    condition: z.string().nullable(),
    status: z.enum(patientStatuses),
    lastClinicalUpdateAt: z.iso.datetime().nullable(),
  }),
  linkedDoctorCount: count,
  linkedDoctors: z
    .array(
      z.strictObject({
        id: objectIdSchema,
        name: z.string(),
        specialization: z.string(),
        hospital: z.string(),
      }),
    )
    .max(10),
});
export const dashboardResponseSchema = z.strictObject({
  data: z.discriminatedUnion('role', [
    adminDashboardSchema,
    doctorDashboardSchema,
    patientDashboardSchema,
  ]),
});
export type AdminDashboard = z.infer<typeof adminDashboardSchema>;
export type DoctorDashboard = z.infer<typeof doctorDashboardSchema>;
export type PatientDashboard = z.infer<typeof patientDashboardSchema>;
