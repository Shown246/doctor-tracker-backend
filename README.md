# Doctor Tracker backend

Standalone Express 5 REST API, built with Node.js 24, TypeScript, Mongoose and Zod. Milestones 1–3 include the foundation, registration and approval, persistent sessions, doctor/patient management, assignments, clinical updates and private notes. The frontend is a separate application and has not been started.

## Setup

Install Node.js **24 LTS** and npm 11. From a clean checkout:

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env with your development Atlas URI and a random session secret.
npm run db:check
npm run db:indexes
npm run dev
```

The local server defaults to `http://localhost:4000`. Production-style execution:

```powershell
npm run build
npm start
```

The server validates configuration and connects to a replica set before listening. Development uses Atlas. Standalone MongoDB is rejected because later workflows require transactions. Index creation is explicit in every environment; startup never creates indexes automatically. Run `db:indexes` before using a newly configured database. It creates missing indexes without dropping existing indexes or data, and fails on incompatible existing indexes or uniqueness violations.

## Configuration

Node loads the optional, ignored `.env` file; values already in the process environment take precedence. Never commit credentials or put real patient data in fixtures.

| Variable           | Meaning                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`         | `development` (default), `test` or `production`                                                                                               |
| `PORT`             | Integer 1–65535; default 4000                                                                                                                 |
| `MONGODB_URI`      | Required `mongodb+srv://` or `mongodb://` replica-set URI                                                                                     |
| `MONGODB_DATABASE` | Required explicit database name, overriding the URI default                                                                                   |
| `DNS_SERVERS`      | Optional comma-separated resolver IPs, used only by this Node process; leave unset when local DNS works                                       |
| `SESSION_SECRET`   | Required random secret, at least 32 characters; signs session cookies and hashes rate-limit identities; keep stable across restarts/instances |
| `FRONTEND_ORIGIN`  | Required exact origin, e.g. `http://localhost:3000`; production requires HTTPS                                                                |
| `TRUST_PROXY`      | `false` (default) or comma-separated explicit proxy IPs/CIDRs or Express named subnets; configure for the actual trusted proxy network        |
| `LOG_LEVEL`        | `fatal`, `error`, `warn`, `info` (default), `debug`, `trace` or `silent`                                                                      |

Use separate databases: `doctor_tracker_development`, `doctor_tracker_test` and `doctor_tracker_demo`. Automated tests start an isolated `MongoMemoryReplSet`; they do not load `.env` or connect to Atlas. Installation downloads MongoDB 8.2.6 into the ignored workspace cache `.cache/mongodb-binaries` and needs network access; subsequent installs and tests reuse it. This cache survives `npm ci`.

If Atlas fails with `querySrv ECONNREFUSED` or `queryTxt ECONNREFUSED`, check the local DNS resolver. `DNS_SERVERS=1.1.1.1,8.8.8.8` can be supplied explicitly when those resolvers are appropriate for your network. No system DNS settings are changed. Connection failures produce a safe diagnostic rather than printing the driver error or URI. Also check Atlas network access and database-user permissions.

Sessions use `express-session` and `connect-mongo`, sharing the existing MongoDB connection. The eight-hour **absolute** deadline is enforced on the server and preserved in both cookie and store expiry during activity. Login regenerates the session; logout destroys it and clears its host-only `doctor_tracker.sid` cookie. Cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Run `db:indexes` after upgrading to install the session and throttle TTL indexes. MongoDB removes expired records asynchronously; expiry checks do not depend on cleanup timing.

Every mutation requires a session-bound `X-CSRF-Token`, including registration/login/logout. Fetch `GET /api/v1/auth/csrf` first and retain the cookie; fetch a new token after login. Browser `Origin` or `Referer`, when present, must match `FRONTEND_ORIGIN` exactly. Cross-site Fetch Metadata without an allowed origin is rejected. Non-browser clients may omit origin headers but must still use CSRF tokens and cookies. Browser clients use the frontend same-origin proxy; credentialed cross-origin CORS is not enabled.

See [authentication and approval usage](docs/authentication.md) for payloads and cookie-aware examples, and the generated [OpenAPI 3.1 contract](docs/openapi.json). Regenerate it with `npm run docs:openapi` after changing Zod contracts; tests detect drift. Interactive admin-only documentation follows in milestone 4.

See [management and clinical API usage](docs/management-and-clinical.md) for list queries, role permissions, revision checks, private notes, patient self-service and deletion semantics.

All timestamps are UTC. Birth dates are validated real `YYYY-MM-DD` dates from 1900 through today in `Asia/Dhaka`; age is derived rather than stored. Creation-date filters use inclusive `Asia/Dhaka` calendar boundaries.

## Health and responses

| Endpoint                  | Behavior                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- |
| `GET /health/live`        | `200` while the HTTP process is alive, independently of MongoDB              |
| `GET /health/ready`       | `200` only while a bounded database ping succeeds; otherwise `503 NOT_READY` |
| `/api/v1/auth/*`          | CSRF, registration, login, current account and logout                        |
| `/api/v1/registrations/*` | Active-admin registration review and decisions                               |
| `/api/v1/doctors/*`       | Active-admin doctor management and assignments                               |
| `/api/v1/patients/*`      | Active-admin patient management and private-note review                      |
| `/api/v1/me/*`            | Session-scoped doctor care and patient profiles/contact details              |
| Other `/api/v1/*` routes  | Unknown routes return `404 NOT_FOUND`                                        |

Single records use `{ data }`. Lists use `{ data, meta: { page, limit, total, totalPages } }`. Errors use `{ error: { code, message, fieldErrors?, requestId } }`. Every response has a generated `X-Request-Id`; incoming IDs are not trusted. Helmet is enabled and JSON bodies are limited to 32 KiB. Malformed JSON returns 400, oversized JSON 413, validation errors 400, duplicate keys 409 and unexpected errors 500. Responses never include stack traces or raw database errors.

Structured logs contain generated request IDs, methods, status codes and duration. Bodies, headers, URLs, query strings, account identities, passwords, hashes and raw driver errors are not logged. Database lifecycle events are logged without connection credentials. `SIGINT`/`SIGTERM` stop new requests, drain HTTP connections and disconnect MongoDB, with a ten-second shutdown deadline.

## Private admin provisioning

No public admin registration exists. Supply `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` through temporary environment variables. Passwords must be 12–128 characters and are hashed with Argon2id (64 MiB memory, three iterations, one lane).

PowerShell example with a hidden password prompt:

```powershell
$env:ADMIN_NAME = Read-Host 'Admin name'
$env:ADMIN_EMAIL = Read-Host 'Admin email'
$adminCredential = Get-Credential -UserName $env:ADMIN_EMAIL -Message 'New admin password (12–128 characters)'
try {
    $env:ADMIN_PASSWORD = $adminCredential.GetNetworkCredential().Password
    npm run admin:create
} finally {
    Remove-Item Env:ADMIN_PASSWORD, Env:ADMIN_EMAIL, Env:ADMIN_NAME -ErrorAction SilentlyContinue
    $adminCredential = $null
}
```

The command creates an active admin, emits only its ID/role/status, and exits nonzero on failure. It creates user indexes before insertion and refuses to overwrite any existing account or promote a doctor/patient. Existing accounts and passwords remain unchanged on duplicates. Do not pass credentials as command-line arguments. Automated tests provision synthetic accounts only; no working admin credentials are shipped.

## Structure and data integrity

```text
src/
  app.ts                 Express factory without network/database side effects
  server.ts              Database connection, HTTP listener and process lifecycle
  commands/              Database check, explicit indexes, private admin creation
  config/                Validated environment and session/date defaults
  database/              Connection, model helpers and index setup
  errors/ http/ logging/ middleware/
  modules/
    auth/                Registration, credentials, sessions, CSRF, throttles and access guards
    registrations/       Admin review and transactional approval/rejection
    doctors/ patients/   Profiles, management, scoped reads and clinical writes
    assignments/         Transactional relationships and revision-checked private notes
    profiles/            Doctor/patient self-service routes and controllers
    dashboards/          Milestone 4 aggregation module boundary
tests/                   HTTP, configuration, model, database and lifecycle checks
```

Users have exactly one immutable role (`admin`, `doctor`, `patient`) and an account status (`pending`, `active`, `rejected`, `disabled`). Non-admin active accounts require a matching profile reference. Pending submissions hold role-specific details without creating active profiles. Partial unique indexes allow at most one login per profile. Approval checks profile existence, matching normalized email and unclaimed ownership, then creates/links the profile and activates the account in a transaction. Rejection preserves submitted details and an optional reason. Decisions are final in v1. Admin-only review uses a dedicated projection and never returns credentials.

Doctor email is required and unique. Patient email is optional: blank strings are removed, and a partial unique index applies only to stored strings. Emails are trimmed and lowercased. Patient status is one of `unassessed`, `under_treatment`, `stable`, `critical`, `recovered`. Gender values are `female`, `male`, `other`, `undisclosed`. Names are bounded to 120 characters, phones 32, hospitals 200, addresses 500, conditions 2000, private notes 20000. Patient condition may be absent while unassessed.

Profiles maintain normalized full-field and word-token search keys. Indexes cover creation-date sorting with `_id` tie-breakers, normalized name sorting, search keys and common exact filters. Assignments have a unique doctor/patient pair and reverse patient lookup indexes; the private note lives on that association. Patient clinical revision and note revision start at zero. Timestamps and schema-level optimistic concurrency are enabled.

Write models through validated document `save()`/`create()` operations. Query updates, `insertMany` and `bulkWrite` are intentionally rejected because they bypass document invariants and derived keys. Management services enforce linked-email immutability, atomic relationship changes and explicit revision semantics. Inclusion projections and explicit DTO functions in `src/http/dtos.ts` keep notes, hashes, pending details and search internals out of generic profile responses. Middleware and services enforce role/status, own-profile identity and assignment scope. Clinical writes increment the association's internal version in the same transaction as the patient edit to serialize with unlinking. Relationship writes increment the patient's internal version to serialize with deletion. Public clinical/note revisions remain separate from these internal concurrency guards.

## Verification

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Vitest and Supertest cover foundation behavior, registration injection, all account states, CSRF/origin rejection, cookie policy, absolute/store expiry, process-restart persistence, logout/replay, shared throttling, the management permission matrix, safe projections, combined list filters, Dhaka date boundaries, competing approvals, stale clinical/note edits, simultaneous links and transaction rollback. Deterministic race tests pause writes while unlinking/deletion commits, then verify the resumed write loses access. GitHub Actions runs `npm ci` and the commands above on Node.js 24. CI requires no Atlas credentials.

Work is committed locally on `main`; remote creation and pushing are left to the repository owner. See [milestone 1 validation](docs/milestone-01-validation.md), [milestone 2 validation](docs/milestone-02-validation.md) and [milestone 3 validation](docs/milestone-03-validation.md) for the recorded checks and handoff.
