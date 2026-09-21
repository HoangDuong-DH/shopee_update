import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Operator acceptance runner. All network calls go to the local backend; no credentials enter this script.
const runName = process.argv[2];
if (!runName || !/^[A-Z0-9_-]{1,40}$/.test(runName))
  throw new Error('Supply a unique acceptance run name (A-Z, digits, _ or -).');
const execute = process.argv.includes('--execute');
const root = resolve('.local/acceptance-20260914', runName);
await mkdir(root, { recursive: true });
const api = 'http://127.0.0.1:4310/v1';
async function call(path: string, body?: unknown) {
  const started = Date.now();
  const response = await fetch(api + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-App-Client': 'internal-workspace',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
    redirect: 'error',
  });
  const data = await response.json();
  return {
    httpStatus: response.status,
    durationMs: Date.now() - started,
    observedAt: new Date().toISOString(),
    body: data,
  };
}
async function store(name: string, value: unknown) {
  await writeFile(resolve(root, name), JSON.stringify(value, null, 2));
}
const shops = (await call('/shops')).body;
const shop = shops.find(
  (s: any) =>
    s.scope.environment === 'sandbox' &&
    s.scope.partnerId === '1232297' &&
    s.scope.shopId === '227418363',
);
if (!shop) throw new Error('No matching TEST connection; nothing was written.');
const trials = (await call('/sandbox-create-trials')).body;
const verified = trials
  .flatMap((t: any) => t.items)
  .filter(
    (i: any) =>
      i.state === 'verified' && i.itemId && !['803934364', '846056124'].includes(i.itemId),
  );
const targets = [0, 1, 2]
  .map((tierCount) =>
    verified.find(
      (i: any) => (i.intent.tiers?.standardise_tier_variation?.length ?? 0) === tierCount,
    ),
  )
  .filter(Boolean);
if (targets.length !== 3)
  throw new Error('Missing verified zero/one/two-tier technical targets; no writes.');
const cases: any[] = [];
for (const target of targets) {
  const initial = target.result?.evidence,
    models = initial?.models?.model ?? [];
  if (!initial?.item) throw new Error('Missing historical source receipt; no writes.');
  const targetModel = models[0];
  const modelId = targetModel ? Number(targetModel.model_id) : 0;
  const stock = (targetModel ?? initial.item).stock_info_v2?.seller_stock;
  const price = (targetModel ?? initial.item).price_info?.[0]?.original_price;
  if (!stock || stock.length !== 1 || !Number.isSafeInteger(Number(price)))
    throw new Error('Unknown stock/price source; no writes.');
  const gallery = target.intent.create.image.image_id_list;
  for (const operation of [
    {
      kind: 'title',
      value: `SANDBOX QA field test ${runName} ${target.sourceKey.split('-').at(-1)}`,
    },
    {
      kind: 'description',
      value: {
        description_type: 'normal',
        description: `SANDBOX ONLY. Prepared acceptance text ${runName}.\n\nGiữ nguyên dòng trống và ký tự: Ắ ệ & < >.\nThử theo đúng nguồn kỹ thuật ${target.sourceKey}.`,
      },
    },
    {
      kind: 'gallery',
      value: { image_ratio: '1:1', image_id_list: [gallery[0], ...gallery.slice(1).reverse()] },
      preserveCover: [],
    },
    { kind: 'price', value: [{ model_id: modelId, original_price: Number(price) + 100 }] },
    {
      kind: 'stock',
      value: [
        {
          model_id: modelId,
          seller_stock: [
            { stock: 2, ...(stock[0].location_id ? { location_id: stock[0].location_id } : {}) },
          ],
        },
      ],
    },
  ])
    cases.push({
      id: randomUUID(),
      trialItemId: target.id,
      connectionRevision: shop.scope.connectionRevision,
      operation,
    });
}
let manifest: any;
try {
  manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
} catch (error: any) {
  if (error.code !== 'ENOENT') throw error;
  manifest = {
    createdAt: new Date().toISOString(),
    scope: shop.scope,
    connectionId: shop.id,
    origin: 'explicit synthetic acceptance changes, not company source',
    cases,
  };
  await store('manifest.json', manifest);
}
if (
  manifest.connectionId !== shop.id ||
  manifest.scope.connectionRevision !== shop.scope.connectionRevision
)
  throw new Error(
    'Pinned connection changed. Use a new run name; old intents will not be replayed.',
  );
if (!execute) {
  console.log(
    JSON.stringify({
      mode: 'plan',
      caseCount: manifest.cases.length,
      manifest: resolve(root, 'manifest.json'),
      writes: 0,
    }),
  );
  process.exit(0);
}
const summary: any = {
  scope: manifest.scope,
  startedAt: new Date().toISOString(),
  caseCount: manifest.cases.length,
  results: [],
  productionWrites: 0,
};
for (const [index, test] of manifest.cases.entries()) {
  const filename = String(index + 1).padStart(2, '0') + '-' + test.operation.kind;
  const prepared = await call('/sandbox-field-trials/prepare', test);
  await store(filename + '-prepare.json', prepared);
  if (prepared.httpStatus >= 400) {
    summary.results.push({
      index,
      kind: test.operation.kind,
      state: 'blocked',
      code: prepared.body.code,
    });
    break;
  }
  const done = await call('/sandbox-field-trials/execute', {
    id: prepared.body.id,
    fingerprint: prepared.body.fingerprint,
  });
  await store(filename + '-execute.json', done);
  summary.results.push({
    index,
    kind: test.operation.kind,
    id: prepared.body.id,
    itemId: prepared.body.itemId,
    state: done.body.state ?? 'blocked',
    httpStatus: done.httpStatus,
    check: done.body.result?.check ?? null,
  });
  await store('summary.json', summary);
  if (done.httpStatus >= 400 || done.body.state !== 'verified') break;
}
summary.finishedAt = new Date().toISOString();
summary.verified = summary.results.filter((r: any) => r.state === 'verified').length;
summary.unattempted = summary.caseCount - summary.results.length;
await store('summary.json', summary);
console.log(JSON.stringify(summary));
// An acceptance command must not report shell success when it stopped before verification.
process.exitCode = summary.verified === summary.caseCount ? 0 : 2;
