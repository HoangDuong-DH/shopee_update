import 'dotenv/config';
import { resolve } from 'node:path';
import { Pool, Repository } from '../packages/persistence/src/index.js';
import { refreshProductionPilotConnection } from '../apps/api/src/production-refresh-service.js';
const args = process.argv.slice(2);
const revisionArg = args.find((arg) => /^--expected-revision=[1-9]\d*$/.test(arg));
const recover = args.includes('--recover');
if (
  !revisionArg ||
  args.some((arg) => arg !== revisionArg && arg !== '--recover') ||
  new Set(args).size !== args.length
) {
  console.error('Usage: refresh-production-pilot-connection.mts --expected-revision=N [--recover]');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await refreshProductionPilotConnection(new Repository(pool), {
    expectedRevision: Number(revisionArg.split('=')[1]),
    mode: recover ? 'recover' : 'refresh',
    receiptRoot: resolve('.local/production-pilot-1423724897/credential-refresh'),
  });
  console.log(JSON.stringify(result));
  if (!['success', 'already_saved'].includes(result.kind)) process.exitCode = 2;
} catch (error) {
  const code =
    error instanceof Error && /^PRODUCTION_REFRESH_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'PRODUCTION_REFRESH_FAILED_CHECK_LOCAL_RECEIPT';
  console.error(JSON.stringify({ kind: 'blocked', code }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
