import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from '../packages/persistence/src/index.js';
import { SecretBox } from '../packages/shopee/src/secret-box.js';
import { SandboxPreparedTransport } from '../packages/shopee/src/prepared-transport.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const output = join(
  '.local/acceptance-20260914/wire-bridge',
  new Date().toISOString().replaceAll(':', '-'),
);
try {
  const row = (
    await pool.query(
      "SELECT * FROM connections WHERE environment='sandbox' AND partner_id='1232297' AND shop_id='227418363'",
    )
  ).rows[0];
  if (!row || row.state !== 'connected') throw new Error('TEST_CONNECTION_REQUIRED');
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? ''),
    owner = 'sandbox:1232297:227418363';
  const secrets = {
    ...(box.open(row.partner_key_ciphertext, owner) as any),
    ...(box.open(row.token_ciphertext, owner) as any),
  };
  const envelopeShapes: any[] = [];
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init),
      path = new URL(String(input)).pathname;
    const raw = await response
      .clone()
      .json()
      .catch(() => null);
    envelopeShapes.push({
      path,
      status: response.status,
      keys: raw && typeof raw === 'object' ? Object.keys(raw) : null,
      errorType: typeof raw?.error,
      requestIdType: typeof raw?.request_id,
      requestIdLength: typeof raw?.request_id === 'string' ? raw.request_id.length : null,
      responseType: Array.isArray(raw?.response) ? 'array' : typeof raw?.response,
    });
    return response;
  };
  const transport = new SandboxPreparedTransport(
    {
      environment: 'sandbox',
      partnerId: row.partner_id,
      shopId: row.shop_id,
      partnerKey: secrets.partnerKey,
      accessToken: secrets.accessToken,
    },
    [{ partnerId: '1232297', shopId: '227418363' }],
    observedFetch,
  );
  const results: any[] = [];
  for (const [path, params] of [
    ['/api/v2/shop/get_shop_info', {}],
    ['/api/v2/product/get_item_limit', { category_id: '301378' }],
    ['/api/v2/product/get_attribute_tree', { category_id_list: '301378', language: 'en' }],
    [
      '/api/v2/product/get_brand_list',
      { category_id: '301378', offset: '0', page_size: '100', status: '1' },
    ],
    ['/api/v2/logistics/get_channel_list', {}],
  ] as [string, Record<string, string>][]) {
    const result = await transport.read(path, params);
    results.push({ path, params, result, observedAt: new Date().toISOString() });
    if (result.kind !== 'success') break;
  }
  await mkdir(output, { recursive: true });
  const report = {
    observedAt: new Date().toISOString(),
    mode: 'live-sandbox-readonly',
    connectionId: row.id,
    connectionRevision: row.revision,
    capabilityRevision: row.capability_revision,
    shopId: row.shop_id,
    results,
    envelopeShapes,
    mutations: 0,
  };
  await writeFile(join(output, 'readonly-probe.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      output,
      connectionRevision: row.revision,
      requests: results.map((r) => ({
        path: r.path,
        kind: r.result.kind,
        code: r.result.code ?? null,
        requestId: r.result.requestId ?? null,
      })),
      mutations: 0,
    }),
  );
} finally {
  await pool.end();
}
