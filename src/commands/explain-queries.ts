import { writeFile } from 'node:fs/promises';
import { runDatabaseCommand } from './run-command.js';
import { assertFixtureTarget } from '../database/fixtures.js';
import { collectQueryPlans } from '../database/query-plans.js';

await runDatabaseCommand(async (config, logger) => {
  assertFixtureTarget(config, process.env, 'performance');
  const report = await collectQueryPlans();
  // Output has synthetic query descriptors/counts/plans only, never driver commands or payloads.
  await writeFile(
    'docs/query-plans.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  logger.info({ queries: report.plans.length }, 'Wrote docs/query-plans.json');
});
