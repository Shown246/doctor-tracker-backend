import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigurationError, parseEnvironment } from './config/environment.js';
import { connectDatabase, isDatabaseReady } from './database/connection.js';
import { createLogger } from './logging/logger.js';

export async function startServer(source: NodeJS.ProcessEnv = process.env) {
  const config = parseEnvironment(source);
  const logger = createLogger(config.LOG_LEVEL);
  const disconnect = await connectDatabase(config, logger);
  let stopping = false;
  const app = createApp({
    config,
    logger,
    isDatabaseReady: () =>
      stopping ? Promise.resolve(false) : isDatabaseReady(),
  });
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = createServer(app);
      listening.once('error', reject);
      listening.listen(config.PORT, '0.0.0.0', () => {
        listening.off('error', reject);
        resolve(listening);
      });
    });
  } catch {
    await disconnect();
    throw new Error('HTTP listener failed to start. Check PORT availability.');
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  logger.info({ port: config.PORT }, 'HTTP server listening');

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      stopping = true;
      logger.info('Shutdown started');
      const deadline = setTimeout(() => {
        logger.error('Shutdown deadline exceeded');
        process.exitCode = 1;
        server.closeAllConnections();
        void disconnect();
        process.exit(1);
      }, 10_000);
      deadline.unref();
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
        await disconnect();
        logger.info('Shutdown completed');
      } finally {
        clearTimeout(deadline);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    })();
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown().catch(() => {
      logger.error('Shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { server, shutdown };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer().catch((error: unknown) => {
    const logger = createLogger();
    logger.fatal(
      error instanceof ConfigurationError
        ? error.message
        : error instanceof Error &&
            error.message.startsWith('Database connection failed')
          ? error.message
          : 'Server startup failed. Check configuration and port availability.',
    );
    process.exitCode = 1;
  });
}
