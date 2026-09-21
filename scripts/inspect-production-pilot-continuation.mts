import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, Repository } from '@shopee/persistence';
import { ProductionPilotService } from '../apps/api/src/production-pilot-service.js';
import { productionPilotSourceRoot } from '../apps/api/src/production-pilot-source.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL }), repo = new Repository(pool);
try {
  const status = await new ProductionPilotService(repo, { enabled: true }).status();
  const protectedRows = await pool.query(`SELECT row_to_json(o) AS operation,
    (SELECT json_agg(v ORDER BY v.id) FROM production_pilot_verifications v WHERE v.operation_id=o.id) AS verifications,
    (SELECT json_agg(s ORDER BY s.id) FROM production_pilot_steps s WHERE s.operation_id=o.id) AS steps,
    (SELECT json_agg(p ORDER BY p.id) FROM production_pilot_publications p WHERE p.create_operation_id=o.id) AS publications
    FROM production_pilot_operations o WHERE o.id='ec195c1c-b2e1-44d9-a866-e14a39988a9b'`);
  const row2Hash = createHash('sha256').update(JSON.stringify(protectedRows.rows)).digest('hex');
  const file = resolve(productionPilotSourceRoot, 'continuation-inspection-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify({ observedAt: new Date().toISOString(), row2Hash, status }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ file, row2Hash, phase: status.phase, canStart: status.canStart,
    remainingCount: status.remainingCount, continuationKey: status.continuationKey, sourceReceiptSha256: status.sourceReceiptSha256,
    startBlockedCode: status.startBlockedCode, listings: status.listings.map((l: any) => ({sourceKey:l.sourceKey,state:l.state,itemId:l.itemId,publicationState:l.publicationState})) }));
} finally { await pool.end(); }
