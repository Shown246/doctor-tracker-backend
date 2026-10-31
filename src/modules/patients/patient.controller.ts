import type { RequestHandler } from 'express';
import { objectIdSchema } from '../auth/auth.schemas.js';
import { sendData } from '../../http/responses.js';
import { paginationSchema } from '../../http/list-query.js';
import {
  patientCreateSchema,
  patientPatchSchema,
  patientQuerySchema,
} from './patient.schemas.js';
import {
  createPatient,
  deletePatient,
  editPatient,
  listPatients,
  patientDetail,
} from './patient.service.js';

export const create: RequestHandler = async (request, response) => {
  sendData(
    response,
    await createPatient(
      patientCreateSchema.parse(request.body),
      request.account!,
    ),
    201,
  );
};
export const detail: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const query = paginationSchema.parse(request.query);
  sendData(response, await patientDetail(id, request.account!, query));
};
export const edit: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const input = patientPatchSchema.parse(request.body);
  sendData(response, await editPatient(id, input, request.account!));
};
export const remove: RequestHandler = async (request, response) => {
  await deletePatient(
    objectIdSchema.parse(request.params.id),
    request.account!,
  );
  response.sendStatus(204);
};
export const list: RequestHandler = async (request, response) => {
  response.json(
    await listPatients(
      patientQuerySchema.parse(request.query),
      request.account!,
    ),
  );
};
