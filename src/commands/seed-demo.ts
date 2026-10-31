import { runDatabaseCommand } from './run-command.js';
import { setupIndexes } from '../database/indexes.js';
import {
  assertFixtureTarget,
  demoCredentials,
  seedDemo,
} from '../database/fixtures.js';

await runDatabaseCommand(async (config, logger) => {
  assertFixtureTarget(config, process.env, 'demo');
  const credentials = demoCredentials(process.env);
  await setupIndexes();
  const result = await seedDemo(credentials);
  logger.info(
    result,
    'Synthetic demo seed complete; existing credentials preserved',
  );
});
