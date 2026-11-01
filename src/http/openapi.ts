import { z } from 'zod';
import {
  csrfResponseSchema,
  currentUserResponseSchema,
  loginSchema,
  logoutSchema,
  objectIdSchema,
  registrationSchema,
} from '../modules/auth/auth.schemas.js';
import {
  decisionResponseSchema,
  decisionSchema,
  registrationListResponseSchema,
  registrationQuerySchema,
} from '../modules/registrations/registration.schemas.js';
import { SESSION_COOKIE_NAME } from '../modules/auth/session.js';
import { managementPaths, managementSchemas } from './management-openapi.js';
import { dashboardPaths, dashboardSchemas } from './dashboard-openapi.js';

const errorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.uuid(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const body = (name: string, required = true) => ({
  required,
  content: { 'application/json': { schema: ref(name) } },
});
const response = (name: string, description: string) => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});
const failure = (description: string) => response('Error', description);
const commonErrors = {
  '400': failure('Invalid body, query or identifier'),
  '401': failure('Missing, expired or invalid authentication'),
  '403': failure(
    'Invalid CSRF token/origin, forbidden role/status or unavailable profile',
  ),
  '413': failure('Request exceeds 32 KiB'),
  '415': failure('Unsupported request encoding or charset'),
  '500': failure('Unexpected server error'),
  '503': failure('Database is unavailable'),
};
const throttled = {
  ...failure('Too many attempts'),
  headers: {
    'Retry-After': {
      description: 'Seconds until the next fixed window',
      schema: { type: 'integer', minimum: 1 },
    },
  },
};
const session = [{ sessionCookie: [] }];
const mutation = [{ sessionCookie: [], csrfToken: [] }];
const csrfOnly = [{ csrfToken: [] }];
const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: json(objectIdSchema),
};

// Request and response JSON Schemas come directly from the runtime Zod contracts.
export function createOpenApiDocument() {
  const queryProperties = json(registrationQuerySchema).properties!;
  return {
    openapi: '3.1.0',
    info: {
      title: 'Doctor Tracker API',
      version: '1.0.0-rc.1',
      description:
        'Backend release candidate: sessions, approval, management, assignments, clinical care, private notes, role-scoped analytics and filter metadata. Timestamps are UTC; calendar dates use Asia/Dhaka. Every mutation requires a session-bound CSRF token. All authenticated data and documentation are private, no-store. Public exceptions: health, CSRF bootstrap, registration and login. Pending/rejected sessions may read auth/me and log out but cannot access portal data. Hosted acceptance is required before the v1.0.0 release.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'Authentication' },
      { name: 'Registrations' },
      { name: 'Management' },
      { name: 'Own profile and clinical care' },
      { name: 'Analytics' },
      { name: 'Operations' },
    ],
    paths: {
      ...managementPaths(),
      ...dashboardPaths(),
      '/health/live': {
        get: {
          tags: ['Operations'],
          operationId: 'getLiveness',
          summary: 'Public process liveness',
          servers: [{ url: '/' }],
          security: [],
          responses: {
            '200': response('LivenessResponse', 'Process is alive'),
          },
        },
      },
      '/health/ready': {
        get: {
          tags: ['Operations'],
          operationId: 'getReadiness',
          summary: 'Public bounded database readiness',
          servers: [{ url: '/' }],
          security: [],
          responses: {
            '200': response('ReadinessResponse', 'Database ping succeeded'),
            '503': failure('Database unavailable'),
          },
        },
      },
      '/docs': {
        get: {
          tags: ['Operations'],
          operationId: 'getInteractiveDocs',
          summary: 'Interactive API explorer (active admin only)',
          security: session,
          responses: {
            ...commonErrors,
            '200': {
              description: 'Admin-only documentation; private, no-store',
              content: { 'text/html': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/docs/openapi.json': {
        get: {
          tags: ['Operations'],
          operationId: 'getOpenApiContract',
          summary: 'Download the runtime OpenAPI contract (active admin only)',
          security: session,
          responses: {
            ...commonErrors,
            '200': {
              description:
                'OpenAPI 3.1 document; same content as the repository artifact',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/auth/csrf': {
        get: {
          tags: ['Authentication'],
          operationId: 'getCsrfToken',
          summary: 'Establish a session-bound CSRF token',
          security: [],
          description:
            'Retain the cookie. Supply the token as X-CSRF-Token for every mutation. Login regenerates the session and invalidates the old token; fetch this endpoint again after login. Safe for pending/rejected sessions. Browser Origin or Referer, when supplied, must match FRONTEND_ORIGIN exactly. No credentialed cross-origin CORS is enabled; browser clients use the frontend same-origin proxy.',
          responses: {
            ...commonErrors,
            '200': response(
              'CsrfResponse',
              'Session-bound token; private, no-store',
            ),
          },
        },
      },
      '/auth/register': {
        post: {
          tags: ['Authentication'],
          operationId: 'registerAccount',
          summary:
            'Register an active patient account or submit a doctor account for approval',
          security: csrfOnly,
          requestBody: body('Registration'),
          description:
            'Patients receive an active account and linked unassessed patient profile immediately. Doctors receive a pending account without a profile and require admin approval. Does not log in. Existing profile emails are not automatically linked. Requires a previously established CSRF session. Only doctor/patient roles and the listed fields are accepted. Ten attempts per IP per fixed one-hour window.',
          responses: {
            ...commonErrors,
            '201': response(
              'CurrentUserResponse',
              'Active patient or pending doctor account',
            ),
            '409': failure('Email is already in use'),
            '429': throttled,
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Authentication'],
          operationId: 'login',
          summary: 'Authenticate and regenerate the session',
          security: csrfOnly,
          requestBody: body('Login'),
          description:
            'Pending and rejected accounts can log in for status display. Disabled and invalid credentials receive the same generic 401. Eight-hour absolute lifetime; activity never extends it. Fetch /auth/csrf after login. Limits: 30 attempts/IP and 10 attempts/normalized-email+IP per fixed 15-minute window, including successful attempts.',
          responses: {
            ...commonErrors,
            '200': response(
              'CurrentUserResponse',
              'Current account and regenerated session cookie',
            ),
            '429': throttled,
          },
        },
      },
      '/auth/me': {
        get: {
          tags: ['Authentication'],
          operationId: 'getCurrentUser',
          summary: 'Read current account state',
          security: session,
          description:
            'Loads current database state. Pending/rejected accounts receive status and, for rejected accounts, the optional reason. Active doctor/patient profiles must exist and match the account email. No password hashes or submitted profile details are returned.',
          responses: {
            ...commonErrors,
            '200': response(
              'CurrentUserResponse',
              'Current user; private, no-store',
            ),
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Authentication'],
          operationId: 'logout',
          summary: 'Destroy session and clear the matching cookie',
          security: mutation,
          requestBody: body('Logout', false),
          description:
            'Also permitted for pending, rejected and subsequently disabled session holders. No body or an empty JSON object is accepted.',
          responses: {
            ...commonErrors,
            '204': {
              description: 'Session destroyed; empty body and expired cookie',
            },
          },
        },
      },
      '/registrations': {
        get: {
          tags: ['Registrations'],
          operationId: 'listRegistrations',
          summary: 'List registration submissions (active admin only)',
          security: session,
          description:
            'Default sort: createdAt descending, then _id descending. Includes only public registration submissions, including decided submissions. Does not include submitted profile details.',
          parameters: Object.entries(queryProperties).map(([name, schema]) => ({
            name,
            in: 'query',
            required: false,
            schema,
          })),
          responses: {
            ...commonErrors,
            '200': response(
              'RegistrationListResponse',
              'Paginated registration summaries',
            ),
          },
        },
      },
      '/registrations/{id}': {
        get: {
          tags: ['Registrations'],
          operationId: 'getRegistration',
          summary: 'Review submitted profile details (active admin only)',
          security: session,
          parameters: [idParameter],
          responses: {
            ...commonErrors,
            '200': response(
              'RegistrationDetailResponse',
              'Registration with submitted profile',
            ),
            '404': failure('Registration not found'),
          },
        },
      },
      '/registrations/{id}/decision': {
        put: {
          tags: ['Registrations'],
          operationId: 'decideRegistration',
          summary:
            'Approve or reject a pending registration (active admin only)',
          security: mutation,
          parameters: [idParameter],
          requestBody: body('RegistrationDecision'),
          description:
            'A decision is final in v1. Approve with mode=create or mode=link and an explicit matching-email, unclaimed profileId. Create uses submitted fields. New patients require patientClinical with condition and status; use an empty condition string to confirm no condition. Doctor decisions reject patientClinical. Linking preserves existing profile data. Approval and profile linkage/creation are atomic. Duplicate or competing decisions return 409. Rejection retains the submission and optional reason.',
          responses: {
            ...commonErrors,
            '200': response(
              'RegistrationDetailResponse',
              'Decided registration',
            ),
            '404': failure('Registration not found'),
            '409': failure(
              'Registration already decided, profile mismatches/is claimed or a matching profile already exists',
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_NAME,
          description:
            'Host-only HttpOnly SameSite=Lax cookie, Secure in production; eight-hour absolute lifetime.',
        },
        csrfToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-CSRF-Token',
          description:
            'Token from /auth/csrf, bound to the retained session cookie.',
        },
      },
      schemas: {
        ...Object.fromEntries(
          Object.entries({ ...managementSchemas, ...dashboardSchemas }).map(
            ([name, schema]) => [name, json(schema)],
          ),
        ),
        Registration: json(registrationSchema),
        Login: json(loginSchema),
        Logout: json(logoutSchema),
        CurrentUserResponse: json(currentUserResponseSchema),
        CsrfResponse: json(csrfResponseSchema),
        RegistrationDecision: json(decisionSchema),
        RegistrationListResponse: json(registrationListResponseSchema),
        RegistrationDetailResponse: json(decisionResponseSchema),
        Error: json(errorSchema),
        LivenessResponse: json(
          z.strictObject({
            data: z.strictObject({ status: z.literal('alive') }),
          }),
        ),
        ReadinessResponse: json(
          z.strictObject({
            data: z.strictObject({ status: z.literal('ready') }),
          }),
        ),
      },
    },
  };
}
