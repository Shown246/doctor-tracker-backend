# Backend deployment and release gate

Local implementation is a release candidate, `1.0.0-rc.1`. No Render service, hosted CI result, demo Atlas deployment or `v1.0.0` release is claimed. The existing handoff keeps Git operations local; there is no configured remote. Hosting access and dedicated demo credentials remain prerequisites. Do not start frontend implementation until the full milestone 4 gate passes.

## Render and Atlas setup

1. The owner publishes the backend repository, authorizes remote operations and confirms GitHub Actions is green for the exact implementation commit. All local checks must pass first.
2. Create `doctor_tracker_demo` in Atlas with a dedicated database user limited to that database. Keep development/test databases and users separate. Configure Atlas network access for the actual Render service's egress addresses and the explicitly selected provisioning machine; do not copy development credentials.
3. Create a free Node web service from [render.yaml](../render.yaml), connected to the backend `main` branch. The blueprint pins the tested Node.js 24 runtime, installs build dependencies, builds TypeScript, runs `npm start` and checks `/health/ready`. It disables automatic deployments. It skips the development MongoDB binary postinstall download on the hosted build. The server binds `0.0.0.0` using Render's `PORT`.
4. Set secret `MONGODB_URI`, generated stable `SESSION_SECRET`, exact HTTPS `FRONTEND_ORIGIN` and an explicitly verified `TRUST_PROXY` IP/CIDR list. Leave `PORT` to Render. `NODE_ENV=production` enables Secure, HttpOnly, host-only, SameSite=Lax session cookies. Keep the signing secret stable across instances/restarts. Use safe info-level logs; credentials, headers and patient payloads are excluded.
5. Verify the actual Render proxy topology before selecting `TRUST_PROXY`. This application intentionally rejects unrestricted `true` or hop-count trust. If the verified upstream uses private addresses, the supported `uniquelocal` subnet may be appropriate; otherwise supply the verified IPs/CIDRs. Test forwarded HTTPS and client-IP throttling. This cannot be finalized without an actual service/network.
6. Run `npm run db:indexes` explicitly against the demo database from an authorized provisioning environment **before exposing application workflows**. Startup never creates indexes. This can be run locally with the dedicated demo configuration; it does not require a paid Render shell/pre-deploy feature. A successful readiness ping establishes connectivity, not index correctness.
7. Supply the six external demo email/password values and invoke the guarded seed in [data-and-performance.md](data-and-performance.md). Alternatively provision a private admin with `admin:create` first; use distinct credentials/emails if also running the three-role demo seed. Never seed on each deployment or put credentials into the blueprint/build command.
8. Trigger deployment, inspect safe startup logs and verify HTTPS readiness. Record service URL, commit SHA, region, database name (no URI), setup date and actual proxy configuration in the validation record.

Before frontend implementation, `FRONTEND_ORIGIN` can be the exact backend HTTPS origin to support the admin explorer. Cookie-aware native clients may omit browser origin headers. When Vercel is ready, replace this value with the single exact approved Vercel production/custom origin and redeploy. Browser requests, including docs, then use the frontend's `/api/v1` rewrite. Do not allow arbitrary preview origins or wildcard credentialed CORS. Keep both repositories independent and retain the backend's authoritative permission checks.

See Render's [Express deployment guide](https://render.com/docs/deploy-node-express-app), [port requirements](https://render.com/docs/web-services#port-binding), [Blueprint reference](https://render.com/docs/blueprint-spec) and [runtime selection](https://render.com/docs/node-version), plus Express's [proxy trust guidance](https://expressjs.com/en/guide/behind-proxies/). Settings above were checked against those primary references during implementation.

## HTTPS acceptance client

Use only the synthetic demo service. Set the following through temporary environment variables or the ignored `.env`, then run:

```powershell
$env:SMOKE_BASE_URL = 'https://YOUR-SERVICE.onrender.com'
$env:SMOKE_ALLOW_WRITES = 'true'
# Set SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD and SMOKE_FIXTURE_PASSWORD securely.
# Optional SMOKE_ORIGIN must equal the configured browser origin to test origin checks.
npm run smoke:deployment
```

This uses native cookie-aware HTTP requests and externally supplied credentials, validates secure cookie flags on HTTPS, and exercises health, CSRF denial, both public registration roles, pending denial, approval visible to existing sessions, management/duplicate links, clinical revision conflicts, private notes, all role dashboards, scoped filters, unlink/relink with note deletion, patient deletion/account disablement, and logout/replay rejection. A fresh synthetic doctor profile and two account submissions remain per run; the patient profile is deleted. The client never logs credentials, cookies or response payloads. It deliberately does not retry non-idempotent mutations automatically. Its same code is tested against an independent local HTTP listener on an isolated replica set; that does not replace hosted execution.

Also verify an unauthorized browser origin is rejected and the production CSRF cookie/session survives real HTTPS requests. Test account-status changes using the approved workflows; the smoke client observes approval and patient-deletion disablement without relogin. Record results with the exact commit. Do not mark the hosted checks complete merely because the local runner passes.

## Restart persistence and cold start

Log in with a cookie-aware API client, retain its cookie in a protected local jar under ignored `.cache/`, restart/redeploy the Render service without changing the secret, and repeat `/auth/me` and role-specific reads before the eight-hour absolute expiry. Verify stored demo data and session identity persist; then log out and verify replay fails. Record the actual restart result. Local process-restart persistence is covered by the existing lifecycle suite, but hosted restart persistence needs the actual service.

Render documents idle spin-down after 15 minutes and roughly one minute to restart a free service. Record observed first-request delay separately from warm API latency. No paid upgrade is authorized by this configuration. See the [free-tier limitations](https://render.com/docs/free).

## Publish the stable contract

Only after all hosted checks pass, update package/lockfile and `createOpenApiDocument().info.version` from the release candidate to `1.0.0`, regenerate the artifact and rerun the required checks. Commit and publish the exact verified code. Create the `v1.0.0` tag on that verified commit, publish the GitHub release, and attach `docs/openapi.json` as `openapi.json`. Record the release URL, artifact SHA-256, tested commit and hosted URL in the milestone handoff.

The frontend should download the versioned release asset, generate its own TypeScript definitions and commit those generated definitions in its independent repository. It should not import backend source or rely on a mutable default-branch contract. The repository artifact and authenticated `/api/v1/docs/openapi.json` are generated from runtime Zod schemas and tested for drift; neither is represented as an already published stable release.
