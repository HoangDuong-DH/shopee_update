import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';

export function registerWebRoutes(server: FastifyInstance, publicRoot = resolve('apps/web/dist')) {
  const root = resolve(publicRoot);
  server.get('/*', async (req, reply) => {
    const notFound = () =>
      reply.status(404).type('application/json').send({
        code: 'NOT_FOUND',
        message: 'Không tìm thấy đường dẫn dịch vụ được yêu cầu.',
      });
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://internal').pathname);
    } catch {
      return notFound();
    }
    // Concrete API/health routes win before this wildcard. Misspelled service paths
    // must stay JSON errors instead of looking like a successful SPA response.
    if (
      pathname === '/v1' ||
      pathname.startsWith('/v1/') ||
      pathname === '/health' ||
      pathname.startsWith('/health/')
    )
      return notFound();
    const path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + sep) && path !== root) return notFound();
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.html': 'text/html',
    };
    try {
      if (pathname.startsWith('/assets/')) {
        const bytes = await readFile(path);
        return reply.type(mime[extname(path)] ?? 'application/octet-stream').send(bytes);
      }
      const html = await readFile(resolve(root, 'index.html'));
      return reply.type('text/html').send(html);
    } catch {
      return reply.status(404).type('application/json').send({
        code: 'NOT_FOUND',
        message:
          'Giao diện chưa được build hoặc tệp giao diện không tồn tại. Dùng địa chỉ phát triển trên cổng 5173.',
      });
    }
  });
}
