import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { parseEnvironment } from '../config/environment.js';
import { connectDatabase } from '../database/connection.js';
import { setupIndexes } from '../database/indexes.js';
import {
  performanceSizeSchema,
  seedPerformance,
} from '../database/fixtures.js';
import { collectQueryPlans } from '../database/query-plans.js';
import { createLogger } from '../logging/logger.js';

// This command deliberately does not load .env or use an external URI.
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
try {
  const config = parseEnvironment({
    NODE_ENV: 'test',
    MONGODB_URI: replica.getUri(),
    MONGODB_DATABASE: 'doctor_tracker_performance_test',
    SESSION_SECRET: 'isolated-performance-session-secret-unused',
    FRONTEND_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
  });
  await connectDatabase(config, createLogger('silent'));
  await setupIndexes();
  const size = performanceSizeSchema.parse({
    doctors: process.env.PERF_DOCTORS,
    patients: process.env.PERF_PATIENTS,
  });
  console.log(
    `Creating ${size.doctors} synthetic doctors and ${size.patients} synthetic patients in an isolated replica set`,
  );
  await seedPerformance(size);
  const report = await collectQueryPlans();
  await writeFile(
    new URL('../../docs/query-plans.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `Recorded ${report.plans.length} query plans and ${report.countChecks.length} count checks in docs/query-plans.json`,
  );
} catch {
  console.error(
    'Performance verification failed; no external database was used',
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  await replica.stop();
}
