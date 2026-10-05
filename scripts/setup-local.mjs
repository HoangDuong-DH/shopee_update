import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, setupLocal } from './onboarding-core.mjs';

export { setupLocal };
if (isMain(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw Error('UNKNOWN_SETUP_ARGUMENT');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log((await setupLocal(root)).message);
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_SETUP_FAILED';
    console.error(`${code}: Configuration was preserved. Resolve the incomplete setup before retrying.`);
    process.exitCode = 1;
  }
}
