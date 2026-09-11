import 'dotenv/config';
import { Pool, migrate } from '@shopee/persistence';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
