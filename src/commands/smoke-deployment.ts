import { runSmoke, smokeConfigurationSchema } from '../verification/smoke.js';

try {
  const config = smokeConfigurationSchema.parse(process.env);
  const result = await runSmoke({
    baseUrl: config.SMOKE_BASE_URL,
    origin: config.SMOKE_ORIGIN,
    adminEmail: config.SMOKE_ADMIN_EMAIL,
    adminPassword: config.SMOKE_ADMIN_PASSWORD,
    fixturePassword: config.SMOKE_FIXTURE_PASSWORD,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error: unknown) {
  console.error(
    error instanceof Error && error.message.startsWith('Smoke check failed:')
      ? error.message
      : 'Deployment smoke verification failed. Check the explicitly selected HTTPS demo URL, credentials and setup; no response payloads or credentials are logged.',
  );
  process.exitCode = 1;
}
