# Doctor Tracker backend

Standalone Express 5 REST API, built with Node.js 24, TypeScript, Mongoose and Zod. This repository contains milestone 1: configuration, HTTP infrastructure, database models/indexes and private admin provisioning. Authentication and management routes follow in later milestones. The frontend is a separate application and has not been started.

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

| Variable           | Meaning                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`         | `development` (default), `test` or `production`                                                                                        |
| `PORT`             | Integer 1–65535; default 4000                                                                                                          |
| `MONGODB_URI`      | Required `mongodb+srv://` or `mongodb://` replica-set URI                                                                              |
| `MONGODB_DATABASE` | Required explicit database name, overriding the URI default                                                                            |
| `DNS_SERVERS`      | Optional comma-separated resolver IPs, used only by this Node process; leave unset when local DNS works                                |
| `SESSION_SECRET`   | Required random secret, at least 32 characters; reserved for milestone 2                                                               |
| `FRONTEND_ORIGIN`  | Required exact origin, e.g. `http://localhost:3000`; production requires HTTPS                                                         |
| `TRUST_PROXY`      | `false` (default) or comma-separated explicit proxy IPs/CIDRs or Express named subnets; configure for the actual trusted proxy network |
| `LOG_LEVEL`        | `fatal`, `error`, `warn`, `info` (default), `debug`, `trace` or `silent`                                                               |

Use separate databases: `doctor_tracker_development`, `doctor_tracker_test` and `doctor_tracker_demo`. Automated tests start an isolated `MongoMemoryReplSet`; they do not load `.env` or connect to Atlas. Installation downloads MongoDB 8.2.6 into the ignored workspace cache `.cache/mongodb-binaries` and needs network access; subsequent installs and tests reuse it. This cache survives `npm ci`.

If Atlas fails with `querySrv ECONNREFUSED` or `queryTxt ECONNREFUSED`, check the local DNS resolver. `DNS_SERVERS=1.1.1.1,8.8.8.8` can be supplied explicitly when those resolvers are appropriate for your network. No system DNS settings are changed. Connection failures produce a safe diagnostic rather than printing the driver error or URI. Also check Atlas network access and database-user permissions.

Session policy for milestone 2: MongoDB-backed sessions, eight-hour **absolute** lifetime, regenerated at login and destroyed at logout; host-only, `HttpOnly`, `SameSite=Lax` cookies, `Secure` in production. The cookie defaults are defined now; absolute expiry enforcement and the session store are implemented with authentication. The configured origin is reserved for browser-origin/CSRF checks in that milestone. No authentication endpoints are exposed yet.

All timestamps are UTC. Birth dates are validated real `YYYY-MM-DD` dates from 1900 through today in `Asia/Dhaka`; age is derived rather than stored. Creation-date filters will use `Asia/Dhaka` calendar boundaries.

## Health and responses

| Endpoint            | Behavior                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| `GET /health/live`  | `200` while the HTTP process is alive, independently of MongoDB              |
| `GET /health/ready` | `200` only while a bounded database ping succeeds; otherwise `503 NOT_READY` |
| `/api/v1/*`         | Reserved for feature APIs; unknown routes return `404 NOT_FOUND`             |

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
    auth/                User model, password hashing and provisioning service
    registrations/       Milestone 2 review module boundary
    doctors/ patients/   Profile models
    assignments/         Doctor–patient model with an optional private note
    dashboards/          Milestone 4 aggregation module boundary
tests/                   HTTP, configuration, model, database and lifecycle checks
```

Users have exactly one immutable role (`admin`, `doctor`, `patient`) and an account status (`pending`, `active`, `rejected`, `disabled`). Non-admin active accounts require a matching profile reference. Pending submissions hold role-specific details without creating active profiles. Partial unique indexes allow at most one login per profile. Schema references do not establish foreign-key existence; approval/linking services in subsequent milestones must validate existence and use transactions.

Doctor email is required and unique. Patient email is optional: blank strings are removed, and a partial unique index applies only to stored strings. Emails are trimmed and lowercased. Patient status is one of `unassessed`, `under_treatment`, `stable`, `critical`, `recovered`. Gender values are `female`, `male`, `other`, `undisclosed`. Names are bounded to 120 characters, phones 32, hospitals 200, addresses 500, conditions 2000, private notes 20000. Patient condition may be absent while unassessed.

Profiles maintain normalized full-field and word-token search keys. Indexes cover creation-date sorting with `_id` tie-breakers, normalized name sorting, search keys and common exact filters. Assignments have a unique doctor/patient pair and reverse patient lookup indexes; the private note lives on that association. Patient clinical revision and note revision start at zero. Timestamps and schema-level optimistic concurrency are enabled.

Write models through validated document `save()`/`create()` operations. Query updates, `insertMany` and `bulkWrite` are intentionally rejected because they bypass document invariants and derived keys. Later services must enforce linked-email immutability, reference existence, authorization, atomic relationship changes and explicit revision semantics. Use the inclusion projections and explicit DTO functions in `src/http/dtos.ts`; private notes, hashes, pending details and search internals are never part of public DTOs. Deletion/approval/clinical endpoints are outside milestone 1.

## Verification

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Vitest and Supertest cover configuration errors/redaction, health/readiness, malformed/oversized bodies, error envelopes and logging, real model/index constraints, transaction rollback, Argon2id provisioning and duplicate/racing account creation. GitHub Actions runs `npm ci` and the commands above on Node.js 24. CI requires no Atlas credentials.

Work is committed locally on `main`; remote creation and pushing are left to the repository owner. See `docs/milestone-01-validation.md` for the recorded validation and handoff.
