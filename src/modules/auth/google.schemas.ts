import { z } from 'zod';
import {
  doctorRegistrationSchema,
  patientRegistrationSchema,
} from './auth.schemas.js';
import { passwordSchema } from './password.js';

export const googleRegistrationSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('doctor'),
    profile: doctorRegistrationSchema,
  }),
  z.strictObject({
    role: z.literal('patient'),
    profile: patientRegistrationSchema,
  }),
]);
export const googleLinkSchema = z.strictObject({ password: passwordSchema });
export const googleStartResponseSchema = z.strictObject({
  data: z.strictObject({ url: z.url() }),
});
export const googlePendingResponseSchema = z.strictObject({
  data: z.strictObject({
    name: z.string(),
    email: z.email(),
    existingAccount: z.boolean(),
  }),
});
