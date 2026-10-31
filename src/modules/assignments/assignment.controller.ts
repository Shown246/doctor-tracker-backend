import type { RequestHandler } from 'express';
import { sendData } from '../../http/responses.js';
import { paginationSchema } from '../../http/list-query.js';
import { objectIdSchema } from '../auth/auth.schemas.js';
import { doctorDetail } from '../doctors/doctor.service.js';
import { listPatients } from '../patients/patient.service.js';
import { patientQuerySchema } from '../patients/patient.schemas.js';
import {
  assignmentParamsSchema,
  emptyBodySchema,
} from './assignment.schemas.js';
import {
  linkPatient,
  reviewNotes,
  unlinkPatient,
} from './assignment.service.js';

export const link: RequestHandler = async (request, response) => {
  const { doctorId, patientId } = assignmentParamsSchema.parse(request.params);
  emptyBodySchema.parse(request.body);
  sendData(response, await linkPatient(doctorId, patientId, request.account!));
};
export const unlink: RequestHandler = async (request, response) => {
  const { doctorId, patientId } = assignmentParamsSchema.parse(request.params);
  emptyBodySchema.parse(request.body);
  await unlinkPatient(doctorId, patientId, request.account!);
  response.sendStatus(204);
};
export const patients: RequestHandler = async (request, response) => {
  const doctorId = objectIdSchema.parse(request.params.doctorId);
  const query = patientQuerySchema.parse(request.query);
  await doctorDetail(doctorId, request.account!);
  response.json(await listPatients(query, request.account!, doctorId));
};
export const notes: RequestHandler = async (request, response) => {
  const patientId = objectIdSchema.parse(request.params.patientId);
  const query = paginationSchema.parse(request.query);
  response.json(await reviewNotes(patientId, query, request.account!));
};
