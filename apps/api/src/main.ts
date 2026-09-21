import 'dotenv/config';
import { ConnectionMaintenance, startConnectionMaintenance } from './connection-maintenance.js';
import { Pool, Repository, BlobStore } from '@shopee/persistence';
import { createApp } from './app.js';
import { registerWebRoutes } from './web-routes.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  repo = new Repository(pool);
const app = await createApp(
  repo,
  new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
  (process.env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://127.0.0.1:4310').split(','),
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
