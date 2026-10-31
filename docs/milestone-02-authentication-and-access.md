# Milestone 2 — Authentication and three-role access

[Main implementation plan](../IMPLEMENTATION_PLAN.md) · [Previous milestone](milestone-01-backend-foundation.md) · [Next milestone](milestone-03-management-and-clinical-apis.md)

## Goal and prerequisites

Implement secure public registration, session authentication, admin approval, and authorization for all three roles. Complete Milestone 1 first, including the models, indexes, test database, and private admin command. Continue in `E:\Codes\doctor-tracker-backend`.

Pending/rejected users may see account status and log out. Only active, approved accounts may access portal data. Public registration never creates admins or activates accounts.

## Working and commit instructions

**Commit-message instruction:** Write commit messages in natural, human-like language. They should not look like they were written by an AI. Describe the actual change in clear, specific words; avoid generic filler, exaggerated claims, and repetitive templates.

Work in the order below, reuse the foundation utilities, and keep each commit focused on one coherent change. Review the staged diff and relevant checks before committing. Mark completed and verified work only. Use synthetic accounts in tests and example requests.

Example commit messages: `Keep new accounts pending until approval` and `Check patient access before returning records`.

## Subtasks

### 2.1 Define authentication and account-state contracts

- [x] Add Zod request/response schemas for registration, login, logout, current user, and registration decisions.
- [x] Define a discriminated registration payload for doctor and patient profile information.
- [x] Reject public `admin` roles, status/profile-reference injection, and unsupported fields.
- [x] Define the safe current-user DTO with role, status, profile reference, and rejection reason where appropriate.
- [x] Start documenting authentication endpoints in OpenAPI; keep schemas aligned as implementation proceeds.

### 2.2 Persist and manage sessions

- [x] Configure `express-session` with `connect-mongo`; do not use the in-memory store.
- [x] Store only the user identity and required session metadata, then load current account state on authenticated requests.
- [x] Apply an eight-hour absolute lifetime, host-only `HttpOnly` cookies, `SameSite=Lax`, and production `Secure` cookies.
- [x] Ensure session renewal cannot extend the absolute login deadline.
- [x] Apply `private, no-store` headers to authenticated responses.
- [x] Verify session-store expiry, cookie behavior, and reuse after a server restart.

### 2.3 Add CSRF and browser-origin protection

- [x] Implement `GET /auth/csrf` to establish a session-bound token.
- [x] Require a valid CSRF token on state-changing endpoints, including registration, login, and logout.
- [x] Validate browser origins against configured values; avoid wildcard credentialed access.
- [x] Keep token handling compatible with session regeneration at login and document when clients must obtain a new token.
- [x] Test missing, invalid, and cross-session tokens plus disallowed origins.

### 2.4 Implement public registration

- [x] Implement `POST /auth/register` for doctor and patient roles with role-specific validation.
- [x] Normalize the account email and hash the password using the existing Argon2id helper.
- [x] Store submitted profile details on the pending request rather than creating an active profile.
- [x] Return a safe response with pending status and handle duplicate emails consistently.
- [x] Verify registration cannot bind itself to an existing profile or provide private doctor notes.

### 2.5 Implement login, current-user lookup, and logout

- [x] Verify credentials with a generic failure response that does not distinguish a missing account from an incorrect password.
- [x] Regenerate the session at successful login and establish a new absolute expiry.
- [x] Allow pending/rejected users to authenticate for status display; deny disabled accounts.
- [x] Implement `GET /auth/me` with current database state and no password/pending-profile leakage.
- [x] Implement logout by destroying the stored session and clearing the matching cookie.
- [x] Test logout, expiry, bad credentials, session regeneration, and account disablement after login.

### 2.6 Add account and role guards

- [x] Add reusable authentication, active-account, and allowed-role middleware.
- [x] Keep status and logout endpoints accessible to pending/rejected sessions while rejecting portal data access.
- [x] Verify an active doctor/patient still has a valid linked profile before serving protected data.
- [x] Add service-level helpers for own-profile lookup and doctor–patient assignment checks.
- [x] Use `401` for missing authentication, `403` for forbidden roles/status, and `404` for out-of-scope records.
- [x] Test the guards with real database users and test-only protected handlers; do not add unfinished production management endpoints merely to test permissions.

### 2.7 Add admin registration review

- [x] Implement admin-only paginated registration listing with status and role filters.
- [x] Implement registration detail using a dedicated admin projection of submitted profile information.
- [x] Exclude password hashes and session data even from admin responses.
- [x] Verify doctors, patients, pending users, and anonymous clients cannot inspect registrations.

### 2.8 Implement transactional approval and rejection

- [x] Implement `PUT /registrations/:id/decision` with explicit approve/reject payloads.
- [x] For approval, either link an unclaimed matching-email profile or create a role-appropriate profile from reviewed information.
- [x] Require admin confirmation of patient condition/status and enforce immutable role and one-account-per-profile rules.
- [x] Activate the account and attach the profile in one transaction.
- [x] For rejection, retain the submission and optional rejection reason without creating an active profile.
- [x] Return a conflict for inconsistent or competing decisions and test rollback after a failed write.

### 2.9 Add throttling and safe responses

- [x] Rate-limit registration and login, including repeated login failures by account/IP where appropriate.
- [x] Return consistent `429` responses and usable retry information.
- [x] Check that all authentication errors use the shared error contract and do not expose secrets.
- [x] Verify all role-specific DTOs and session logs exclude private account fields.

### 2.10 Verify the access matrix and document client usage

- [x] Exercise anonymous, pending, rejected, disabled, admin, doctor, and patient states in integration tests.
- [x] Test attempted role escalation, profile impersonation, duplicate email/profile linkage, and stale account state in an existing session.
- [x] Test approval of both new profiles and matching existing profiles, including simultaneous approval attempts.
- [x] Document the CSRF → register/login → current-user → logout flow with cookie-aware example requests.
- [x] Run lint, formatting checks, type checking, integration tests, and build locally using the CI commands.
- [ ] Confirm hosted CI passes after the owner creates/pushes the remote; deferred under the existing local-only Git instruction (no remote configured).

## Exit checklist

- [x] Doctors and patients can register, log in, and see their account status.
- [x] Only admins can approve/reject registration and activate correctly linked profiles.
- [x] Persistent sessions, CSRF validation, rate limits, and logout are verified.
- [x] Authorization helpers enforce role, account status, profile identity, and assignment scope.
- [x] No frontend work has started; management endpoints can now reuse the verified access rules.

## Handoff record

- Completed implementation commit: `ff949ba` — Add session authentication and transactional registration review. Handoff documentation is committed separately.
- Validation commands and results: clean `npm ci`, lint, formatting, strict type checking, all 116 tests in six suites, and build passed on 2026-10-31. `npm run db:indexes` succeeded against the configured development Atlas database. See [validation record](milestone-02-validation.md).
- Remaining blockers or deviations: implementation and local verification are complete. Hosted CI is deferred until the owner creates/pushes the remote. No frontend or production management endpoints were added. See [client usage](authentication.md) and [generated OpenAPI contract](openapi.json).
- Next step: [Milestone 3 — Management and clinical APIs](milestone-03-management-and-clinical-apis.md).
