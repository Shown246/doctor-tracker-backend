import {
  adminIdentitySchema,
  provisionAdmin,
} from '../modules/auth/provision-admin.js';
import { runDatabaseCommand } from './run-command.js';

// Credentials are environment-only; never accept passwords as command-line arguments.
const identity = adminIdentitySchema.safeParse({
  name: process.env.ADMIN_NAME,
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});
delete process.env.ADMIN_PASSWORD;

if (!identity.success) {
  console.error(
    'Set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD (12–128 characters).',
  );
  process.exitCode = 1;
} else {
  await runDatabaseCommand(async (_config, logger) => {
    const result = await provisionAdmin(identity.data);
    logger.info(result, 'Admin account created');
  });
}
