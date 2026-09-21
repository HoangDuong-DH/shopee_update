import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';

const operationId = '007738be-04ec-4ead-88d2-825062b29056';
const directory = resolve('.local/production-pilot-1423724897');
const audit = JSON.parse(await readFile(resolve(directory, 'row65-initial-source-audit.json'), 'utf8'));
if (audit.operationId !== operationId || audit.itemId !== '51267858328' || !audit.exactVariationPayload) throw Error('AUDIT_SCOPE_MISMATCH');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  let step: any;
  try {
    await client.query('BEGIN READ ONLY');
    step = (await client.query("SELECT s.payload,s.receipt,s.state FROM production_pilot_steps s JOIN production_pilot_operations o ON o.id=s.operation_id WHERE s.operation_id=$1 AND s.kind='variations' AND o.owner_key='production:2010476:1423724897' AND o.item_id='51267858328' AND o.source_revision=4", [operationId])).rows[0];
    await client.query('COMMIT');
  } finally { client.release(); }
  if (step?.state !== 'acknowledged') throw Error('AUDIT_INIT_UNACKNOWLEDGED');
  const requested = step.payload.standardise_tier_variation.map((tier: any) => ({ name: tier.variation_name, options: tier.variation_option_list.map((option: any) => ({ option: option.variation_option_name, imageId: option.image_id ?? null })) }));
  const observed = audit.rawTierVariation.map((tier: any) => ({ name: tier.name, options: tier.option_list.map((option: any) => ({ option: option.option, imageId: option.image?.image_id ?? null })) }));
  const output = { operationId, itemId: audit.itemId, sourceFingerprint: audit.sourceFingerprint, observedAt: audit.observedAt, sourceBoundPayloadAlreadyVerified: true, initRequestId: step.receipt.requestId, exactTierNamesOrderAndImages: canonicalJson(requested) === canonicalJson(observed), requested, observed, mutations: 0 };
  const path = resolve(directory, 'row65-initial-variant-image-audit.json');
  await writeFile(path, JSON.stringify(output, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ path, ...output }, null, 2));
} finally { await pool.end(); }
