import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerWebRoutes } from '../../apps/api/src/web-routes.js';

let server: FastifyInstance;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'web-route-test-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Internal listing app</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'window.appLoaded = true;');
  server = Fastify();
  server.get('/v1/status', async () => ({ worker: 'online' }));
  server.get('/health/live', async () => ({ status: 'ok' }));
  server.get('/health/ready', async () => ({ status: 'ready' }));
  registerWebRoutes(server, root);
});
afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});
describe('API and SPA fallback routing boundary', () => {
  it.each([
    '/v1',
    '/v1/missing-route',
    '/v1/missing-route?query=1',
    '/%76%31/missing-route',
    '/health',
    '/health/missing',
  ])('unknown service path %s stays a JSON 404', async (url) => {
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(response.body).not.toContain('<!doctype');
  });
  it.each(['/v1/status', '/health/live', '/health/ready'])(
    'known service route %s retains its response',
    async (url) => {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).not.toContain('<!doctype');
    },
  );
  it.each(['/', '/listing/saved', '/v10/guide'])(
    'client route %s still loads the SPA',
    async (url) => {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Internal listing app');
    },
  );
  it('keeps assets content and does not serve the SPA for a missing asset', async () => {
    const response = await server.inject({ method: 'GET', url: '/assets/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.body).toBe('window.appLoaded = true;');
    const missing = await server.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain('<!doctype');
  });
  it('does not resolve encoded traversal outside the public directory', async () => {
    const response = await server.inject({ method: 'GET', url: '/assets/..%2f..%2fprivate.txt' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<!doctype');
  });
});
