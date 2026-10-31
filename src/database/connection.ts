import mongoose from 'mongoose';
import { setServers } from 'node:dns';
import type { Environment } from '../config/environment.js';
import type { Logger } from '../logging/logger.js';

export async function connectDatabase(config: Environment, logger: Logger) {
  if (config.DNS_SERVERS.length) setServers(config.DNS_SERVERS);
  mongoose.set('bufferCommands', false);
  const connected = () => logger.info('Database connected');
  const disconnected = () => logger.warn('Database disconnected');
  const failed = () => logger.error('Database connection error');
  mongoose.connection.on('connected', connected);
  mongoose.connection.on('disconnected', disconnected);
  mongoose.connection.on('error', failed);
  const removeListeners = () => {
    mongoose.connection.off('connected', connected);
    mongoose.connection.off('disconnected', disconnected);
    mongoose.connection.off('error', failed);
  };
  try {
    await mongoose.connect(config.MONGODB_URI, {
      dbName: config.MONGODB_DATABASE,
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 20_000,
      heartbeatFrequencyMS: 5_000,
      maxPoolSize: 10,
      minPoolSize: 0,
      retryWrites: true,
    });
    // Transactions are a required capability, including in development.
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('A replica set is required');
    }
    return async () => {
      try {
        await mongoose.disconnect();
      } finally {
        removeListeners();
      }
    };
  } catch {
    await mongoose.disconnect().catch(() => undefined);
    removeListeners();
    throw new Error(
      'Database connection failed. Check credentials, Atlas network access, database name, DNS, and replica-set support.',
    );
  }
}

export async function isDatabaseReady() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db)
    return false;
  try {
    await mongoose.connection.db
      .admin()
      .command({ ping: 1 }, { timeoutMS: 2_000 });
    return true;
  } catch {
    return false;
  }
}
