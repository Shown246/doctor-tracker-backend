import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';

export async function transaction<T>(
  work: (session: ClientSession) => Promise<T>,
) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}
