import 'dotenv/config';
import { resolve } from 'node:path';
import { Pool, Repository } from '@shopee/persistence';
import { ProductionPilotRunner } from '../apps/api/src/production-pilot-runner.js';
import { collectProductionPilotInput, loadProductionPilotSource, productionPilotSourceRoot } from '../apps/api/src/production-pilot-source.js';
// Read-only readiness inspection for the already-authorized remaining source. No prepare/run/publish.
const pool = new Pool({ connectionString: process.env.DATABASE_URL }), repo = new Repository(pool);
try {
  const loaded = await loadProductionPilotSource();
  const runner = new ProductionPilotRunner(repo, {
    allowedSources: loaded.value.listings.map((s: any) => ({ sourceIdentity: s.sourceIdentity, sourceRevision: s.sourceRevision })),
    assetRoot: resolve(productionPilotSourceRoot, 'assets'), evidenceRoot: resolve(productionPilotSourceRoot, 'wire-evidence'),
  });
  const connection = (await pool.query("SELECT revision,expires_at FROM connections WHERE environment='production' AND partner_id='2010476' AND shop_id='1423724897'")).rows[0];
  const evidence = await runner.capabilityEvidenceFromVerified('ec195c1c-b2e1-44d9-a866-e14a39988a9b', connection.revision, new Date().toISOString(), ['verified-row-2-create']);
  const result = await collectProductionPilotInput(repo, 'row-65', { allowExistingListings: true, priorCapabilityEvidence: evidence });
  console.log(JSON.stringify({ sourceKey: 'row-65', preflightId: result.preflightId, sourceReceiptSha256: result.sourceReceiptSha256,
    issues: result.input.issues, metadata: result.input.metadata, connectionExpiresAt: connection.expires_at, writes: 0 }));
} finally { await pool.end(); }
