import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Pool, Repository } from '../packages/persistence/src/index.js';
import { SecretBox } from '../packages/shopee/src/secret-box.js';
import { SandboxPreparedTransport } from '../packages/shopee/src/prepared-transport.js';
import {
  normalizePreparedWireSnapshot,
  type PreparedWirePlan,
} from '../packages/shopee/src/prepared-wire.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import { pollPreparedReadback } from '../packages/shopee/src/prepared-readback.js';
import { PreparedWireRunner } from '../apps/api/src/prepared-wire-runner.js';
const folder = '.local/acceptance-20260914/wire-bridge/title-canary';
const target = '803935036',
  allowed = [{ partnerId: '1232297', shopId: '227418363' }];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
try {
  const binding = (
    await pool.query(
      "SELECT * FROM sandbox_create_trial_items WHERE item_id=$1 AND state='verified' AND stage='done'",
      [target],
    )
  ).rows[0];
  if (!binding || !/^SBX-BULK-/.test(binding.source_key))
    throw new Error('TECHNICAL_BINDING_REQUIRED');
  const row = (await pool.query('SELECT * FROM connections WHERE id=$1', [binding.connection_id]))
    .rows[0];
  if (
    !row ||
    row.environment !== 'sandbox' ||
    row.partner_id !== '1232297' ||
    row.shop_id !== '227418363'
  )
    throw new Error('TEST_SCOPE_REQUIRED');
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? ''),
    owner = 'sandbox:1232297:227418363';
  const secrets = {
    ...(box.open(row.partner_key_ciphertext, owner) as any),
    ...(box.open(row.token_ciphertext, owner) as any),
  };
  const client = new SandboxPreparedTransport(
    {
      environment: 'sandbox',
      partnerId: row.partner_id,
      shopId: row.shop_id,
      partnerKey: secrets.partnerKey,
      accessToken: secrets.accessToken,
    },
    allowed,
  );
  const read = async () => {
    const item = await client.read('/api/v2/product/get_item_base_info', {
      item_id_list: target,
      need_tax_info: 'true',
      need_complaint_policy: 'true',
    });
    if (item.kind !== 'success') throw new Error('TEST_READ_FAILED');
    const items = item.response.item_list as any[];
    if (
      !Array.isArray(items) ||
      items.length !== 1 ||
      String(items[0].item_id) !== target ||
      items[0].item_sku !== binding.source_key ||
      items[0].item_status !== 'UNLIST' ||
      !String(items[0].item_name).startsWith('SANDBOX QA ')
    )
      throw new Error('TEST_TARGET_CHANGED');
    let models: any = { model: [], tier_variation: [] };
    const requestIds = [item.requestId];
    if (items[0].has_model === true) {
      const result = await client.read('/api/v2/product/get_model_list', { item_id: target });
      if (result.kind !== 'success') throw new Error('TEST_MODELS_READ_FAILED');
      models = result.response;
      requestIds.push(result.requestId);
    } else if (items[0].has_model !== false) throw new Error('TEST_MODELS_AMBIGUOUS');
    return { snapshot: { item: items[0], models }, requestIds };
  };
  await mkdir(folder, { recursive: true });
  let source: any;
  try {
    source = JSON.parse(await readFile(folder + '/intent.json', 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const before = await read(),
      title = 'SANDBOX QA WIRE 20260914 - kiem thu nhat ky API';
    const limits = await client.read('/api/v2/product/get_item_limit', {
      category_id: String(before.snapshot.item.category_id),
    });
    if (limits.kind !== 'success') throw new Error('TEST_LIMIT_UNVERIFIED');
    const range = limits.response.item_name_length_limit as any;
    if (!range || title.length < range.min_limit || title.length > range.max_limit)
      throw new Error('TEST_TITLE_LIMIT');
    source = {
      id: randomUUID(),
      observedAt: new Date().toISOString(),
      title,
      before,
      limits,
      connectionId: row.id,
      scope: {
        environment: 'sandbox',
        partnerId: row.partner_id,
        shopId: row.shop_id,
        connectionRevision: row.revision,
        capabilityRevision: row.capability_revision,
      },
    };
    await writeFile(folder + '/intent.json', JSON.stringify(source, null, 2), { flag: 'wx' });
  }
  const runner = new PreparedWireRunner(new Repository(pool), { allowedShops: allowed });
  const plan: Extract<PreparedWirePlan, { kind: 'ready' }> = {
    kind: 'ready',
    operation: 'update',
    steps: [
      {
        path: '/api/v2/product/update_item',
        method: 'POST',
        group: 'title',
        payload: { item_id: Number(target), item_name: source.title },
      },
    ],
  };
  const job = await runner.prepare({
    id: source.id,
    connectionId: source.connectionId,
    scope: source.scope,
    sourceKey: binding.source_key,
    sourceFingerprint: sha({
      title: source.title,
      before: normalizePreparedWireSnapshot(source.before.snapshot),
    }),
    plan,
  });
  let execution = job;
  if (process.argv.includes('--execute')) {
    if (job.state === 'prepared') {
      const current = await read();
      if (
        sha(normalizePreparedWireSnapshot(current.snapshot)) !==
        sha(normalizePreparedWireSnapshot(source.before.snapshot))
      )
        throw new Error('TEST_BASELINE_CHANGED');
    }
    execution = await runner.run(job.id);
  }
  const expected = structuredClone(source.before.snapshot);
  expected.item.item_name = source.title;
  const readback = await pollPreparedReadback({
    read: async () => {
      const value = await read();
      return { kind: 'success', response: value, requestId: value.requestIds.join(':') };
    },
    check: (value) => {
      const matched =
        sha(normalizePreparedWireSnapshot(expected)) ===
        sha(normalizePreparedWireSnapshot(value.snapshot));
      return { verified: matched, mismatchedPaths: matched ? [] : ['raw.snapshot'] };
    },
    delaysMs: [0, 1000, 3000],
    timeoutMs: 30000,
  });
  const after = readback.observations.at(-1)?.snapshot as Awaited<ReturnType<typeof read>>;
  const verified = execution.state === 'acknowledged' && readback.state === 'verified';
  const report = {
    mode: 'live-sandbox-single-title-patch',
    shopId: row.shop_id,
    itemId: target,
    operationId: job.id,
    observedAt: new Date().toISOString(),
    execution,
    readback,
    after,
    expected,
    verified,
    scope:
      'New title intent on previously verified technical UNLIST canary only. No Lamy, no create, no production writes.',
  };
  await writeFile(
    folder + '/readback-' + new Date().toISOString().replaceAll(':', '-') + '.json',
    JSON.stringify(report, null, 2),
    { flag: 'wx' },
  );
  await writeFile(folder + '/result.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      folder,
      operationId: job.id,
      itemId: target,
      state: execution.state,
      verified,
      readRequestIds: after.requestIds,
    }),
  );
} finally {
  await pool.end();
}
