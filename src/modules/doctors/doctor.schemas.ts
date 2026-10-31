import { z } from 'zod';
import { emailSchema, text } from '../auth/auth.schemas.js';
import { listFields, validRange } from '../../http/list-query.js';

export const doctorFields = {
  name: text(120),
  specialization: text(120),
  hospital: text(200),
  phone: text(32),
  email: emailSchema,
};
export const doctorCreateSchema = z.strictObject(doctorFields);
export const doctorPatchSchema = doctorCreateSchema
  .partial()
  .refine((input) => Object.keys(input).length > 0);
export const doctorQuerySchema = z
  .strictObject({
    ...listFields,
    specialization: text(120).optional(),
    hospital: text(200).optional(),
  })
  .refine(validRange, { path: ['to'] });
