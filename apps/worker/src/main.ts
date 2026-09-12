import 'dotenv/config';
import { hostname } from 'node:os';
import { Pool, Repository, BlobStore, SandboxCreateTrialStore } from '@shopee/persistence';
import { importNext } from './imports.js';
import { runSandboxCreateTrialOnce } from './sandbox-create-trials.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
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
while (!stopped) {
  try {
    await pool.query(
      'INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=now()',
      [workerId],
    );
    // Give both queues a turn; imports must not starve a submitted bounded trial.
    const trialProcessed = await runSandboxCreateTrialOnce({ store: trials, repo, workerId });
    const processed = await importNext(repo, blobs);
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
await pool.end();
