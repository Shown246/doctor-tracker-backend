import { z } from 'zod';
import { isValidBirthDate } from '../../database/schema-helpers.js';
import { listFields, validRange } from '../../http/list-query.js';
import { emailSchema, objectIdSchema, text } from '../auth/auth.schemas.js';
import { genders, patientStatuses } from './patient.model.js';

export const revisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const clinicalFields = {
  condition: z.string().trim().max(2000),
  status: z.enum(patientStatuses),
};
const patientFields = {
  name: text(120),
  dateOfBirth: z.string().refine(isValidBirthDate),
  gender: z.enum(genders),
  phone: text(32),
  email: emailSchema.nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  condition: clinicalFields.condition.optional(),
  status: clinicalFields.status.default('unassessed'),
};
export const patientPatchSchema = z
  .strictObject({
    ...patientFields,
    status: clinicalFields.status,
    revision: revisionSchema,
  })
  .partial()
  .refine((input) => Object.keys(input).some((key) => key !== 'revision'))
  .refine(
    (input) =>
      (input.condition === undefined && input.status === undefined) ||
      input.revision !== undefined,
    { path: ['revision'] },
  )
  .refine(
    (input) =>
      input.revision === undefined ||
      input.condition !== undefined ||
      input.status !== undefined,
    { path: ['revision'] },
  );
export const clinicalPatchSchema = z
  .strictObject({
    condition: clinicalFields.condition.optional(),
    status: clinicalFields.status.optional(),
    revision: revisionSchema,
  })
  .refine(
    (input) => input.condition !== undefined || input.status !== undefined,
  );
export const patientQuerySchema = z
  .strictObject({
    ...listFields,
    condition: text(2000).optional(),
    status: z.enum(patientStatuses).optional(),
    doctorId: objectIdSchema.optional(),
  })
  .refine(validRange, { path: ['to'] });
export const contactPatchSchema = z
  .strictObject({
    phone: text(32).optional(),
    address: z.string().trim().max(500).nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0);
