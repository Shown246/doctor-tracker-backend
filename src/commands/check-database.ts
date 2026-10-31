import { isDatabaseReady } from '../database/connection.js';
import { runDatabaseCommand } from './run-command.js';

await runDatabaseCommand(async (config, logger) => {
  if (!(await isDatabaseReady())) throw new Error('Database ping failed');
  logger.info(
    { database: config.MONGODB_DATABASE, replicaSet: true },
    'Database connection and ping succeeded',
  );
});
