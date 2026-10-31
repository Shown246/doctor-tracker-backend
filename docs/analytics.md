# Dashboards and filter lookup

Both endpoints require a current active account, a valid linked profile for doctors/patients, and the retained session cookie. Responses are `private, no-store`. Identities come from the session; query parameters such as `doctorId`, `patientId` or `role` are rejected.

## `GET /api/v1/dashboard`

The `{ data }` response is discriminated by `data.role`. Runtime TypeScript and OpenAPI response schemas are defined separately for each role.

| Role    | Response fields                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin   | `totalDoctors`, `totalPatients`, `patientsPerDoctor` (top ten), `doctorCreationTrend`, `patientCreationTrend`, `patientStatusDistribution`, `range` |
| Doctor  | `assignedPatientCount`, `patientStatusDistribution`, `recentAssignments` (latest ten), `assignmentTrend`, `range`                                   |
| Patient | Own `patient: { id, condition, status, lastClinicalUpdateAt }`, `linkedDoctorCount`, `linkedDoctors` (latest ten safe summaries)                    |

Admin totals count stored profiles, including unassigned patients and profiles without logins. A patient shared by doctors counts once in `totalPatients`, and once for each applicable doctor in `patientsPerDoctor`. The top ten sorts by count descending then doctor ID ascending and includes zero-patient doctors when space permits. `GET /doctors` provides the existing paginated breakdown with patient counts.

Doctor summaries use only current assignments. Unlinking removes that assignment from counts, recent records and trends. Recent assignments sort by `assignedAt` descending, then assignment ID descending. Patient summaries contain only their own clinical data and doctor names/specializations/hospitals; no private notes, other patients' statistics, account details or clinical editor identity. Missing condition/update time is explicitly `null`. Use `GET /me/doctors` for the full paginated linked-doctor list.

### Calendar range

`from` and `to` are inclusive, real `YYYY-MM-DD` dates in `Asia/Dhaka`. `to` defaults to today there. `from` defaults to 29 calendar days before `to`. Maximum range is **365 inclusive calendar days**; reversed or larger ranges return 400. Daily buckets apply through 90 days; monthly buckets apply afterward. All missing buckets have `count: 0`. Each status distribution always includes all five statuses, with zero counts where needed.

Daily bucket labels use that local date. Monthly labels use the first day of the month; partial first/last months include only the requested dates. Counts use IANA timezone rules, including historical offset changes. For example, `from=2026-10-01&to=2026-10-31` covers UTC `2026-09-30T18:00:00Z` through, but excluding, `2026-10-31T18:00:00Z`.

Totals/status distributions and recent records are independent of the requested range. Trends count currently stored profiles by creation date, or currently stored associations by assignment date. They do not reconstruct deleted records, historical assignment snapshots, visits or medical events. Patient date queries are validated consistently but do not change the patient response. Separate dashboard queries may observe different moments during concurrent writes; they are operational summaries, not a transactional audit snapshot.

## `GET /api/v1/filters`

Each request selects one option field, with a standard paginated list response:

```json
{
  "data": [{ "value": "routine observation", "label": "routine observation" }],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

| Parameter       | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `field`         | `condition` (default), `status`, `specialization` or `hospital`              |
| `search`        | Optional normalized literal prefix, at most 200 characters                   |
| `page`, `limit` | Defaults 1/20; maximum limit 100; same page-number validation as other lists |

Admins can query all four fields across all permitted profiles. Doctors can query condition/status values from their currently assigned patients only. Doctor specialization/hospital requests and all patient requests return 403. Other doctors' and unassigned patients' values do not contribute to either options or totals. Unsupported query fields return 400.

Values/labels are normalized exact-filter keys, deduplicated and sorted ascending with MongoDB's simple string ordering. Absent/empty descriptor fields are omitted. Status options reflect statuses actually present in the permitted records. Option totals count unique matching values; frequencies and hidden record counts are never exposed. Search normalizes whitespace/case and escapes regex syntax. Returned pages contain at most 100 options; grouping and counting occur in MongoDB, with disk spill allowed for large dynamic vocabularies.

## Cookie-aware examples

After the bootstrap/login steps in [authentication.md](authentication.md), retain the same web session:

```powershell
Invoke-RestMethod "$base/dashboard?from=2026-10-01&to=2026-10-31" -WebSession $apiSession
Invoke-RestMethod "$base/filters?field=condition&search=routine&limit=20" -WebSession $apiSession
```

An active admin may open `/api/v1/docs` in a browser with an authenticated cookie to explore operation schemas, enter path/query/body parameters and send requests. The explorer fetches a fresh CSRF token before each mutation. It uses local assets and same-origin requests under Helmet's CSP; every asset and the runtime contract require admin authorization. Browser-origin rules still apply. For a standalone browser session before the frontend exists, set `FRONTEND_ORIGIN` to the exact backend origin and bootstrap/login using same-origin `fetch` from that origin's developer console. Once the frontend proxy exists, use `/api/v1/docs` on the allowed frontend origin.
