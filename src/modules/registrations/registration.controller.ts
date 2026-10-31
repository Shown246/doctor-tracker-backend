import type { RequestHandler } from 'express';
import { objectIdSchema } from '../auth/auth.schemas.js';
import {
  decisionResponseSchema,
  decisionSchema,
  registrationListResponseSchema,
  registrationQuerySchema,
} from './registration.schemas.js';
import {
  decideRegistration,
  listRegistrations,
  registrationDetail,
} from './registration.service.js';

export const list: RequestHandler = async (request, response) => {
  response.json(
    registrationListResponseSchema.parse(
      await listRegistrations(registrationQuerySchema.parse(request.query)),
    ),
  );
};
export const detail: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  response.json(
    decisionResponseSchema.parse({ data: await registrationDetail(id) }),
  );
};
export const decision: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const input = decisionSchema.parse(request.body);
  response.json(
    decisionResponseSchema.parse({ data: await decideRegistration(id, input) }),
  );
};
