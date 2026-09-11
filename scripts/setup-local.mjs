import { mkdir, access, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('.local/data', { recursive: true });
try {
  await access('.env');
  console.log('Existing .env preserved.');
} catch {
  const password = randomBytes(24).toString('hex');
  const encryptionKey = randomBytes(32).toString('hex');
  await writeFile(
    '.env',
    [
      `DATABASE_URL=postgres://shopee:${password}@127.0.0.1:5442/shopee_uploader`,
      'API_HOST=127.0.0.1',
      'API_PORT=4310',
      'WEB_PORT=5173',
      'DATA_ROOT=.local/data',
      'ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4310',
      'SHOPEE_PRODUCTION_WRITES=false',
      `APP_ENCRYPTION_KEY=${encryptionKey}`,
      '',
    ].join('\n'),
    { flag: 'wx' },
  );
  await writeFile('.local/docker.env', `POSTGRES_PASSWORD=${password}\n`, { flag: 'wx' });
  console.log('Local configuration created. Secrets were not printed.');
}
