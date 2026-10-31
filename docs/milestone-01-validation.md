# Milestone 1 validation

Implementation date: 2026-10-31. Specification source: `E:\Codes\Doctor\IMPLEMENTATION_PLAN.md` and `docs/milestone-01-backend-foundation.md` in that specification folder.

Application location: `E:\Codes\doctor-tracker-backend`. Branch: `main`. All commits remain local at the owner's request. No remote repository has been created and nothing has been pushed. GitHub-hosted workflow execution is deferred until the owner pushes.

## Observed development checks

- Node.js 24.18.0 and npm 11.15.0 are installed.
- The supplied Atlas URI authenticated successfully, pinged successfully, and reported replica-set support using `doctor_tracker_development`.
- Node's original DNS resolver (`127.0.0.1`) refused SRV/TXT resolution. An explicit process-only `DNS_SERVERS=1.1.1.1,8.8.8.8` override resolved the supplied URI successfully. This is configured in the ignored local `.env`; the repository contains placeholders only.
- `npm run db:check` succeeded using the application connection/configuration code.
- `npm run db:indexes` created the foundation indexes on the development Atlas database.
- `npm run build` followed by `npm start` started the compiled application against Atlas.
- `GET /health/live` and `GET /health/ready` both returned 200 with the documented envelopes.
- Ctrl+C invoked shutdown, closed HTTP, disconnected MongoDB, and logged completion. The Windows npm terminal wrapper reported interruption; child-process lifecycle tests additionally check server exit codes.

## Automated checks

| Command/check                      | Final result                                                               |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `npm ci`                           | Passed with the committed lockfile; cached MongoDB binary reused           |
| `npm run lint`                     | Passed with zero warnings                                                  |
| `npm run format:check`             | Passed                                                                     |
| `npm run typecheck`                | Passed under strict TypeScript settings                                    |
| `npm test`                         | 48 tests passed in four files (33.46 seconds)                              |
| `npm run build`                    | Passed                                                                     |
| `npm audit`                        | Zero vulnerabilities                                                       |
| `npm audit --omit=dev`             | Zero vulnerabilities                                                       |
| Compiled application against Atlas | Liveness/readiness 200, unknown route 404, clean shutdown with exit code 0 |

The isolated suites verify required/invalid configuration and secret-safe failures; Helmet, request IDs, bounded/malformed bodies, safe validation/duplicate/internal errors and logging; email normalization/uniqueness and absent optional patient emails; profile-reference and doctor/patient-pair uniqueness; immutable roles and matching account/profile states; field/date/revision bounds, pending submissions, derived search keys, DTO projections and private-note exclusion; transaction rollback; Argon2id provisioning through both service and CLI, duplicate/non-admin/racing requests; actual database-disconnect readiness; startup connection/port failures and both termination signals. On Windows, test-only IPC emits termination events because native `child.kill()` force-terminates the child. Unix CI delivers actual OS signals. All replica sets are torn down after tests.

The occupied-port test caught an Express listen-callback error-handling issue during implementation. The final server uses Node's HTTP server with a startup error listener, only reports readiness after a successful bind, and disconnects MongoDB after a bind failure. The final suite passes that regression check.

The development lint toolchain's transitive `minimatch` dependency is overridden to 11.0.3 to address [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Its compatibility is checked through ESLint. Both the full dependency audit and the production-only audit report zero vulnerabilities after resolving the lockfile.

## Scope and handoff

Authentication endpoints, MongoDB-backed sessions, approval services, management/clinical endpoints and frontend work belong to subsequent milestones. Cookie settings and configuration are reserved now; authentication security is not claimed as implemented. No development admin has been created with a shared or default password; provisioning is exercised with synthetic credentials in isolated databases.

The module schemas reject write paths that bypass validation/derived keys. Later feature services must validate referenced records, enforce linked-email immutability and authorization, and implement transactions and explicit client revision checks. DTO inclusion projections keep internal fields out of API responses.

Next: milestone 2, authentication and three-role access.
