import { z } from 'zod';
import { isValidBirthDate } from '../../database/schema-helpers.js';
import { genders } from '../patients/patient.model.js';
import { passwordSchema } from './password.js';

export const text = (max: number) => z.string().trim().min(1).max(max);
export const emailSchema = z.string().trim().toLowerCase().max(254).email();
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
export const doctorRegistrationSchema = z.strictObject({
  specialization: text(120),
  hospital: text(200),
  phone: text(32),
});
export const patientRegistrationSchema = z.strictObject({
  dateOfBirth: z.string().refine(isValidBirthDate),
  gender: z.enum(genders),
  phone: text(32),
  address: text(500).optional(),
});
const credentials = {
  name: text(120),
  email: emailSchema,
  password: passwordSchema,
};
export const registrationSchema = z.discriminatedUnion('role', [
  z.strictObject({
    ...credentials,
    role: z.literal('doctor'),
    profile: doctorRegistrationSchema,
  }),
  z.strictObject({
    ...credentials,
    role: z.literal('patient'),
    profile: patientRegistrationSchema,
  }),
]);
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
});
export const logoutSchema = z.strictObject({});
export const currentUserSchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  email: emailSchema,
  role: z.enum(['admin', 'doctor', 'patient']),
  status: z.enum(['pending', 'active', 'rejected', 'disabled']),
  profileId: objectIdSchema.nullable(),
  rejectionReason: z.string().optional(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type RegistrationInput = z.infer<typeof registrationSchema>;
export const currentUserResponseSchema = z.strictObject({
  data: currentUserSchema,
});
export const csrfResponseSchema = z.strictObject({
  data: z.strictObject({ csrfToken: z.string().regex(/^[a-f\d]{64}$/) }),
});
// Logout has a 204 response with no body.
export const logoutResponseSchema = z.undefined();
