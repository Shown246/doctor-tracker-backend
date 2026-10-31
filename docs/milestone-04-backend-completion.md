# Milestone 4 — Backend completion gate

[Main implementation plan](../IMPLEMENTATION_PLAN.md) · [Previous milestone](milestone-03-management-and-clinical-apis.md) · [Next milestone](milestone-05-frontend-portals.md)

**Local implementation and performance verification are complete; the hosted gate is still open.** The repository remains local-only under the existing handoff instruction. Render/Atlas access, hosted CI, HTTPS/restart verification and the stable release remain pending. See [validation and blockers](milestone-04-validation.md).

## Goal and prerequisites

Finish analytics, scoped filter metadata, documentation, performance verification, and the hosted backend release. Milestone 3 must be complete. Continue in `E:\Codes\doctor-tracker-backend` and deploy the independent Express service to Render with MongoDB Atlas.

**Do not start frontend implementation until every exit criterion in this file passes.** If hosting account access is missing, record that blocker and finish the independent backend work first.

## Working and commit instructions

**Commit-message instruction:** Write commit messages in natural, human-like language. They should not look like they were written by an AI. Describe the actual change in clear, specific words; avoid generic filler, exaggerated claims, and repetitive templates.

Complete each group with its relevant checks, then review the staged diff before making a focused commit. Record measured query behavior rather than claiming performance without evidence. Keep all demo data synthetic and credentials outside Git.

Example commit messages: `Add separate dashboard summaries for each role` and `Document the backend setup and API`.

## Subtasks

### 4.1 Define dashboard response and date contracts

- [x] Define separate typed dashboard response schemas for admin, doctor, and patient roles.
- [x] Validate the requested date range with a default of 30 days and maximum of one year.
- [x] Use daily buckets through 90 days, monthly buckets afterward, and `Asia/Dhaka` calendar boundaries.
- [x] Define zero-filled buckets and clarify that historical charts cover stored records/current assignments rather than visit history.
- [x] Add corresponding OpenAPI schemas before wiring the aggregations.

### 4.2 Implement admin analytics

- [x] Aggregate total doctors and distinct patients without counting one patient multiple times across assignments.
- [x] Aggregate patients per doctor and return a bounded top-ten chart dataset.
- [x] Reuse the paginated doctor list with patient counts for the detailed breakdown.
- [x] Aggregate doctor/patient creation trends and patient-status distribution.
- [x] Handle an empty database, doctors without patients, and missing time buckets.

### 4.3 Implement doctor and patient dashboard responses

- [x] Scope the doctor dashboard to current assignments derived from the session's doctor profile.
- [x] Return assigned-patient counts/status distribution, bounded recent assignments, and assignment trends.
- [x] Return the patient's own condition/status, linked-doctor count/summaries, and last clinical update.
- [x] Keep private notes and other patients' statistics out of patient responses.
- [x] Route `GET /dashboard` to the correct service using the authenticated active account's role.

### 4.4 Implement scoped filter metadata

- [x] Implement `GET /filters` with specialization/hospital and patient condition/status options needed by the caller.
- [x] Use all permitted records for admins and assigned-patient values only for doctors.
- [x] Normalize, deduplicate, and consistently order returned filter options.
- [x] Bound dynamic option lists and support option lookup/pagination when needed instead of returning unlimited unique values.
- [x] Deny unsupported roles and test that hidden records do not leak through filter values or counts.

### 4.5 Add repeatable synthetic data commands

- [x] Add an idempotent demo seed with active admin/doctor/patient accounts, pending registrations, and representative statuses.
- [x] Include patients shared by doctors, unassigned patients, doctors without patients, and isolated private notes.
- [x] Supply seeded account credentials through environment variables; do not print or commit them.
- [x] Add a separate performance-fixture command with configurable size, using at least 100 doctors and 10,000 patients for the recorded query checks.
- [x] Restrict fixture writes/resets to an explicitly selected development/test database; never reset the hosted demo implicitly.

### 4.6 Check and improve database query plans

- [x] Inspect representative search, filter, pagination, assignment, and dashboard queries using `explain("executionStats")`.
- [x] Record the query, dataset size, selected index, documents examined, and observed execution time without credentials or patient payloads.
- [x] Verify prefix searches use normalized keys without unescaped user regex or case-insensitive scan assumptions.
- [x] Remove per-row count/lookups and unbounded data loading; tune indexes only where the observed queries justify them.
- [x] Check result/count consistency across combined filters and large offsets; record remaining page-number pagination limits.

### 4.7 Finalize the API contract and backend documentation

- [x] Complete OpenAPI 3.1 coverage for all endpoints, DTOs, role restrictions, validation, revisions, pagination, and errors.
- [x] Document CSRF/session bootstrap, approval workflows, private-note visibility, unlinking, and permanent deletion.
- [x] Serve interactive docs behind admin authorization; keep documented health/auth exceptions explicit.
- [x] Add cookie-aware examples that work without a frontend.
- [x] Complete README setup, index creation, admin provisioning, seed/test commands, environment variables, and architecture/permission notes.
- [ ] Ensure a stable machine-readable OpenAPI artifact can be consumed from the tagged backend release by the later frontend project. The candidate artifact and publication instructions are ready; the stable release asset awaits hosted verification.

### 4.8 Run the full backend acceptance suite

- [x] Verify authentication, every role/status combination, impersonation attempts, and safe projections.
- [x] Verify shared-patient counts, empty dashboards, bucket boundaries, date limits, and role-scoped filter metadata.
- [x] Verify duplicate links, note isolation/deletion, stale revisions, unlink/update races, and patient-deletion rollback.
- [x] Run a clean-install check with lint, formatting checks, type checking, tests, and production build.
- [ ] Resolve failures and confirm the backend GitHub Actions workflow is green.

### 4.9 Prepare the hosted backend environment

- [ ] Configure an Atlas demo database and dedicated database credentials separate from development/test.
- [ ] Create a Render web service linked to the backend repository with the correct build/start commands and runtime.
- [ ] Configure the MongoDB URI, session secret, exact allowed browser origins, production cookie options, port handling, and proxy trust.
- [x] Document how the eventual Vercel origin is added without allowing arbitrary origins or leaking secrets.
- [ ] Configure health checks, safe application logs, and startup/index setup steps.
- [ ] Provision the demo admin and seed synthetic records through an explicitly invoked setup process.

### 4.10 Verify deployment and publish the backend release

- [ ] Smoke-test hosted readiness, CSRF, registration, login, approval, role-specific access, management, notes, and dashboard responses with a cookie-aware API client.
- [ ] Verify secure cookies, account-status changes, logout, and denial of unauthorized requests over HTTPS.
- [ ] Confirm data and sessions persist across a service restart.
- [ ] Record the backend URL, tested commit, setup notes, and free-tier cold-start behavior.
- [ ] Tag/release the verified backend as `v1.0.0` and publish its OpenAPI artifact.
- [ ] Record the release and gate results below before moving to the frontend.

## Exit checklist — backend gate

- [x] The complete backend is independently usable with an API client.
- [x] Every permission rule and destructive/concurrent workflow has passing coverage.
- [x] Dashboard aggregation, filter scoping, and representative query plans are verified.
- [x] Documentation and machine-readable contract match the implementation.
- [ ] The Render API and Atlas demo database are live and smoke-tested.
- [ ] The verified backend contract is released as `v1.0.0`.
- [ ] All backend gate results are recorded; frontend implementation may now begin.

## Handoff record

- Completed commit(s) and release: `280331b` — Add role dashboards, scoped filters and backend release tooling. Local release candidate `1.0.0-rc.1`; no stable tag/release published. This checklist and validation record are committed separately.
- Validation commands and results: clean install, OpenAPI generation, lint, formatting, type checking, build, all 192 tests in ten suites (122.96 seconds), the independent HTTP acceptance client and 100-doctor/10,000-patient performance verification passed. Fourteen query plans and eight count checks are recorded. See [validation and blockers](milestone-04-validation.md).
- Backend URL and API contract location: not deployed; machine-readable release candidate is `docs/openapi.json`, also served behind admin authorization at `/api/v1/docs/openapi.json`.
- Remaining blockers or deviations: no remote configured; owner local-only Git instruction remains in force. No Render/Atlas demo provisioning access or hosted URL is available. `render.yaml`, setup/release instructions and the HTTPS acceptance command are prepared, but hosted checks and `v1.0.0` publication remain unchecked.
- Next step: resolve remote publication and hosting access, finish 4.9–4.10 and publish the stable contract. [Milestone 5 — Frontend portals](milestone-05-frontend-portals.md) remains blocked until the full backend gate passes.
