import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { Pool, Repository, BlobStore } from '@shopee/persistence';
import { createApp } from './app.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  repo = new Repository(pool);
const app = await createApp(
  repo,
  new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
  (process.env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://127.0.0.1:4310').split(','),
);
const publicRoot = resolve('apps/web/dist');
app
  .getHttpAdapter()
  .getInstance()
  .get('/*', async (req, reply) => {
    const pathname = new URL(req.url, 'http://internal').pathname;
    const path = resolve(publicRoot, '.' + decodeURIComponent(pathname));
    if (!path.startsWith(publicRoot + sep) && path !== publicRoot) return reply.status(404).send();
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.html': 'text/html',
    };
    try {
      if (pathname.startsWith('/assets/'))
        return reply
          .type(mime[extname(path)] ?? 'application/octet-stream')
          .send(await readFile(path));
      return reply.type('text/html').send(await readFile(resolve(publicRoot, 'index.html')));
    } catch {
      return reply
        .status(404)
        .send({ message: 'Giao diện chưa được build. Dùng địa chỉ phát triển trên cổng 5173.' });
    }
  });
await app.listen(Number(process.env.API_PORT ?? 4310), process.env.API_HOST ?? '127.0.0.1');
console.log(`Internal API ready on port ${process.env.API_PORT ?? 4310}.`);
const close = async () => {
  await app.close();
  await pool.end();
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
