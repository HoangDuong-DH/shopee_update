// Run only in an internal fixture checkout. No user URL or operating database is accepted.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
// @ts-expect-error Existing fixture helper is JavaScript without declaration output.
import { readIsolated } from './internal-environment.mjs';
// @ts-expect-error Pure JavaScript helper is covered by Node regression tests.
import { parseEnduranceArgs, BoundedLatency } from './runtime-endurance-core.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (resolve(process.cwd()) !== root) throw Error('ENDURANCE_CWD_INVALID');
const options = parseEnduranceArgs(process.argv.slice(2));
const { env } = await readIsolated(root);
const database = new URL(env.DATABASE_URL!);
if (
  database.hostname !== '127.0.0.1' ||
  database.port !== '5443' ||
  database.pathname !== '/shopee_internal_test' ||
  env.SHOPEE_PRODUCTION_WRITES !== 'false' ||
  env.PRODUCTION_PILOT_ENABLED !== '0'
)
  throw Error('ENDURANCE_TARGET_REJECTED');
Object.assign(process.env, env);
// @ts-expect-error Existing JavaScript preload installs the fixture fetch guard.
await import('./internal-network-guard.mjs');
const [{ createRuntimePool }, { Repository }, { BlobStore }, { createApp }] = await Promise.all([
  import('../packages/persistence/src/runtime-pool.js'),
  import('../packages/persistence/src/repository.js'),
  import('../packages/persistence/src/blob-store.js'),
  import('../apps/api/src/app.js'),
]);
const pool = createRuntimePool(env),
  app = await createApp(new Repository(pool), new BlobStore(env.DATA_ROOT!), [
    'http://127.0.0.1:5273',
  ]);
const parent = resolve(root, '.local/internal/endurance');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(resolve(parent, 'run-'));
const latency = new BoundedLatency(),
  failures: Record<string, number> = {},
  samples: object[] = [];
const delay = monitorEventLoopDelay({ resolution: 20 });
let timer: ReturnType<typeof setInterval> | undefined;
let started = performance.now(),
  peakClients = 0,
  peakWaiting = 0;
const sample = () => {
  global.gc?.();
  const m = process.memoryUsage();
  samples.push({
    elapsedMs: Math.round(performance.now() - started),
    heapMB: Math.round(m.heapUsed / 1048576),
    rssMB: Math.round(m.rss / 1048576),
    waiting: pool.waitingCount,
    clients: pool.totalCount,
  });
};
try {
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const paths = [
    '/health/ready',
    '/v1/operations/overview',
    '/v1/shops',
    '/v1/products?page=1&limit=25',
  ];
  started = performance.now();
  const deadline = started + options.seconds * 1000;
  sample();
  timer = setInterval(sample, 30000);
  delay.enable();
  await Promise.all(
    Array.from({ length: options.concurrency }, async (_, lane) => {
      let n = 0;
      while (performance.now() < deadline) {
        const t = performance.now();
        try {
          const r = await fetch(base + paths[(lane + n++) % paths.length], {
            signal: AbortSignal.timeout(4000),
          });
          await r.arrayBuffer();
          if (r.status !== 200) failures[String(r.status)] = (failures[String(r.status)] ?? 0) + 1;
        } catch {
          failures.timeout = (failures.timeout ?? 0) + 1;
        }
        latency.add(performance.now() - t);
        peakClients = Math.max(peakClients, pool.totalCount);
        peakWaiting = Math.max(peakWaiting, pool.waitingCount);
        await new Promise((ok) => setTimeout(ok, options.intervalMs));
      }
    }),
  );
  sample();
  const result = {
    at: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...options,
    requests: latency.count,
    failures,
    p50Ms: latency.percentile(0.5),
    p95Ms: latency.percentile(0.95),
    p99Ms: latency.percentile(0.99),
    maxMs: latency.maxMs,
    eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
    peakClients,
    peakWaiting,
    samples,
    liveWrites: 0,
    limitations: [
      'Fixture only; no production Shopee calls',
      'Duration is measured, not a claim of 24-hour acceptance',
      'Does not seed representative large shop or run mutation jobs',
    ],
  };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      output,
      requests: result.requests,
      durationMs: result.durationMs,
      failures,
      p95Ms: result.p95Ms,
    }),
  );
  if (Object.keys(failures).length) process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  delay.disable();
  await app.close();
  await pool.end();
}
