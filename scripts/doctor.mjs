import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDoctor, parseBootstrapArgs, formatPlan, safeError, isMain } from './onboarding-core.mjs';

export { inspectDoctor };
if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--apply') || args.includes('--skip-install')) throw Error('DOCTOR_INSPECT_ONLY');
    const options = parseBootstrapArgs(args);
    if (options.help) console.log('Usage: node scripts/doctor.mjs [--json]. Inspect-only local checks; no installation, service start or migration.');
    else {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const result = await inspectDoctor(root, options);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatPlan(result));
      if (!result.ready) process.exitCode = 1;
    }
  } catch (error) {
    const code = safeError(error, 'DOCTOR_CHECK_FAILED');
    if (process.argv.includes('--json')) console.log(JSON.stringify({ version: 1, mode: 'doctor', ready: false,
      checks: [{ id: 'command', status: 'blocked', code, action: 'Resolve the local check before retrying. No changes were made.' }] }, null, 2));
    else console.error(`${code}: No changes were made.`);
    process.exitCode = 1;
  }
}
