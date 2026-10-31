import argon2 from 'argon2';
import { z } from 'zod';

export const passwordSchema = z.string().min(12).max(128);

export async function hashPassword(password: string) {
  const validated = passwordSchema.parse(password);
  return argon2.hash(validated, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string) {
  if (!passwordSchema.safeParse(password).success) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
