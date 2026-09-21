import 'dotenv/config';
import { Pool, Repository } from '@shopee/persistence';
import { collectProductionPilotInput } from '../apps/api/src/production-pilot-source.js';
// GET-only. No journal permit, media upload, product write, or production switch.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await collectProductionPilotInput(new Repository(pool), 'row-2');
  console.log(JSON.stringify({ preflightId: result.preflightId, sourceKey: result.sourceKey,
    inventoryCount: result.inventoryCount, duplicateMatches: result.duplicateMatches,
    expiresAt: result.input.metadata.expiresAt, mutations: result.mutations }));
} catch (error) {
  const code = error instanceof Error && /^PRODUCTION_PILOT_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREFLIGHT_FAILED';
  console.log(JSON.stringify({ code, mutations: 0 })); process.exitCode = 1;
} finally { await pool.end(); }
