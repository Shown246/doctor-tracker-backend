# Synthetic data and query verification

Fixture commands never load real patient data, reset collections, delete existing records or run at server startup. Demo and performance records use separate deterministic synthetic IDs and reserved `example.test` fixture addresses. Credentials are supplied externally and never logged. Existing profiles, account decisions, notes and passwords are preserved on a repeat run with the same inputs.

## Demo seed

Set `MONGODB_DATABASE` explicitly to a name ending `_development`, `_test` or `_demo`, and set `FIXTURE_DATABASE` to that exact same name. `SEED_DEMO=true` is also required. Keep the actual URI and credentials in the ignored `.env` or temporary process environment:

```powershell
$env:FIXTURE_DATABASE = 'doctor_tracker_demo'
$env:SEED_DEMO = 'true'
# Supply DEMO_ADMIN_EMAIL/PASSWORD, DEMO_DOCTOR_EMAIL/PASSWORD,
# and DEMO_PATIENT_EMAIL/PASSWORD through your secret manager or secure prompts.
npm run seed:demo
```

All three email/password pairs are required and emails must differ. Passwords are 12–128 characters and stored as Argon2id hashes. Use synthetic accounts. The seed creates three doctors, six patients covering all five statuses, three active role accounts and two pending submissions. One patient is shared, another is unassigned, one doctor has no patients, and associations hold separate private notes. Pending submissions use the corresponding role's supplied demo password. Approval can be exercised independently.

The demo seed creates indexes explicitly and executes its related writes in one transaction. Email collisions or failed writes roll it back. It refuses to claim a pre-existing profile/account under another ID, change the configured email of an existing seed fixture or promote an existing account. Repeating does not rotate credentials or reset clinical edits. Missing synthetic fixtures may be recreated by an explicit rerun; it is a setup command, not a migration or password reset. No credentials belong in Git or command-line arguments.

## Performance fixtures

Use a dedicated development/test database, separate from the demo:

```powershell
# Configure its URI normally; these names deliberately override any .env default.
$env:NODE_ENV = 'development'
$env:MONGODB_DATABASE = 'doctor_tracker_performance_test'
$env:FIXTURE_DATABASE = $env:MONGODB_DATABASE
$env:PERF_DOCTORS = '100'
$env:PERF_PATIENTS = '10000'
npm run seed:performance
npm run db:explain
```

Performance writes require a database ending `_development`/`_test`, exact `FIXTURE_DATABASE` matching and a non-production environment. `_demo` and production targets are refused. There is no reset command. Generation is additive and idempotent for the same size, uses validated document saves, and can resume after failure. Use a fresh isolated database when changing assignment-size configuration. Supported ranges are 1–10,000 doctors and 1–1,000,000 patients; these are generation limits, not benchmarked scale claims.

Performance fixtures use the fixed anchor `2026-10-31T12:00:00Z`, spread creation/assignment dates over 365 days, include shared/unassigned patients and maintain normalized search fields. They create no login accounts. Batches contain at most 50 parallel document writes. Demo setup and performance generation never invoke each other.

For fully isolated verification without `.env`, Atlas or any external database:

```powershell
npm run perf:check
```

This starts an isolated MongoMemoryReplSet, creates indexes and the default 100 doctors/10,000 patients, records `explain("executionStats")` for representative runtime query builders, checks list/count consistency, writes [query-plans.json](query-plans.json), and stops the replica set. `PERF_DOCTORS`/`PERF_PATIENTS` can override size. This command does not load `.env`; the MongoDB binary cache may require a first-time download. `db:explain` reads the explicitly selected performance database and writes the same report; fixture writes require the separate seed command.

## Measured behavior

The report records dataset sizes, exact synthetic query descriptors, chosen indexes, cursor/lookup documents examined, keys examined, returned aggregation rows, server time and client wall time. It excludes raw driver commands, URIs, credentials and patient payloads. For pipelines, server time is the largest reported cumulative stage estimate; for simple queries it is `executionTimeMillis`. Client wall time includes command/driver overhead. Cursor and lookup counts are separate; nested union cursor counts are included. A facet returns one envelope even when its page contains many records; the independent count checks record actual page lengths.

Initial measurement on MongoDB 8.2.6, Node.js 24.18.0, Windows, 100 doctors/10,000 patients/10,286 associations found:

| Query                            | Initial selected indexes                                | Initial documents examined                          | Initial server time |
| -------------------------------- | ------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| Doctor-scoped patient list/count | Patient creation-date index; unique doctor/patient pair | 10,000 patient documents + 100 lookup documents     | 3,749 ms            |
| Doctor condition options         | Patient condition index; unique doctor/patient pair     | 10,000 patient index entries + 100 lookup documents | 3,689 ms            |

Both originally started from all patients and checked assignment existence once per candidate. They now start from indexed doctor assignments, then join those patients and apply all clinical/search/date filters. An additional doctor filter intersects the session/path scope. No assignment-ID array is loaded into application memory. The resulting measured plans and count checks are in the report; authorization and combined-filter regression tests cover the change. Existing indexes support the revised access paths, so no speculative indexes or migrations were added.

Literal prefix searches use `searchKeys_1`, with no case-insensitive regex flag or unescaped pattern. Exact filters use normalized keys and existing compound indexes. Creation trends can use covered date-index reads. Assignment lookup uses the unique pair index; recent assignments use the doctor/assignment-date index. Status distributions and top-ten aggregation may scan all relevant records/associations because they summarize the full dataset; their output remains bounded. Doctor-list patient counts remain one grouped query for the current page, avoiding application-level per-row requests.

Page-number pagination retains linear offset cost. Unscoped patient list facets inspect all matches to compute the exact total, including page 500 and the empty page 501. Scoped facets inspect all of that doctor's assignments for the total. Dynamic option grouping and totals also scale with the permitted input set. Single-machine explain measurements are diagnostic evidence, not hosted latency guarantees; repeat on the deployed Atlas tier before making service-level claims.
