import express, { Router } from 'express';
import helmet from 'helmet';
import type { Environment } from './config/environment.js';
import { ApiError } from './errors/api-error.js';
import { sendData } from './http/responses.js';
import type { Logger } from './logging/logger.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { requestContext } from './middleware/request-context.js';
import { sessionSecurity } from './modules/auth/session.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { registrationRoutes } from './modules/registrations/registration.routes.js';

export interface AppDependencies {
  config: Environment;
  logger: Logger;
  isDatabaseReady: () => Promise<boolean>;
}

export function createApp({
  config,
  logger,
  isDatabaseReady,
}: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(requestContext(logger));
  app.use(helmet());
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/health/live', (_request, response) => {
    sendData(response, { status: 'alive' });
  });
  app.get('/health/ready', async (_request, response) => {
    if (!(await isDatabaseReady())) {
      throw new ApiError(503, 'NOT_READY', 'Database is unavailable');
    }
    sendData(response, { status: 'ready' });
  });

  const api = Router();
  const security = sessionSecurity(config);
  api.use('/auth', ...security, authRoutes(config));
  api.use('/registrations', ...security, registrationRoutes());
  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
