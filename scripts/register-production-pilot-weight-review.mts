import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { productionPilotSourceRoot } from '../apps/api/src/production-pilot-source.js';
const operationId = '007738be-04ec-4ead-88d2-825062b29056', itemId = '51267858328';
const accepted = { VTTDNLT300: { source: 322.3, accepted: 322 }, VTTDNLT100: { source: 130.9, accepted: 131 }, VTTDNLT500: { source: 503.8, accepted: 504 } };
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const op = (await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1', [operationId])).rows[0];
  if (!op || op.owner_key !== 'production:2010476:1423724897' || op.item_id !== itemId || op.state !== 'acknowledged') throw Error('WEIGHT_REVIEW_SCOPE_CHANGED');
  const doc = op.source_payload.document;
  if (doc.models.length !== 3 || doc.sourceKey !== 'fd983d71-dbe4-4980-a3d6-d2f90d9f117c:row-65') throw Error('WEIGHT_REVIEW_SOURCE_CHANGED');
  const evidence = [] as any[];
  const reads = [] as any[];
  for (const name of ['read-1.json', 'read-2.json']) {
    const file = resolve(productionPilotSourceRoot, 'created-read-589e89ee-2ad5-41e2-abf1-5b41e09bb133', name);
    const bytes = await readFile(file), raw = JSON.parse(bytes.toString());
    if (raw.operationId !== operationId || raw.itemId !== itemId || raw.base.kind !== 'success' || raw.models.kind !== 'success') throw Error('WEIGHT_REVIEW_EVIDENCE_CHANGED');
    reads.push(raw.models.response.model);
    evidence.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), observedAt: raw.observedAt,
      requestIds: [raw.base.requestId, raw.models.requestId] });
  }
  const models = doc.models.map((model: any) => {
    const decision = accepted[model.sku as keyof typeof accepted];
    if (!decision || model.weightGrams !== decision.source) throw Error('WEIGHT_REVIEW_SOURCE_CHANGED');
    const rows = reads.map((read: any[]) => read.filter((r: any) => r.model_sku === model.sku));
    if (rows.some((r: any[]) => r.length !== 1) || rows[0][0].model_id !== rows[1][0].model_id ||
      rows.some((r: any[]) => Number(r[0].weight) !== decision.accepted / 1000 || JSON.stringify(r[0].tier_index) !== JSON.stringify(model.tierIndex))) throw Error('WEIGHT_REVIEW_OBSERVED_CHANGED');
    return { modelId: String(rows[0][0].model_id), sku: model.sku, tierIndex: model.tierIndex, sourceGrams: decision.source, acceptedGrams: decision.accepted };
  });
  const now = new Date();
  const record = { version: 1, scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' }, operationId, itemId,
    sourceFingerprint: op.source_fingerprint, sourceKey: doc.sourceKey,
    authorizationReference: 'User 2026-09-15 explicitly confirmed: Chấp nhận các mức Shopee đã làm tròn; 300ml=322g, 100ml=131g, 500ml=504g for this pilot listing only. Original workbook/source/payload remain unchanged.',
    authorizedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), models };
  const directory = resolve(productionPilotSourceRoot, 'weight-reviews'); await mkdir(directory, { recursive: true });
  const file = resolve(directory, operationId + '.json'), bytes = JSON.stringify(record, null, 2);
  await writeFile(file, bytes, { flag: 'wx' });
  await writeFile(resolve(directory, operationId + '.evidence.json'), JSON.stringify({ evidence, originalSourcePreserved: true, externalWrites: 0 }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ file, sha256: createHash('sha256').update(bytes).digest('hex'), models, externalWrites: 0 }));
} finally { await pool.end(); }
