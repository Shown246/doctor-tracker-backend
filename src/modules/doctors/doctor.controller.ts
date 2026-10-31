import type { RequestHandler } from 'express';
import { objectIdSchema } from '../auth/auth.schemas.js';
import { sendData } from '../../http/responses.js';
import {
  doctorCreateSchema,
  doctorPatchSchema,
  doctorQuerySchema,
} from './doctor.schemas.js';
import {
  createDoctor,
  doctorDetail,
  editDoctor,
  listDoctors,
} from './doctor.service.js';

export const create: RequestHandler = async (request, response) => {
  sendData(
    response,
    await createDoctor(
      doctorCreateSchema.parse(request.body),
      request.account!,
    ),
    201,
  );
};
export const detail: RequestHandler = async (request, response) => {
  sendData(
    response,
    await doctorDetail(
      objectIdSchema.parse(request.params.id),
      request.account!,
    ),
  );
};
export const edit: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const input = doctorPatchSchema.parse(request.body);
  sendData(response, await editDoctor(id, input, request.account!));
};
export const list: RequestHandler = async (request, response) => {
  response.json(
    await listDoctors(doctorQuerySchema.parse(request.query), request.account!),
  );
};
