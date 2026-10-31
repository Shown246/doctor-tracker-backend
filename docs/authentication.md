# Authentication and registration approval

All paths are relative to `/api/v1`. The [OpenAPI 3.1 contract](openapi.json) is generated from the runtime Zod schemas with `npm run docs:openapi`. See [management](management-and-clinical.md), [analytics](analytics.md) and [deployment](deployment.md) for the complete backend workflows.

## Client session flow

1. Fetch `GET /auth/csrf`. Retain the cookie and `data.csrfToken`.
2. Send the token in `X-CSRF-Token` on every mutation, including registration, login and logout. Retain cookies across requests.
3. Registration returns `201` with a pending account. It neither logs in nor creates a doctor/patient profile.
4. Login returns `200` and regenerates the session, invalidating the previous cookie and CSRF token. Immediately fetch `/auth/csrf` again before another mutation.
5. Fetch `/auth/me` to read current database state. Pending/rejected accounts can view their status; rejection reasons appear only for rejected accounts. Disabled sessions receive `403`; disabled login receives the same generic `401` as invalid credentials. An active doctor/patient must have an existing linked profile with a matching email.
6. Logout destroys the stored session, expires its matching cookie and returns `204`. Subsequently disabled session holders can still log out with their valid CSRF token.

Session data contains only the user ID, absolute expiry, CSRF token and cookie metadata. Roles, account status, profile details and password hashes are never cached in a session. Every protected request loads current account state. Sessions survive process restarts when the database and secret stay the same. All feature responses use `Cache-Control: private, no-store`.

The `doctor_tracker.sid` cookie is host-only, `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Both authenticated and anonymous CSRF sessions expire eight hours after establishment. Activity never extends that deadline. MongoDB TTL cleanup is asynchronous; both the store lookup and server deadline enforce expiry without waiting for cleanup. Configure `TRUST_PROXY` for the actual proxy network so production HTTPS is detected correctly.

Browser `Origin`, or `Referer` when Origin is absent, must match `FRONTEND_ORIGIN` exactly. `Origin: null` is denied. Cross-site Fetch Metadata without an allowed origin is denied. Non-browser clients may omit browser headers, but still require the token and cookie. Browser clients use same-origin forwarding through the planned frontend proxy; the backend does not grant cross-origin CORS access.

## Registration bodies

Doctor example:

```json
{
  "role": "doctor",
  "name": "Dr Example",
  "email": "doctor@example.test",
  "password": "synthetic-example-password",
  "profile": {
    "specialization": "Cardiology",
    "hospital": "Example Hospital",
    "phone": "+8801700000000"
  }
}
```

For a patient, use `role: "patient"` with this profile:

```json
{
  "dateOfBirth": "1995-02-28",
  "gender": "undisclosed",
  "phone": "+8801800000000",
  "address": "Optional synthetic address"
}
```

Names and required profile text cannot be blank. Emails are trimmed and lowercased. Passwords are 12–128 characters and hashed with the existing Argon2id helper. Birth dates are real `YYYY-MM-DD` dates from 1900 through today in Asia/Dhaka. Gender is `female`, `male`, `other` or `undisclosed`. Unknown fields, public admin roles, status/profile references and private notes are rejected, including nested unknown fields. Duplicate normalized account emails return `409`.

A current-user response has exactly these fields, plus an optional `rejectionReason` for rejected accounts:

```json
{
  "data": {
    "id": "0123456789abcdef01234567",
    "name": "Dr Example",
    "email": "doctor@example.test",
    "role": "doctor",
    "status": "pending",
    "profileId": null
  }
}
```

## Cookie-aware PowerShell example

Run against a configured local server. The credentials below are synthetic; the registered account needs admin approval before accessing portal data.

```powershell
$base = 'http://localhost:4000/api/v1'
$csrf = Invoke-RestMethod "$base/auth/csrf" -SessionVariable apiSession
$headers = @{ 'X-CSRF-Token' = $csrf.data.csrfToken }
$registration = @{
    role = 'doctor'
    name = 'Dr Example'
    email = 'doctor@example.test'
    password = 'synthetic-example-password'
    profile = @{
        specialization = 'Cardiology'
        hospital = 'Example Hospital'
        phone = '+8801700000000'
    }
} | ConvertTo-Json -Depth 4
Invoke-RestMethod "$base/auth/register" -Method Post -WebSession $apiSession `
    -Headers $headers -ContentType 'application/json' -Body $registration
$credentials = @{
    email = 'doctor@example.test'
    password = 'synthetic-example-password'
} | ConvertTo-Json
Invoke-RestMethod "$base/auth/login" -Method Post -WebSession $apiSession `
    -Headers $headers -ContentType 'application/json' -Body $credentials
# Login changes both the cookie and token. Obtain the replacement token.
$csrf = Invoke-RestMethod "$base/auth/csrf" -WebSession $apiSession
$headers = @{ 'X-CSRF-Token' = $csrf.data.csrfToken }
Invoke-RestMethod "$base/auth/me" -WebSession $apiSession
Invoke-RestMethod "$base/auth/logout" -Method Post -WebSession $apiSession `
    -Headers $headers -ContentType 'application/json' -Body '{}'
```

## Admin review and decisions

Provision admins privately with `npm run admin:create`, then use the same CSRF/login flow. Only active admins can access:

| Method and path                   | Behavior                                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| `GET /registrations`              | Paginated public submissions, including decided submissions      |
| `GET /registrations/:id`          | Summary plus a dedicated projection of submitted profile details |
| `PUT /registrations/:id/decision` | Final approval or rejection of a pending submission              |

List filters are optional `role=doctor|patient` and `status=pending|active|rejected|disabled`; `page` defaults to 1, `limit` to 20 with a maximum of 100. Sorting is newest first with `_id` as the stable tie-breaker. Unknown/repeated query fields are rejected. Lists omit submitted profile details; even detail/decision responses exclude password hashes, session data and model internals.

Approve a new doctor:

```json
{ "decision": "approve", "mode": "create" }
```

Approve a new patient, explicitly confirming clinical fields:

```json
{
  "decision": "approve",
  "mode": "create",
  "patientClinical": { "condition": "Reviewed condition", "status": "stable" }
}
```

Condition may be an empty string to confirm no recorded condition. Status is `unassessed`, `under_treatment`, `stable`, `critical` or `recovered`. Doctor approvals reject patient clinical fields.

Link an existing unclaimed profile with the same normalized email and matching role:

```json
{
  "decision": "approve",
  "mode": "link",
  "profileId": "0123456789abcdef01234567"
}
```

Linking preserves the existing profile's data. Creation fails with `409` if a profile with the same email already exists; the admin must explicitly choose linking. Invalid, missing, mismatched or already claimed profiles cannot be linked. The profile change and account activation commit in one transaction. Failed writes roll back; competing decisions have one winner and a `409` loser. Repeated decisions return `409`, including attempting to approve a rejected registration.

Reject without creating a profile, retaining the submitted information:

```json
{ "decision": "reject", "reason": "Optional explanation" }
```

## Access rules and throttling

Reusable middleware requires authentication, active account state and allowed roles. Service helpers return an account's own profile and validate patient access for admins, assigned doctors and the patient themself. Out-of-scope patient IDs return `404`, absent authentication `401`, and forbidden roles/status `403`. Doctors' assignment scopes come from their authenticated profile ID. Note services must additionally restrict note queries to that doctor ID and deny patients; the tests demonstrate this using test-only protected handlers. No management or note endpoints are exposed yet.

Milestone 3 must put clinical authorization and mutation in transactions that serialize writes against assignment removal. A successful assignment read alone does not establish a write lock. Patient DTOs contain no private notes, pending submissions or password fields.

Rate limits use MongoDB atomic counters shared across processes and application restarts:

| Endpoint     | Fixed window limit                                   |
| ------------ | ---------------------------------------------------- |
| Registration | 10 attempts per IP per hour                          |
| Login        | 30 attempts per IP per 15 minutes                    |
| Login        | 10 attempts per normalized email + IP per 15 minutes |

Attempts reaching the limiter count even when credentials/body validation fail or login succeeds. CSRF/origin failures are rejected before these counters. Responses use the shared `429 RATE_LIMITED` error envelope with `Retry-After` seconds. Counter keys use HMAC digests; raw email/IP/password values are not stored or logged. Run `db:indexes` to install expiry indexes for sessions and counters. Read-only CSRF/status requests are not login attempts.
