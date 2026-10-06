import 'dotenv/config';
import { transferRecoveryRequired } from '@shopee/persistence';
if (transferRecoveryRequired()) throw new Error('TRANSFER_WORKER_HELD');
import { hostname } from 'node:os';
import { Repository, BlobStore, SandboxCreateTrialStore, createRuntimePool } from '@shopee/persistence';
import { importNext } from './imports.js';
import { runSandboxCreateTrialOnce } from './sandbox-create-trials.js';
const pool = createRuntimePool(),
  repo = new Repository(pool),
  blobs = new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
  trials = new SandboxCreateTrialStore(pool);
const workerId = `${hostname()}:${process.pid}`;
let stopped = false;
let retryDelay = 1000,
  lastFailureLog = 0,
  hadFailure = false;
process.once('SIGINT', () => {
  stopped = true;
});
process.once('SIGTERM', () => {
  stopped = true;
});
console.log('Worker started: source imports and explicitly queued TEST create trials only.');
async function heartbeat() {
  await pool.query('INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=now()', [workerId]);
}
let heartbeatInFlight: Promise<void> | null = null;
const heartbeatTimer = setInterval(() => {
  if (stopped || heartbeatInFlight) return;
  heartbeatInFlight = heartbeat().catch(() => { /* Main loop reports storage failures. */ })
    .finally(() => { heartbeatInFlight = null; });
}, 5000);
heartbeatTimer.unref();
while (!stopped) {
  try {
    await heartbeat();
    // Give both queues a turn; imports must not starve a submitted bounded trial.
    const trialProcessed = await runSandboxCreateTrialOnce({ store: trials, repo, workerId });
    const processed = await importNext(repo, blobs, { workerId });
    if (hadFailure) console.log('Source worker storage connection recovered.');
    hadFailure = false;
    retryDelay = 1000;
    if (processed && !trialProcessed) continue;
  } catch {
    if (!hadFailure || Date.now() - lastFailureLog >= 60000) {
      console.error('Worker temporarily unavailable; retrying the database connection.');
      lastFailureLog = Date.now();
    }
    hadFailure = true;
    await new Promise((r) => setTimeout(r, retryDelay));
    retryDelay = Math.min(30000, retryDelay * 2);
    continue;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
clearInterval(heartbeatTimer);
await heartbeatInFlight;
await pool.end();
