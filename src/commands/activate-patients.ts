import { activatePendingPatient } from '../modules/auth/activate-patients.js';
import { User } from '../modules/auth/user.model.js';
import { runDatabaseCommand } from './run-command.js';

await runDatabaseCommand(async (_config, logger) => {
  let activated = 0;
  let failed = 0;
  for await (const user of User.find({ role: 'patient', status: 'pending' })
    .select('_id')
    .cursor()) {
    try {
      if (await activatePendingPatient(user.id)) activated++;
    } catch {
      failed++;
      logger.error(
        { userId: user.id },
        'Patient activation failed; account left pending. Check for invalid registration details or an existing patient profile with the same email.',
      );
    }
  }
  logger.info({ activated, failed }, 'Pending patient activation complete');
  if (failed) process.exitCode = 1;
});
