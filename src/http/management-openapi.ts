import { z } from 'zod';
import { objectIdSchema } from '../modules/auth/auth.schemas.js';
import {
  doctorCreateSchema,
  doctorPatchSchema,
  doctorQuerySchema,
} from '../modules/doctors/doctor.schemas.js';
import {
  clinicalPatchSchema,
  contactPatchSchema,
  patientPatchSchema,
  patientQuerySchema,
} from '../modules/patients/patient.schemas.js';
import {
  noteDeleteSchema,
  notePutSchema,
} from '../modules/assignments/assignment.schemas.js';
import { genders, patientStatuses } from '../modules/patients/patient.model.js';
import { paginationSchema } from './list-query.js';

export const doctorResponseSchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  specialization: z.string(),
  hospital: z.string(),
  phone: z.string(),
  email: z.email(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const patientResponseSchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  dateOfBirth: z.iso.date(),
  age: z.number().int().min(0),
  gender: z.enum(genders),
  phone: z.string(),
  email: z.email().optional(),
  address: z.string().optional(),
  condition: z.string().optional(),
  status: z.enum(patientStatuses),
  revision: z.number().int().min(0),
  lastClinicalUpdateAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const noteResponseSchema = z.strictObject({
  note: z.string().nullable(),
  revision: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
});
const detailSchema = patientResponseSchema.extend({
  linkedDoctors: z.array(doctorResponseSchema).max(100),
  linkedDoctorCount: z.number().int().min(0),
  linkedDoctorsMeta: z.strictObject({
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  }),
});
const single = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ data: schema });
const list = <T extends z.ZodType>(schema: T) =>
  z.strictObject({
    data: z.array(schema),
    meta: z.strictObject({
      page: z.number().int().min(1),
      limit: z.number().int().min(1).max(100),
      total: z.number().int().min(0),
      totalPages: z.number().int().min(0),
    }),
  });
export const managementSchemas = {
  DoctorCreate: doctorCreateSchema,
  DoctorPatch: doctorPatchSchema,
  PatientPatch: patientPatchSchema,
  ClinicalPatch: clinicalPatchSchema,
  ContactPatch: contactPatchSchema,
  NotePut: notePutSchema,
  NoteDelete: noteDeleteSchema,
  DoctorResponse: single(doctorResponseSchema),
  PatientResponse: single(patientResponseSchema),
  PatientDetailResponse: single(detailSchema),
  DoctorListResponse: list(
    doctorResponseSchema.extend({ patientCount: z.number().int().min(0) }),
  ),
  PatientListResponse: list(patientResponseSchema),
  LinkedDoctorListResponse: list(doctorResponseSchema),
  OwnProfileResponse: single(
    z.union([doctorResponseSchema, patientResponseSchema]),
  ),
  NoteResponse: single(noteResponseSchema),
  NoteListResponse: list(
    noteResponseSchema.extend({ doctor: doctorResponseSchema }),
  ),
  AssignmentResponse: single(
    z.strictObject({
      doctorId: objectIdSchema,
      patientId: objectIdSchema,
      assignedAt: z.iso.datetime(),
    }),
  ),
};

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string) => ({
  'application/json': { schema: ref(name) },
});
const failure = (description: string) => ({
  description,
  content: content('Error'),
});
const errors = {
  '400': failure(
    'Invalid identifier, body or query; unsupported fields are rejected',
  ),
  '401': failure('Authentication is required or has expired'),
  '403': failure(
    'Forbidden role, inactive account, missing profile, invalid CSRF token or browser origin',
  ),
  '404': failure(
    'Profile or assignment not found; doctors receive 404 outside their scope',
  ),
  '409': failure(
    'Stale revision, duplicate email or attempted linked-profile email change',
  ),
  '413': failure('Request exceeds 32 KiB'),
  '415': failure('Unsupported request encoding or charset'),
  '500': failure('Unexpected server error'),
  '503': failure('Database unavailable'),
};
const parameters = (path: string, query?: z.ZodType) => [
  ...[...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1]!,
    in: 'path',
    required: true,
    schema: json(objectIdSchema),
  })),
  ...Object.entries(query ? (json(query).properties ?? {}) : {}).map(
    ([name, schema]) => ({ name, in: 'query', required: false, schema }),
  ),
];
function operation(
  method: string,
  path: string,
  summary: string,
  result: string | undefined,
  options: {
    body?: string;
    query?: z.ZodType;
    description?: string;
    example?: unknown;
    status?: number;
  } = {},
) {
  const mutation = method !== 'get';
  const status =
    options.status ??
    (method === 'post' ? 201 : method === 'delete' ? 204 : 200);
  return {
    tags: [
      path.startsWith('/me') ? 'Own profile and clinical care' : 'Management',
    ],
    operationId: `${method}${path.replace(/[^\w]/g, '_')}`,
    summary,
    description:
      options.description ??
      'Requires an active account and valid linked profile. Responses are private, no-store.',
    security: [
      mutation ? { sessionCookie: [], csrfToken: [] } : { sessionCookie: [] },
    ],
    parameters: parameters(path, options.query),
    ...(options.body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: ref(options.body),
                ...(options.example ? { example: options.example } : {}),
              },
            },
          },
        }
      : {}),
    responses: {
      ...errors,
      [status]: result
        ? {
            description: 'Successful response; private, no-store',
            content: content(result),
          }
        : { description: 'Success; empty body' },
    },
  };
}
const listDescription =
  'Defaults: page=1, limit=20 (maximum 100), sort=-createdAt. Sort supports createdAt, -createdAt, name, -name with _id in the same direction as a stable tie-breaker. search is a normalized, escaped literal prefix of full fields or word tokens. Exact descriptor filters are normalized. from/to are inclusive YYYY-MM-DD creation dates in Asia/Dhaka using IANA timezone rules. Reversed/invalid ranges and unknown parameters are rejected. Missing pages are empty; totalPages=0 for no matches.';
export function managementPaths() {
  return {
    '/doctors': {
      get: operation(
        'get',
        '/doctors',
        'List doctors and patient counts (admin)',
        'DoctorListResponse',
        { query: doctorQuerySchema, description: listDescription },
      ),
      post: operation(
        'post',
        '/doctors',
        'Create a doctor profile (admin)',
        'DoctorResponse',
        {
          body: 'DoctorCreate',
          example: {
            name: 'Dr Example',
            email: 'doctor@example.test',
            specialization: 'Cardiology',
            hospital: 'Example Hospital',
            phone: '+8801700000000',
          },
        },
      ),
    },
    '/doctors/{id}': {
      get: operation(
        'get',
        '/doctors/{id}',
        'Read a doctor (admin)',
        'DoctorResponse',
      ),
      patch: operation(
        'patch',
        '/doctors/{id}',
        'Edit doctor fields (admin)',
        'DoctorResponse',
        {
          body: 'DoctorPatch',
          description:
            'Only listed fields are editable. Email is immutable after account linkage, including disabled linked accounts. Search keys are regenerated. Competing writes retry transactionally.',
        },
      ),
    },
    '/patients': {
      get: operation(
        'get',
        '/patients',
        'List patients (admin)',
        'PatientListResponse',
        { query: patientQuerySchema, description: listDescription },
      ),
    },
    '/patients/{id}': {
      get: operation(
        'get',
        '/patients/{id}',
        'Read patient and linked-doctor summaries (admin)',
        'PatientDetailResponse',
        {
          query: paginationSchema,
          description:
            'Includes linkedDoctors with linkedDoctorsMeta and the full linkedDoctorCount. page/limit paginate these summaries (default 20, maximum 100), newest assignments first. Notes are available only through the separate admin review endpoint.',
        },
      ),
      patch: operation(
        'patch',
        '/patients/{id}',
        'Edit demographics or shared clinical fields (admin)',
        'PatientResponse',
        {
          body: 'PatientPatch',
          description:
            'Assignments and internal fields are forbidden. Email cannot change or be removed after account linkage. A clinical change requires the last-read revision and increments it, recording the editor and UTC time. A revision without clinical fields is rejected. Empty condition clears it; null email/address clears those optional fields.',
        },
      ),
      delete: operation(
        'delete',
        '/patients/{id}',
        'Permanently delete a patient (admin)',
        undefined,
        {
          description:
            'Atomically removes the patient and every association/private note, disables its linked patient account and clears the profile reference. Existing patient sessions lose portal access. Concurrent assignment/clinical/note writes serialize with deletion. A missing patient returns 404.',
        },
      ),
    },
    '/doctors/{doctorId}/patients': {
      get: operation(
        'get',
        '/doctors/{doctorId}/patients',
        'List patients assigned to a doctor (admin)',
        'PatientListResponse',
        {
          query: patientQuerySchema,
          description: `${listDescription} The path doctor must exist. Any doctorId query filter intersects the path scope.`,
        },
      ),
    },
    '/doctors/{doctorId}/patients/{patientId}': {
      put: operation(
        'put',
        '/doctors/{doctorId}/patients/{patientId}',
        'Link a doctor and patient (admin)',
        'AssignmentResponse',
        {
          description:
            'No body or {}. Both profiles must exist. Repeated and simultaneous links succeed with one association and preserve its assignment date and note.',
        },
      ),
      delete: operation(
        'delete',
        '/doctors/{doctorId}/patients/{patientId}',
        "Unlink a doctor and delete that doctor's note (admin)",
        undefined,
        {
          description:
            'No body or {}. Deletes the association and its note together. Other doctors and the patient remain. The removed doctor immediately loses access. Repeated removal succeeds if both profiles exist. Relinking starts with an empty note at revision zero.',
        },
      ),
    },
    '/patients/{patientId}/doctor-notes': {
      get: operation(
        'get',
        '/patients/{patientId}/doctor-notes',
        'Review private notes with doctor attribution (admin, read-only)',
        'NoteListResponse',
        {
          query: paginationSchema,
          description:
            'Paginated nonempty notes, most recently updated first with _id tie-breaker. Cleared/empty notes are excluded. Admin cannot mutate notes.',
        },
      ),
    },
    '/me/profile': {
      get: operation(
        'get',
        '/me/profile',
        'Read the session-linked doctor or patient profile',
        'OwnProfileResponse',
      ),
      patch: operation(
        'patch',
        '/me/profile',
        'Update own phone/address (patient)',
        'PatientResponse',
        {
          body: 'ContactPatch',
          example: { phone: '+8801800000000', address: 'Synthetic address' },
          description:
            'Patient only; phone and address exclusively. Null/empty address clears it. Identity, clinical fields, email and references are forbidden. Does not change clinical revision.',
        },
      ),
    },
    '/me/doctors': {
      get: operation(
        'get',
        '/me/doctors',
        'List own linked doctors (patient)',
        'LinkedDoctorListResponse',
        {
          query: paginationSchema,
          description:
            'Newest assignments first with _id tie-breaker. Profile comes exclusively from the session. No notes or account internals.',
        },
      ),
    },
    '/me/patients': {
      get: operation(
        'get',
        '/me/patients',
        'List currently assigned patients (doctor)',
        'PatientListResponse',
        {
          query: patientQuerySchema,
          description: `${listDescription} Session doctor scope applies to records and totals. doctorId, if supplied, further intersects the session scope and cannot impersonate another doctor.`,
        },
      ),
    },
    '/me/patients/{patientId}': {
      get: operation(
        'get',
        '/me/patients/{patientId}',
        'Read an assigned patient (doctor)',
        'PatientDetailResponse',
        {
          query: paginationSchema,
          description:
            'Current assignment required; outside scope returns 404. page/limit paginate safe linkedDoctors (default 20, maximum 100); linkedDoctorsMeta and linkedDoctorCount describe the full list. No notes in this DTO.',
        },
      ),
    },
    '/me/patients/{patientId}/clinical': {
      patch: operation(
        'patch',
        '/me/patients/{patientId}/clinical',
        'Update shared condition/status (assigned doctor)',
        'PatientResponse',
        {
          body: 'ClinicalPatch',
          example: {
            condition: 'Routine observation',
            status: 'stable',
            revision: 0,
          },
          description:
            'Only condition/status and last-read patient revision. At least one clinical field is required. Empty condition clears it. Increments revision and records the editor/time atomically. Stale revision returns 409. The assignment is guarded by a write inside the transaction, so concurrent unlink/deletion cannot complete a stale authorized update.',
        },
      ),
    },
    '/me/patients/{patientId}/note': {
      get: operation(
        'get',
        '/me/patients/{patientId}/note',
        'Read own private note (assigned doctor)',
        'NoteResponse',
        {
          description:
            'Derives the doctor from the session. An existing assignment without a note returns {note:null,revision:0,updatedAt:null}; after clearing, the revision and timestamp are preserved. Other doctors and patients cannot read it.',
        },
      ),
      put: operation(
        'put',
        '/me/patients/{patientId}/note',
        'Replace own private note (assigned doctor)',
        'NoteResponse',
        {
          body: 'NotePut',
          example: { note: 'Synthetic clinical note', revision: 0 },
          description:
            'One trimmed note of 1–20000 characters per association. Supply the last-read note revision, distinct from patient clinical revision. Successful writes increment it. Stale revisions return 409; missing assignment returns 404.',
        },
      ),
      delete: operation(
        'delete',
        '/me/patients/{patientId}/note',
        'Clear own private note (assigned doctor)',
        undefined,
        {
          body: 'NoteDelete',
          example: { revision: 1 },
          description:
            'Requires the last-read note revision in the JSON body. Clears note content but increments/preserves its revision and update timestamp to reject stale writes. Returns 204; GET again to read the new revision. Clearing an already empty note with the current revision succeeds and increments it.',
        },
      ),
    },
  };
}
