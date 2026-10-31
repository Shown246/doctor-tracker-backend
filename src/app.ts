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
import { doctorRoutes } from './modules/doctors/doctor.routes.js';
import { patientRoutes } from './modules/patients/patient.routes.js';
import { assignmentRoutes } from './modules/assignments/assignment.routes.js';
import { profileRoutes } from './modules/profiles/profile.routes.js';
import { dashboardRoutes } from './modules/dashboards/dashboard.routes.js';
import { docsRoutes } from './http/docs.js';

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
  api.use('/doctors', ...security, doctorRoutes());
  api.use('/patients', ...security, patientRoutes());
  api.use('/me', ...security, profileRoutes());
  api.use('/dashboard', ...security);
  api.use('/filters', ...security);
  api.use(dashboardRoutes());
  api.use('/docs', ...security, docsRoutes());
  // Doctor/patient prefix routers already establish security for these nested routes.
  api.use(assignmentRoutes());
  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
