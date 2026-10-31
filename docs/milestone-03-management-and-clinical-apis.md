# Milestone 3 — Management and clinical APIs

[Main implementation plan](../IMPLEMENTATION_PLAN.md) · [Previous milestone](milestone-02-authentication-and-access.md) · [Next milestone](milestone-04-backend-completion.md)

## Goal and prerequisites

Complete the doctor/patient management, assignment, clinical-update, and private-note APIs in `E:\Codes\doctor-tracker-backend`. Milestone 2 must already provide working sessions, approval, role guards, and scope helpers.

Doctors update shared condition/status only for assigned patients. Their private notes are visible to themselves and admins. Patients may edit only their own phone/address. Unlinking deletes that doctor's private note; patient deletion removes every association and note.

## Working and commit instructions

**Commit-message instruction:** Write commit messages in natural, human-like language. They should not look like they were written by an AI. Describe the actual change in clear, specific words; avoid generic filler, exaggerated claims, and repetitive templates.

Complete each vertical slice with validation, permissions, and relevant integration tests before moving on. Review the staged diff and checks before committing a coherent change. Check off only completed and verified tasks. Keep implementation within the agreed API and role permissions.

Example commit messages: `Let admins link existing patients to doctors` and `Remove private notes when a doctor is unlinked`.

## Subtasks

### 3.1 Add shared list-query validation and search utilities

- [x] Define page, limit, search, sort, and date-range query schemas; default to 20 records and cap at 100.
- [x] Support name/creation-date sorting with an `_id` tie-breaker and reject unsupported sort fields.
- [x] Convert `Asia/Dhaka` calendar dates into UTC boundaries; reject reversed or invalid ranges.
- [x] Normalize and escape literal prefix search input; keep derived full-field/word-token search keys current on writes.
- [x] Add reusable list metadata and projection helpers without accepting raw MongoDB operators from requests.
- [x] Test empty input, invalid pages/limits/dates, regex metacharacters, and predictable ordering.

### 3.2 Implement admin doctor creation and editing

- [x] Implement `POST /doctors` with all required fields and normalized unique email.
- [x] Implement `GET /doctors/:id` with a safe administrative profile DTO.
- [x] Implement `PATCH /doctors/:id` with an explicit field whitelist and regenerated search keys.
- [x] Prevent email changes after the profile has been linked to a login account.
- [x] Test validation, duplicate emails, unknown IDs, field injection, and non-admin access.

### 3.3 Implement the doctor list

- [x] Implement paginated `GET /doctors` with search and creation-date, specialization, and hospital filters.
- [x] Return patient counts for only the current page through a grouped query rather than one query per doctor.
- [x] Apply filters consistently to both results and total counts.
- [x] Test combined filters, empty results, later pages, and doctors with no patients.

### 3.4 Implement admin patient creation

- [x] Implement `POST /patients` with demographics, contact fields, condition/status, and optional initial `doctorIds`.
- [x] Validate date of birth, optional email uniqueness, doctor existence, and supported status values.
- [x] Deduplicate initial doctor IDs and allow an unassigned patient when the list is empty.
- [x] Create the patient and initial associations in a transaction; roll back if any assignment fails.
- [x] Test creation with zero, one, and multiple doctors plus duplicate and missing doctor references.

### 3.5 Implement admin patient detail and editing

- [x] Implement `GET /patients/:id` with linked-doctor summaries and separate handling for private notes.
- [x] Implement `PATCH /patients/:id` with an explicit editable-field whitelist.
- [x] Preserve account-linked email immutability and reject assignment changes through the profile patch endpoint.
- [x] Maintain search keys and clinical edit attribution when condition/status changes.
- [x] Check the clinical revision for shared clinical edits and return `409` for a stale revision.
- [x] Test invalid edits, uniqueness, unauthorized roles, and protected fields.

### 3.6 Implement patient and assigned-patient listing

- [x] Implement admin `GET /patients` with search, creation-date, condition, status, and doctor filters.
- [x] Implement admin `GET /doctors/:doctorId/patients` with bounded pagination and supported patient filters.
- [x] Implement doctor `GET /me/patients` and `GET /me/patients/:patientId`, deriving the doctor identity exclusively from the session.
- [x] Apply assignment scope before returning records, totals, or filter results.
- [x] Keep private notes out of generic patient list/detail DTOs.
- [x] Test a patient assigned to multiple doctors, unassigned patients, and manipulated patient/doctor IDs.

### 3.7 Implement linking and unlinking

- [x] Implement admin `PUT /doctors/:doctorId/patients/:patientId` and verify both profiles exist.
- [x] Make repeated links succeed without duplicate associations; handle simultaneous requests through the unique pair constraint.
- [x] Implement admin `DELETE /doctors/:doctorId/patients/:patientId` to delete that association and its embedded private note.
- [x] Preserve the patient and all other doctor associations; make repeated removal safe.
- [x] Guard association writes against concurrent patient deletion and clinical updates.
- [x] Test that the removed doctor immediately loses patient/note access and a later relink has no previous note.

### 3.8 Implement doctor clinical updates

- [x] Implement `PATCH /me/patients/:patientId/clinical` for condition/status only.
- [x] Require an active account, current assignment, valid fields, and the last-read patient revision.
- [x] Guard the assignment inside the write transaction so concurrent unlinking cannot authorize a stale clinical write.
- [x] Increment the clinical revision and record the editor/time atomically.
- [x] Test updates by both assigned doctors, non-assigned doctors, concurrent editors, and a doctor being unlinked.

### 3.9 Implement private notes and admin note review

- [x] Implement doctor `GET`, `PUT`, and `DELETE /me/patients/:patientId/note` using the authenticated doctor's association only.
- [x] Return an explicit empty note state when the association exists but has no note.
- [x] Validate note length and revision; preserve a revision after clearing a note to detect stale writes.
- [x] Implement admin `GET /patients/:patientId/doctor-notes`, with doctor attribution and bounded pagination.
- [x] Keep admin access read-only and prevent patients/other doctors from reading or writing these notes.
- [x] Test isolation, stale note edits, note clearing, and note deletion during unlinking.

### 3.10 Implement self-service profile endpoints

- [x] Implement `GET /me/profile` for doctor and patient roles using the session's linked profile.
- [x] Implement patient-only `PATCH /me/profile` accepting phone/address exclusively.
- [x] Implement patient `GET /me/doctors` with safe linked-doctor summaries and bounded pagination.
- [x] Exclude private notes and internal account data from every patient-facing response.
- [x] Test attempted edits to email, identity, condition, status, role, and profile/doctor references.

### 3.11 Implement permanent patient deletion

- [x] Implement admin `DELETE /patients/:id` in a transaction.
- [x] Remove the patient and all doctor associations/private notes.
- [x] Disable any linked patient account and clear its profile reference so existing sessions lose portal access.
- [x] Ensure concurrent assignment or clinical writes cannot leave dangling data or restore access.
- [x] Test rollback on failure, deletion with multiple doctors, and access from existing patient/doctor sessions afterward.

### 3.12 Complete API coverage and milestone checks

- [x] Update OpenAPI schemas, examples, pagination, permissions, and conflict/deletion semantics for completed endpoints.
- [x] Run a combined create → link → doctor edit/note → unlink → relink → delete integration scenario.
- [x] Run the complete permission matrix against management endpoints, including direct ID manipulation.
- [x] Run lint, formatting checks, type checking, all backend tests, and build locally using the CI commands.
- [ ] Confirm hosted CI passes after the owner publishes the repository; deferred under the existing local-only Git instruction (no remote configured).
- [x] Record any query-performance observations for Milestone 4 without delaying required correctness fixes.

## Exit checklist

- [x] Admin doctor/patient management and many-to-many assignment workflows are complete.
- [x] Doctor clinical updates and private notes obey scope and revision checks.
- [x] Patient self-service permits phone/address changes only.
- [x] Unlinking deletes one doctor's note; permanent deletion removes all related data and disables the linked account.
- [x] Search, filters, sorting, pagination, transactions, and authorization integration tests pass.

## Handoff record

- Completed implementation commit: `475156f` — Add patient management, assignments and private clinical notes. Handoff documentation is committed separately.
- Validation commands and results: OpenAPI generation, lint, formatting, strict type checking, all 156 tests in seven suites, and build passed on 2026-10-31. Final full test run: 89.91 seconds. See [validation record](milestone-03-validation.md) and [client usage](management-and-clinical.md).
- Remaining blockers or deviations: local implementation and verification are complete. Hosted CI awaits repository publication by the owner. Large-fixture query-plan measurements, dashboards, filter metadata, interactive documentation and deployment remain in Milestone 4.
- Next step: [Milestone 4 — Backend completion gate](milestone-04-backend-completion.md).
