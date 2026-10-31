import type { RequestHandler } from 'express';
import { sendData } from '../../http/responses.js';
import { paginationSchema } from '../../http/list-query.js';
import { objectIdSchema } from '../auth/auth.schemas.js';
import { ownProfile } from '../auth/access.js';
import {
  noteDeleteSchema,
  notePutSchema,
} from '../assignments/assignment.schemas.js';
import { readNote, writeNote } from '../assignments/assignment.service.js';
import {
  clinicalPatchSchema,
  contactPatchSchema,
  patientQuerySchema,
} from '../patients/patient.schemas.js';
import {
  editContact,
  linkedDoctors,
  listPatients,
  patientDetail,
  updateClinical,
} from '../patients/patient.service.js';

export const profile: RequestHandler = async (request, response) => {
  sendData(response, await ownProfile(request.account!));
};
export const contact: RequestHandler = async (request, response) => {
  sendData(
    response,
    await editContact(contactPatchSchema.parse(request.body), request.account!),
  );
};
export const doctors: RequestHandler = async (request, response) => {
  response.json(
    await linkedDoctors(
      paginationSchema.parse(request.query),
      request.account!,
    ),
  );
};
export const patients: RequestHandler = async (request, response) => {
  response.json(
    await listPatients(
      patientQuerySchema.parse(request.query),
      request.account!,
    ),
  );
};
export const patient: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.patientId);
  const query = paginationSchema.parse(request.query);
  sendData(response, await patientDetail(id, request.account!, query));
};
export const clinical: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.patientId);
  const input = clinicalPatchSchema.parse(request.body);
  sendData(response, await updateClinical(id, input, request.account!));
};
export const note: RequestHandler = async (request, response) => {
  sendData(
    response,
    await readNote(
      objectIdSchema.parse(request.params.patientId),
      request.account!,
    ),
  );
};
export const putNote: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.patientId);
  const input = notePutSchema.parse(request.body);
  sendData(
    response,
    await writeNote(id, input.revision, input.note, request.account!),
  );
};
export const clearNote: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.patientId);
  const input = noteDeleteSchema.parse(request.body);
  await writeNote(id, input.revision, undefined, request.account!);
  response.sendStatus(204);
};
