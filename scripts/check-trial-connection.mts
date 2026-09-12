import 'dotenv/config';
import { Pool } from '@shopee/persistence';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const records = (
    await pool.query(
      "SELECT id,revision,state,environment,partner_id,shop_id,expires_at FROM connections WHERE environment='sandbox' AND partner_id='1232297' AND shop_id='227418363'",
    )
  ).rows;
  console.log(JSON.stringify(records));
} finally {
  await pool.end();
}
