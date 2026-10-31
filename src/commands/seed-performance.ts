import { runDatabaseCommand } from './run-command.js';
import { setupIndexes } from '../database/indexes.js';
import {
  assertFixtureTarget,
  performanceSizeSchema,
  seedPerformance,
} from '../database/fixtures.js';

await runDatabaseCommand(async (config, logger) => {
  assertFixtureTarget(config, process.env, 'performance');
  const size = performanceSizeSchema.parse({
    doctors: process.env.PERF_DOCTORS,
    patients: process.env.PERF_PATIENTS,
  });
  await setupIndexes();
  logger.info(
    await seedPerformance(size),
    'Synthetic performance fixtures complete',
  );
});
