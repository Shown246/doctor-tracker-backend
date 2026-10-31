import { z } from 'zod';
import { ApiError } from '../../errors/api-error.js';
import { User } from './user.model.js';
import { hashPassword, passwordSchema } from './password.js';

export const adminIdentitySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: passwordSchema,
});

export async function provisionAdmin(
  input: z.input<typeof adminIdentitySchema>,
) {
  const identity = adminIdentitySchema.parse(input);
  // Enforce uniqueness even when this is the first command run against a new database.
  await User.createIndexes();
  if (await User.exists({ email: identity.email })) {
    throw new ApiError(
      409,
      'ACCOUNT_EXISTS',
      'An account already uses this email',
    );
  }
  try {
    const user = await User.create({
      name: identity.name,
      email: identity.email,
      passwordHash: await hashPassword(identity.password),
      role: 'admin',
      status: 'active',
    });
    return { id: user._id.toString(), role: user.role, status: user.status };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    ) {
      throw new ApiError(
        409,
        'ACCOUNT_EXISTS',
        'An account already uses this email',
      );
    }
    throw error;
  }
}
