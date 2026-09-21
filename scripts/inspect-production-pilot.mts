import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { SecretBox, signRequest } from '@shopee/gateway';

// Read-only inspection of the explicitly authorized production pilot. No generic URL or POST interface.
const partnerId = '2010476', shopId = '1423724897', connectionId = '2bb497e4-a306-4b1e-85ba-5ee7a814fdaf';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const output = resolve('.local/production-pilot-1423724897', 'read-' + randomUUID());
let stage = 'connection';
try {
  const row = (await pool.query(`SELECT * FROM connections WHERE id=$1 AND environment='production'
    AND partner_id=$2 AND shop_id=$3 AND state='connected'`, [connectionId, partnerId, shopId])).rows[0];
  if (!row || row.revision !== 1 || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) throw new Error('CONNECTION_NOT_READY');
  stage = 'credentials';
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? ''), scope = `production:${partnerId}:${shopId}`;
  const { partnerKey } = box.open(row.partner_key_ciphertext, scope) as { partnerKey: string };
  const { accessToken } = box.open(row.token_ciphertext, scope) as { accessToken: string };
  if (!partnerKey || !accessToken) throw new Error('CREDENTIALS_UNAVAILABLE');
  await mkdir(output, { recursive: true });
  const reads = [
    { name: 'shop-info', path: '/api/v2/shop/get_shop_info', query: {} },
    { name: 'item-limit', path: '/api/v2/product/get_item_limit', query: {} },
    { name: 'items-normal', path: '/api/v2/product/get_item_list', query: { offset: '0', page_size: '100', item_status: 'NORMAL' } },
    { name: 'items-unlist', path: '/api/v2/product/get_item_list', query: { offset: '0', page_size: '100', item_status: 'UNLIST' } },
  ];
  const summaries: unknown[] = [];
  for (const read of reads) {
    stage = read.name;
    const timestamp = Math.floor(Date.now() / 1000), url = new URL(read.path, 'https://partner.shopeemobile.com');
    const sign = signRequest({ partnerId, shopId, partnerKey, accessToken, path: read.path, timestamp });
    for (const [key,value] of Object.entries({ ...read.query, partner_id: partnerId, shop_id: shopId, access_token: accessToken, timestamp: String(timestamp), sign }))
      if (value !== undefined) url.searchParams.set(key, value);
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
    const safe = raw.replaceAll(partnerKey, '[REDACTED]').replaceAll(accessToken, '[REDACTED]').replaceAll(sign, '[REDACTED]');
    const body = JSON.parse(safe);
    await writeFile(resolve(output, read.name + '.json'), JSON.stringify({ observedAt: new Date().toISOString(),
      scope: { partnerId, shopId, connectionId, revision: row.revision }, endpoint: read.path, method: 'GET', query: read.query,
      status: response.status, body }, null, 2));
    const summary = { name: read.name, status: response.status, error: typeof body.error === 'string' ? body.error : 'missing_error',
      requestId: body.request_id, fields: Object.keys(body.response ?? body), totalCount: body.response?.total_count,
      hasNextPage: body.response?.has_next_page, shopName: body.shop_name, region: body.region };
    summaries.push(summary);
    if (!response.ok || body.error !== '') break;
  }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ output, readOnly: true, summaries }, null, 2));
  console.log(JSON.stringify({ output, readOnly: true, summaries }));
} catch (error) {
  const code = (error as any)?.cause?.code ?? (error as any)?.code ?? ((error as Error)?.message === 'CONNECTION_NOT_READY' ? 'CONNECTION_NOT_READY' : 'READ_FAILED');
  console.error(JSON.stringify({ stage, code: /^[A-Z_0-9]+$/.test(String(code)) ? code : 'READ_FAILED', readOnly: true }));
  process.exitCode = 1;
} finally { await pool.end(); }
