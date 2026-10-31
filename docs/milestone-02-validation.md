# Milestone 2 validation and handoff

Local implementation and verification completed on 2026-10-31 in `E:\Codes\doctor-tracker-backend`, on local `main`. Implementation commit: `ff949ba` (`Add session authentication and transactional registration review`). This record and the updated checklist are committed separately.

Environment: Windows, Node.js 24.18.0, npm 11.15.0. Automated database checks use isolated MongoMemoryReplSet instances with MongoDB 8.2.6; they never load `.env` or use Atlas accounts. Examples and fixtures contain synthetic data only.

## Results

| Command                     | Result                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                    | Passed; lockfile installed 317 packages; audit reported zero vulnerabilities                                                                                   |
| `npm run docs:openapi`      | Generated OpenAPI 3.1 from runtime Zod contracts; drift test passed                                                                                            |
| `npm run lint`              | Passed with zero warnings                                                                                                                                      |
| `npm run format:check`      | Passed                                                                                                                                                         |
| `npm run typecheck`         | Passed under strict TypeScript settings                                                                                                                        |
| `npm test`                  | All 116 tests passed in six files; final full run took 70.90 seconds                                                                                           |
| `npm run build`             | Passed                                                                                                                                                         |
| `npm run db:indexes`        | Passed against the configured development Atlas database; installed registration, session-expiry and throttle-expiry indexes without dropping existing indexes |
| `git diff --cached --check` | Passed before the implementation commit                                                                                                                        |

The existing GitHub Actions workflow uses the same install/lint/format/typecheck/test/build commands on Node.js 24. Hosted CI has **not** run: this repository has no remote, and the existing local-only Git instruction leaves remote creation and pushing to the owner. The checklist leaves hosted CI explicitly unchecked. Deployment is outside this milestone.

Imported specification and future milestone source documents retain their original formatting through explicit Prettier exclusions. The implemented milestone checklist, new documentation, generated contract and application files are formatted and checked. Unrelated imported source documents were left uncommitted.

## Verified behavior

- Strict, discriminated doctor/patient registration rejects public admins, account-state/profile-reference injection, nested unsupported fields, private notes, invalid dates and invalid credentials. Emails normalize; duplicate normalized emails conflict. Argon2id hashes and submitted details stay on pending users, with no active profiles or automatic login.
- MongoDB sessions store only user identity, CSRF token, expiry and cookie metadata. Login regenerates the session and CSRF token; the old cookie no longer authenticates. Cookies are host-only, HttpOnly, SameSite=Lax and Secure in production. Logout destroys the stored session and clears the matching cookie. Session replay after logout fails.
- Both cookie and store expiry remain pinned to the eight-hour absolute deadline during activity. Missing expiry metadata fails closed. Tests cover explicit server-deadline expiry, store expiry independently of TTL deletion, forged cookies, and reuse across a full child-process shutdown/restart.
- State-changing endpoints reject missing, malformed, wrong and cross-session CSRF tokens. Login requires clients to fetch a replacement token. Browser origin checks reject disallowed/null/lookalike origins, invalid Referer and cross-site Fetch Metadata. Exact configured origins and cookie-aware non-browser requests work.
- Anonymous, pending, rejected, disabled, admin, doctor and patient states are exercised with real users. Pending/rejected sessions can read account status and log out; disabled login uses generic credential errors, and existing disabled sessions lose protected access immediately. Current-user responses reflect approval/rejection without a new login and omit submitted details and credentials.
- Protected test handlers verify admin/doctor/patient role guards, own-profile projection, existing and matching linked profiles, manipulated patient IDs, assigned-doctor access and private-note isolation. Patients cannot use doctor clinical/note guards. Removing an assignment immediately removes scope. Missing authentication returns 401, forbidden roles/status 403, and out-of-scope patient IDs 404.
- Admin review is paginated and filtered by role/status, sorted by creation time with a stable ID tie-breaker. List/detail projections exclude passwords, sessions and model internals. Anonymous, pending/rejected/disabled, doctor and patient clients cannot inspect or decide registrations.
- Approval creates a role-appropriate profile or links an explicitly selected, matching-email, unclaimed profile. Existing data is preserved when linking. New patient creation requires condition/status confirmation. Mismatched, claimed or conflicting profiles and repeated decisions return 409. Rejection preserves submissions and optional reasons. Simultaneous create/create, approve/reject and link/link decisions have one winner. A forced final account-save failure rolls back the profile creation.
- MongoDB-backed atomic counters enforce IP and normalized-account/IP limits across app recreation, including concurrent attempts. The next fixed window permits new attempts. Responses use shared 429 errors with Retry-After. Raw email/IP/password values are absent from stored counter keys. Real process authentication logs exclude email, password, session cookie, CSRF token and password hashes.
- The committed OpenAPI artifact is generated from runtime request/response schemas, and a test rejects contract drift. [Client documentation](authentication.md) includes cookie-aware PowerShell registration/login/status/logout examples and admin decision payloads.

## Transaction implementation detail

The competing approve/reject test exposed a Mongoose `connection.transaction()` retry failure: document restoration attempted to set `__v` on a strict nested registration subdocument without that path. The approval service uses an explicit session with the driver's `withTransaction()`, fresh document loads on each retry, snapshot reads and majority writes. No documents survive between retries. Concurrent-decision and rollback tests pass with this implementation.

## Handoff

Milestone 3 can reuse `sessionSecurity`, `requireAuthentication`, `requireActiveAccount`, `allowRoles`, `ownProfile` and `requirePatientScope`. Note queries must also constrain the authenticated doctor ID and deny patient access. Clinical writes must serialize authorization and mutation against association removal; an assignment read alone does not lock it. Management services must enforce linked-email immutability and client revision conflicts.

No frontend work or unfinished production management endpoints were added. Interactive admin API documentation remains in milestone 4. The remaining external verification is the hosted CI run after the owner publishes the repository.
