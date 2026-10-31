import { ConfigurationError, parseEnvironment } from '../config/environment.js';
import type { Environment } from '../config/environment.js';
import { connectDatabase } from '../database/connection.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import { ApiError } from '../errors/api-error.js';

export async function runDatabaseCommand(
  action: (config: Environment, logger: Logger) => Promise<void>,
) {
  const fallbackLogger = createLogger();
  try {
    const config = parseEnvironment(process.env);
    const logger = createLogger(config.LOG_LEVEL);
    const disconnect = await connectDatabase(config, logger);
    try {
      await action(config, logger);
    } finally {
      await disconnect();
    }
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      fallbackLogger.error({ code: error.code }, error.message);
      process.exitCode = 1;
      return;
    }
    fallbackLogger.error(
      error instanceof ConfigurationError
        ? error.message
        : 'Command failed. Check configuration, database access, and command requirements.',
    );
    process.exitCode = 1;
  }
}
