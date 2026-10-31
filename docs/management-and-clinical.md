# Management and clinical API usage

All paths below are relative to `/api/v1`. Use the cookie-aware login flow in [authentication.md](authentication.md) and fetch a new CSRF token after login. Every mutation requires that session's `X-CSRF-Token`. Accounts must be active with a valid linked profile. See [OpenAPI 3.1](openapi.json) for the complete request/response schemas.

## Permissions and endpoints

| Role           | Endpoints                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------- |
| Admin          | `GET/POST /doctors`, `GET/PATCH /doctors/:id`                                               |
| Admin          | `GET/POST /patients`, `GET/PATCH/DELETE /patients/:id`                                      |
| Admin          | `GET /doctors/:doctorId/patients`, `PUT/DELETE /doctors/:doctorId/patients/:patientId`      |
| Admin          | `GET /patients/:patientId/doctor-notes` (read-only)                                         |
| Doctor/patient | `GET /me/profile`                                                                           |
| Doctor         | `GET /me/patients`, `GET /me/patients/:patientId`, `PATCH /me/patients/:patientId/clinical` |
| Doctor         | `GET/PUT/DELETE /me/patients/:patientId/note` (own note only)                               |
| Patient        | `PATCH /me/profile` (phone/address only), `GET /me/doctors`                                 |

Doctor identity and patient self-service identity come from the session. Doctors receive `404` for a patient outside their current assignment scope. Patients cannot inspect notes, edit clinical fields, change identity/email, or change assignments. Admins cannot write notes. Private notes never appear in generic patient detail/list/profile responses.

Single records use `{ data }`; lists use `{ data, meta: { page, limit, total, totalPages } }`. Creation returns `201`; deletion returns `204` with an empty body. Linking returns `200`, including repeated links. Invalid fields/queries/IDs return `400`, forbidden roles/status return `403`, missing records return `404`, and duplicate values or stale revisions return `409`. Errors include a generated request ID.

## Lists, search and filters

Doctor and patient lists accept the following strict query parameters:

| Parameter       | Behavior                                                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`, `limit` | Positive decimal integers; defaults 1 and 20; page at most 1000000 and limit at most 100. Out-of-range pages are empty. No matches gives `totalPages: 0`.                                                                                                                                                  |
| `sort`          | `-createdAt` (default), `createdAt`, `name`, `-name`. Names use normalized keys. `_id` breaks ties in the same direction.                                                                                                                                                                                  |
| `search`        | Up to 200 characters. Unicode normalization, lowercase and whitespace normalization precede an escaped literal prefix search across full fields and word tokens. No substring/fuzzy/regex search.                                                                                                          |
| `from`, `to`    | Inclusive creation dates, real `YYYY-MM-DD` values in `Asia/Dhaka`. For current dates, a day starts at 18:00 UTC on the previous date and ends immediately before 18:00 UTC on the selected date. Historical dates follow IANA timezone rules, including offset transitions. Reversed ranges are rejected. |

Doctor lists also accept `specialization` and `hospital` as normalized exact matches. Search covers name, email, phone, specialization and hospital. Each listed doctor includes `patientCount`; counts are grouped for that page in one query.

Patient lists also accept `condition` (normalized exact text), `status`, and `doctorId` (assignment). Search covers name, email, phone, condition and address. Filters combine with AND and apply before pagination and totals. Doctor/path scopes also intersect any supplied `doctorId`, preventing query impersonation. Unknown parameters and MongoDB operators are rejected.

`GET /me/doctors` and admin note review accept `page`/`limit` only. Patient detail endpoints also accept `page`/`limit` to paginate their embedded `linkedDoctors` summaries, returning `linkedDoctorsMeta` and the full `linkedDoctorCount`. Their default page size is 20. Linked-doctor summaries sort by assignment date descending, then assignment `_id` descending. Admin note review returns only nonempty notes sorted by note update time descending, then association `_id` descending.

## Creating and editing profiles

Doctors require `name`, `specialization`, `hospital`, `phone` and `email`. Emails are trimmed, lowercased and unique. Doctor patches accept only those fields and must include at least one field. Once linked to an account, the email cannot change, even if that account is disabled.

Patient creation example:

```json
{
  "name": "Example Patient",
  "dateOfBirth": "1995-02-28",
  "gender": "undisclosed",
  "phone": "+8801800000000",
  "condition": "Routine observation",
  "status": "unassessed",
  "doctorIds": []
}
```

Birth dates must be real dates from 1900 through today in Dhaka. Age is calculated when responding. Gender accepts `female`, `male`, `other`, `undisclosed`. Status accepts `unassessed` (default), `under_treatment`, `stable`, `critical`, `recovered`. Email/address/condition are optional; email is unique when present. An empty condition is stored as absent; null email and null/empty address clear those optional values. For no email, omit it or send null.

Initial `doctorIds` defaults to an empty array and accepts at most 100 IDs, deduplicated case-insensitively. Patient creation and all initial links commit in one transaction. Any missing doctor or failed write rolls everything back. Patients may exist without doctors or a login.

Admin patient patches accept demographics, contact fields and clinical fields. Assignments, timestamps, derived search keys and account fields are forbidden. Linked email is immutable. Include `revision` whenever sending condition/status; a revision with no clinical fields is rejected. Contact/demographic edits alone do not change the public clinical revision.

Patient `PATCH /me/profile` accepts only `phone` and/or `address`; the latter accepts null/empty to clear. It never changes clinical revision. Phone is required to be nonempty when supplied. Search keys refresh on every profile write.

## Clinical revisions and private notes

Read the current patient revision, then send a clinical edit:

```json
{ "condition": "Routine observation", "status": "stable", "revision": 0 }
```

An assigned doctor sends this to `PATCH /me/patients/:patientId/clinical`; an admin can send it to `PATCH /patients/:id`. At least one of condition/status is required. Every accepted clinical mutation increments the revision and records the authenticated editor and UTC time. A competing/stale edit returns `409 REVISION_CONFLICT`; reload and reconcile before trying again.

`GET /me/patients/:patientId/note` initially returns:

```json
{ "data": { "note": null, "revision": 0, "updatedAt": null } }
```

`PUT` replaces the note with `{ "note": "Synthetic note", "revision": 0 }`. Notes are trimmed and must contain 1–20000 characters. A note has its own revision, independent of the patient's clinical revision. To clear it, `DELETE` the same URL with JSON body `{ "revision": 1 }`. The response is `204`; fetch the note again for the new revision. Clearing retains/increments the note revision and timestamp so stale writes still conflict. A current-revision clear succeeds even if the note is already empty.

## Relationship removal and permanent deletion

Admin linking accepts no body or `{}`. Both profiles must exist. Repeated and simultaneous links create one association and preserve the assignment date and existing note. Repeated unlinking succeeds while both profiles still exist.

Unlinking removes only that doctor–patient association and its embedded note. The patient and all other doctors' associations/notes remain. The removed doctor immediately loses patient, clinical and note access. Relinking begins with an empty note at revision zero.

`DELETE /patients/:id` permanently removes the patient, every association and every private note in one transaction. Its linked patient account is disabled and its profile reference cleared; existing sessions lose portal access. A missing patient returns `404`.

Clinical writes include an association version write so they conflict with concurrent unlinking. Linking/unlinking includes a patient version write so it conflicts with deletion. Note writes conflict on their association. Driver transaction retries load fresh documents and repeat scope/revision checks. These internal versions are independent of public clinical/note revisions.

All examples and automated fixtures are synthetic. Dashboards, filter metadata, performance fixtures/query-plan verification, interactive documentation and deployment remain in milestone 4.
