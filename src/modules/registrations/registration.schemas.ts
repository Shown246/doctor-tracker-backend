import { z } from 'zod';
import {
  doctorRegistrationSchema,
  patientRegistrationSchema,
  emailSchema,
  objectIdSchema,
  text,
} from '../auth/auth.schemas.js';
import { patientStatuses } from '../patients/patient.model.js';

export const registrationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'active', 'rejected', 'disabled']).optional(),
  role: z.enum(['doctor', 'patient']).optional(),
});
const clinicalConfirmationSchema = z.strictObject({
  condition: z.string().trim().max(2000),
  status: z.enum(patientStatuses),
});
export const decisionSchema = z.union([
  z.strictObject({
    decision: z.literal('reject'),
    reason: text(1000).optional(),
  }),
  z.strictObject({
    decision: z.literal('approve'),
    mode: z.literal('link'),
    profileId: objectIdSchema,
  }),
  z.strictObject({
    decision: z.literal('approve'),
    mode: z.literal('create'),
    patientClinical: clinicalConfirmationSchema.optional(),
  }),
]);
export type DecisionInput = z.infer<typeof decisionSchema>;
const summaryFields = {
  id: objectIdSchema,
  name: z.string(),
  email: emailSchema,
  role: z.enum(['doctor', 'patient']),
  status: z.enum(['pending', 'active', 'rejected', 'disabled']),
  profileId: objectIdSchema.nullable(),
  rejectionReason: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
export const registrationSummarySchema = z.strictObject(summaryFields);
export const registrationDetailSchema = z.union([
  z.strictObject({
    ...summaryFields,
    role: z.literal('doctor'),
    profile: doctorRegistrationSchema,
  }),
  z.strictObject({
    ...summaryFields,
    role: z.literal('patient'),
    profile: patientRegistrationSchema,
  }),
]);
export const decisionResponseSchema = z.strictObject({
  data: registrationDetailSchema,
});
export const registrationListResponseSchema = z.strictObject({
  data: z.array(registrationSummarySchema),
  meta: z.strictObject({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});
