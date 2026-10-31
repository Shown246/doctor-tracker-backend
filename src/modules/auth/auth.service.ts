import { randomBytes } from 'node:crypto';
import { ApiError } from '../../errors/api-error.js';
import { currentUserSchema } from './auth.schemas.js';
import type { RegistrationInput } from './auth.schemas.js';
import { hashPassword, verifyPassword } from './password.js';
import { User } from './user.model.js';

export const currentUserProjection = {
  name: 1,
  email: 1,
  role: 1,
  status: 1,
  doctorId: 1,
  patientId: 1,
  rejectionReason: 1,
} as const;

export async function findCurrentUser(id: string) {
  const user = await User.findById(id).select(currentUserProjection).lean();
  if (!user) return null;
  return currentUserSchema.parse({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    profileId:
      (user.role === 'doctor' ? user.doctorId : user.patientId)?.toString() ??
      null,
    ...(user.status === 'rejected' && user.rejectionReason
      ? { rejectionReason: user.rejectionReason }
      : {}),
  });
}

export async function register(input: RegistrationInput) {
  const passwordHash = await hashPassword(input.password);
  const user = await User.create({
    name: input.name,
    email: input.email,
    passwordHash,
    role: input.role,
    status: 'pending',
    pendingRegistration: { [input.role]: input.profile },
  });
  return (await findCurrentUser(user.id))!;
}

// A missing email still incurs Argon2 verification; no account-existence shortcut.
let dummyHash: Promise<string> | undefined;
export async function authenticate(email: string, password: string) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const fallbackHash = await (dummyHash ??= hashPassword(
    randomBytes(32).toString('hex'),
  ));
  const valid = await verifyPassword(
    user?.passwordHash ?? fallbackHash,
    password,
  );
  if (!valid || !user || user.status === 'disabled') {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  return user.id;
}
