import { z } from 'zod';
import {
  dashboardQuerySchema,
  dashboardResponseSchema,
  adminDashboardSchema,
  doctorDashboardSchema,
  patientDashboardSchema,
} from '../modules/dashboards/dashboard.schemas.js';
import {
  filterQuerySchema,
  filterResponseSchema,
} from '../modules/dashboards/filter.schemas.js';

export const dashboardSchemas = {
  DashboardResponse: dashboardResponseSchema,
  AdminDashboard: adminDashboardSchema,
  DoctorDashboard: doctorDashboardSchema,
  PatientDashboard: patientDashboardSchema,
  FilterResponse: filterResponseSchema,
};
const response = (schema: string, description: string) => ({
  description,
  content: {
    'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
  },
});
function operation(
  operationId: string,
  summary: string,
  schema: string,
  query: z.ZodType,
  description: string,
) {
  const properties =
    z.toJSONSchema(query, { io: 'input', target: 'draft-2020-12' })
      .properties ?? {};
  return {
    tags: ['Analytics'],
    operationId,
    summary,
    description,
    security: [{ sessionCookie: [] }],
    parameters: Object.entries(properties).map(([name, schema]) => ({
      name,
      in: 'query',
      required: false,
      schema,
    })),
    responses: {
      '200': response(
        schema,
        'Successful role-scoped response; private, no-store',
      ),
      '400': response(
        'Error',
        'Invalid query, unknown parameter or date range',
      ),
      '401': response('Error', 'Authentication required'),
      '403': response(
        'Error',
        'Inactive account, unavailable profile or unsupported role/filter',
      ),
      '500': response('Error', 'Unexpected server error'),
      '503': response('Error', 'Database unavailable'),
    },
  };
}
export function dashboardPaths() {
  return {
    '/dashboard': {
      get: operation(
        'getDashboard',
        'Read the active account’s role-specific dashboard',
        'DashboardResponse',
        dashboardQuerySchema,
        'Identity comes exclusively from the session. from/to are inclusive Asia/Dhaka YYYY-MM-DD dates. to defaults to today; from defaults to 29 calendar days before to. Maximum 365 inclusive calendar days. Daily buckets through 90 days, monthly afterward; month labels use the first day of the month, with partial boundary months counting only the requested dates. Missing buckets and all five statuses are zero-filled. Totals/statuses describe all current records/assignments regardless of range; trends describe stored records/current assignments, not visits or historical assignment snapshots. Admin totals count each patient once; top ten doctors include zero-patient doctors and tie by ID; use GET /doctors for paginated details. Doctor recent assignments are the latest ten, independent of range. Patient response has own clinical fields and at most ten linked-doctor summaries (latest first); use GET /me/doctors for pagination. Date parameters are validated but do not affect the patient response. No private notes are returned.',
      ),
    },
    '/filters': {
      get: operation(
        'getFilterOptions',
        'Look up permitted filter values (admin/doctor)',
        'FilterResponse',
        filterQuerySchema,
        'field defaults to condition. Admins may request specialization, hospital, condition or status. Doctors may request condition/status and only values from their currently assigned patients contribute to records or totals. Patients are forbidden. Values and labels use normalized exact-filter keys; absent/empty fields are omitted. Options are deduplicated and sorted ascending, with escaped literal normalized prefix search. Default page=1 and limit=20, maximum limit=100. Totals count permitted matching unique options, never hidden records. No frequency counts are exposed.',
      ),
    },
  };
}
