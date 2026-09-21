import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobStore, Pool, Repository } from '@shopee/persistence';
import {
  parsePass1Arguments,
  runPass1ProductionBatch,
} from '../apps/api/src/production-batch-runner.js';
export { parsePass1Arguments, runPass1ProductionBatch };
export type { Pass1BatchArguments } from '../apps/api/src/production-batch-runner.js';

async function main() {
  let pool: Pool | undefined;
  try {
    const args = parsePass1Arguments(process.argv.slice(2));
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const result = await runPass1ProductionBatch(args, {
      repo: new Repository(pool),
      blobs: new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
    });
    console.log(JSON.stringify(result));
    if (result.stopped) process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(
      JSON.stringify({
        code: /^(PASS1|PRODUCTION_BATCH|PRODUCTION_PILOT)_[A-Z_]+$/.test(message)
          ? message
          : 'PASS1_REQUEST_FAILED',
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
