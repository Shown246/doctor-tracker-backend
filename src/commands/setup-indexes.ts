import { setupIndexes } from '../database/indexes.js';
import { runDatabaseCommand } from './run-command.js';

await runDatabaseCommand(async (_config, logger) => {
  await setupIndexes();
  logger.info('Database indexes are ready');
});
