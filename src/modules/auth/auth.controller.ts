import type { RequestHandler } from 'express';
import type { Environment } from '../../config/environment.js';
import { assertActiveAccount } from './access.js';
import { ApiError } from '../../errors/api-error.js';
import {
  csrfResponseSchema,
  currentUserResponseSchema,
  loginSchema,
  logoutSchema,
  registrationSchema,
} from './auth.schemas.js';
import { authenticate, findCurrentUser, register } from './auth.service.js';
import {
  clearSessionCookie,
  destroySession,
  regenerateSession,
  saveSession,
  startSession,
} from './session.js';

export const csrfToken: RequestHandler = async (request, response) => {
  if (!request.session.csrfToken) startSession(request);
  await saveSession(request);
  response.json(
    csrfResponseSchema.parse({
      data: { csrfToken: request.session.csrfToken },
    }),
  );
};
export const registerAccount: RequestHandler = async (request, response) => {
  const account = await register(registrationSchema.parse(request.body));
  response.status(201).json(currentUserResponseSchema.parse({ data: account }));
};
export const login: RequestHandler = async (request, response) => {
  const input = loginSchema.parse(request.body);
  const id = await authenticate(input.email, input.password);
  await regenerateSession(request);
  startSession(request, id);
  await saveSession(request);
  response.json(
    currentUserResponseSchema.parse({ data: await findCurrentUser(id) }),
  );
};
export const currentUser: RequestHandler = async (request, response) => {
  if (request.account?.status === 'active')
    await assertActiveAccount(request.account);
  response.json(currentUserResponseSchema.parse({ data: request.account }));
};
export function logout(config: Environment): RequestHandler {
  return async (request, response) => {
    logoutSchema.parse(request.body ?? {});
    if (!request.session.userId)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required');
    await destroySession(request);
    clearSessionCookie(response, config);
    response.status(204).end();
  };
}
