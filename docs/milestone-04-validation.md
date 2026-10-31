# Milestone 4 validation and remaining hosted gate

Implemented locally on 2026-10-31 in `E:\Codes\doctor-tracker-backend`, on `main`. Implementation commit: `280331b` (`Add role dashboards, scoped filters and backend release tooling`). The contract/package are `1.0.0-rc.1`. This validation record and the local checklist are committed separately. The full milestone gate remains open until hosted CI, Render/Atlas acceptance and the stable `v1.0.0` release pass.

## Environment and verification

Windows, Node.js 24.18.0, npm 11.15.0, MongoDB 8.2.6 in isolated MongoMemoryReplSet instances, Mongoose 9.11.4. Automated tests and `perf:check` do not load `.env` or use Atlas. No dependencies changed; package/lockfile version advanced together to the release candidate.

| Command                | Result                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci`               | Passed: 317 packages installed, 318 audited, zero reported vulnerabilities.                                                                |
| `npm run docs:openapi` | Generated OpenAPI 3.1, contract `1.0.0-rc.1`, 27 paths; runtime/committed artifact and package version drift checks are included.          |
| `npm run lint`         | Passed with zero warnings, including the corrected lifecycle test.                                                                         |
| `npm run format:check` | Passed, including all new source, generated artifacts and handoff documents.                                                               |
| `npm run typecheck`    | Passed with strict settings.                                                                                                               |
| `npm run build`        | Passed.                                                                                                                                    |
| `npm test`             | All 192 tests passed in ten suites (122.96 seconds). The focused six-test lifecycle run also passed (29.65 seconds).                       |
| `npm run perf:check`   | Passed: 100 doctors, 10,000 patients, 10,286 associations; 14 execution-stat query plans and eight independent list/count checks recorded. |

The first complete run passed 191/192 tests and exposed a Windows-specific assumption in the existing port-collision test: its default IPv6 reservation did not block the newly explicit IPv4 server bind. The test now reserves the same `0.0.0.0` address as the server, retaining its assertion that a real port collision exits nonzero and disconnects MongoDB. This is recorded rather than treating the failed run as successful.

## Verified implementation

- Separate admin/doctor/patient TypeScript and OpenAPI dashboard schemas; strict date and identity-query validation; default 30 days, maximum 365 inclusive calendar days, daily buckets through 90 days and monthly afterward. Buckets use Dhaka calendar boundaries, zero-fill gaps and restrict partial boundary months to the requested range.
- Admin totals count stored patients once, including shared/unassigned patients. The top ten counts assignments per doctor, includes zero-patient doctors and has deterministic ID ties. Existing paginated doctor details provide the full breakdown. Trends/status distributions handle empty input.
- Doctor totals, recent assignments and trends use only their current indexed assignments. Unlink removes those records from operational summaries. Patient dashboards contain own clinical fields and bounded safe linked-doctor summaries with a full count; no other-patient statistics, notes, email/contact details or account internals are included.
- Filter lookup supports normalized, deduplicated, consistently sorted, paginated prefix options. Admins access all permitted profile fields; doctors access only assigned patients' conditions/statuses; patients are forbidden. Hidden records do not contribute to options or totals.
- The API explorer, scripts, styles and runtime contract all require an active admin and return private/no-store data. Assets are local under Helmet CSP. The explorer supports operation selection, schema inspection, path/query/body input and session-bound CSRF bootstrap before mutations. HTTP tests verify protected assets, syntax, content types and matching runtime contract.
- Demo seeds use external role credentials, deterministic IDs, explicit database selection, additive writes and a transaction. Reruns preserve passwords, clinical edits and decided registrations. Tests verify statuses, shared/unassigned patients, zero-patient doctors, separate notes, idempotency, target denial, collisions and forced-write rollback.
- Separate configurable performance generation uses validated batches, fixed synthetic dates and no login accounts. Commands refuse implicit/mismatched targets, demo performance writes and production performance writes. No reset/delete operation exists.
- The cookie-aware deployment acceptance client runs against an independent local HTTP listener and exercises registration, approval, role/status changes, management, stale clinical revisions, notes, dashboards/filters, unlink/relink, deletion, logout and replay. Its HTTPS secure-cookie branch and actual Render behavior still require hosted execution.
- Existing authorization, session persistence/expiry, transaction rollback, concurrent links, stale notes, unlink/write races and deletion races remain part of the full regression suite. No frontend implementation was started.

## Query-plan evidence

See [query-plans.json](query-plans.json) and [the performance guide](data-and-performance.md) for query descriptors, dataset/environment, index names, cursor/lookup documents, keys, server estimates, client wall time and actual page lengths. The stored measurement is diagnostic, not a hosted latency promise.

| Representative query              | Chosen indexes                                | Cursor / lookup documents | Server time |
| --------------------------------- | --------------------------------------------- | ------------------------- | ----------- |
| Doctor prefix                     | `searchKeys_1`                                | 10 / 0                    | 1 ms        |
| Doctor specialization/hospital    | `hospitalKey_1_createdAt_-1__id_-1`           | 10 / 0                    | 0 ms        |
| Patient prefix                    | `searchKeys_1`                                | 100 / 0                   | 2 ms        |
| Combined patient condition/status | `conditionKey_1_createdAt_-1__id_-1`          | 250 / 0                   | 3 ms        |
| Prefix plus condition/status      | Same condition index                          | 250 / 0                   | 7 ms        |
| Patient page 500 with exact total | `createdAt_-1__id_-1`                         | 10,000 / 0                | 59 ms       |
| Doctor-scoped patient page/count  | Unique doctor/patient pair and patient `_id_` | 100 / 101                 | 32 ms       |
| Doctor condition options          | Unique doctor/patient pair and patient `_id_` | 100 / 101                 | 39 ms       |
| Recent assignments                | `doctorId_1_assignedAt_-1__id_-1`             | 10 / 0                    | 0 ms        |
| Patient creation trend            | Covered creation-date index                   | 0 / 0; 868 keys           | 5 ms        |
| Doctor assignment trend           | Covered doctor/assignment-date index          | 0 / 0; 9 keys             | 2 ms        |
| Patient status distribution       | Collection scan                               | 10,000 / 0                | 13 ms       |
| Top ten doctors                   | Source scans and final doctor `_id_` lookup   | 10,386 / 10               | 32 ms       |

The initial doctor-scoped list and condition-option plans traversed all 10,000 patients/index entries before assignment checks, taking 3,749 ms and 3,689 ms respectively. Starting from indexed assignments reduced the measured work to that doctor's 100 associations plus patient lookups. Combined filters, scope intersections, stable ordering, page totals and permission regression checks cover the revised query builders. Existing indexes support these paths; no speculative index additions were made.

Exact totals and page-number offsets retain linear costs. Full status/top-doctor summaries scan relevant stored data; bounded outputs do not imply constant-cost input processing. Separate live dashboard reads are not a single snapshot. Repeat plans/timings against the deployed Atlas tier before claiming production latency.

## Deployment and release blockers

There is no configured Git remote, Render CLI/API access, Atlas provisioning API access or hosted URL available in this environment. The milestone 3 handoff retains the owner's local-only Git instruction. No remote repository was created/pushed, no hosted CI was observed, no external demo database was seeded and no service/release was published. Existing development `.env` credentials were neither printed nor reused for a demo deployment.

[render.yaml](../render.yaml) and [deployment.md](deployment.md) prepare the Node runtime, build/start commands, explicit demo database, secrets, verified proxy trust, HTTPS origin, health checks, explicit index/seed setup, smoke client, restart-persistence verification, cold-start observations and later versioned contract publication. These preparations do not satisfy the hosted checklist items.

Current artifact: [openapi.json](openapi.json), release candidate only. SHA-256: `B81ED89FB858D1645E06AE5E8C7C2A995F649ED173BD49D6E90D0B428559086D`. The frontend must eventually consume the **verified `v1.0.0` release asset**, not treat this working candidate as an already released stable contract.

## Final handoff

- Implementation commit: `280331b`; staged diff and whitespace checks were reviewed before committing.
- Final verification: clean install, lint, formatting, strict type checking, 192 tests, production build, OpenAPI drift checks, isolated execution-stat measurements and count checks all pass. No hosted CI run is claimed.
- Backend URL / stable release: unavailable; hosted gate remains open.
- Next work: obtain owner direction on remote publication and Render/Atlas demo access, complete hosted checks/restart verification, then release the verified contract. Frontend work remains blocked by the milestone gate.
