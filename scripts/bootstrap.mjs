import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOnboarding, inspectOnboarding, parseBootstrapArgs, formatPlan, safeError, isMain } from './onboarding-core.mjs';

export { applyOnboarding, inspectOnboarding, parseBootstrapArgs };
if (isMain(import.meta.url)) {
  try {
    const options = parseBootstrapArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/bootstrap.mjs [--apply] [--json] [--api-port PORT] [--web-port PORT] [--db-port PORT] [--skip-install]');
      console.log('Default: read-only plan. --apply: fresh local setup, no application start or Shopee calls. --skip-install: developer rehearsal with exact same-root dependencies only.');
    } else {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const adapters = options.json ? {} : { onPhase: update => console.log(`${update.phase}: ${update.state}`) };
      const result = options.apply ? await applyOnboarding(root, options, adapters) : await inspectOnboarding(root, options);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else if (!options.apply) console.log(formatPlan(result));
      else if (result.status === 'complete') console.log(`Local setup complete. API ${result.ports.apiPort}; web ${result.ports.webPort}; database ${result.ports.databasePort}. Receipt: ${result.receiptPath}. No application started.`);
      else if (result.plan) console.log(formatPlan(result.plan));
      else console.error(`${result.code}: ${result.action}`);
      if (options.apply ? result.status !== 'complete' : !result.ready) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`${safeError(error, 'ONBOARDING_COMMAND_FAILED')}: Setup stopped; existing files and services are preserved.`);
    process.exitCode = 1;
  }
}
