import 'dotenv/config';
import { transferRecoveryRequired, installRecoveryFetchGuard } from '@shopee/persistence';
const transferReadOnly = transferRecoveryRequired();
if (transferReadOnly) {
  process.env.LISTINGSTUDIO_TRANSFER_READ_ONLY = '1';
  process.env.PRODUCTION_PILOT_ENABLED = '0';
  process.env.SHOPEE_PRODUCTION_WRITES = 'false';
  process.env.CONNECTION_MAINTENANCE_ENABLED = '0';
  installRecoveryFetchGuard();
}
import { ConnectionMaintenance, startConnectionMaintenance } from './connection-maintenance.js';
import { Pool, Repository, BlobStore, runtimePoolConfig } from '@shopee/persistence';
import { createApp } from './app.js';
import { registerWebRoutes } from './web-routes.js';
const pool = new Pool(runtimePoolConfig()),
  repo = new Repository(pool);
const app = await createApp(
  repo,
  new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
  (process.env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://127.0.0.1:4310').split(','),
  { transferReadOnly },
);
registerWebRoutes(app.getHttpAdapter().getInstance());
await app.listen(Number(process.env.API_PORT ?? 4310), process.env.API_HOST ?? '127.0.0.1');
console.log(`Internal API ready on port ${process.env.API_PORT ?? 4310}.`);
const stopMaintenance=startConnectionMaintenance(new ConnectionMaintenance(repo));
const close = async () => {
  await stopMaintenance();
  await app.close();
  await pool.end();
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
