import { z } from 'zod';
import { objectIdSchema } from '../auth/auth.schemas.js';
import { revisionSchema } from '../patients/patient.schemas.js';

export const assignmentParamsSchema = z.strictObject({
  doctorId: objectIdSchema,
  patientId: objectIdSchema,
});
export const emptyBodySchema = z.strictObject({}).optional();
export const notePutSchema = z.strictObject({
  note: z.string().trim().min(1).max(20_000),
  revision: revisionSchema,
});
export const noteDeleteSchema = z.strictObject({ revision: revisionSchema });
