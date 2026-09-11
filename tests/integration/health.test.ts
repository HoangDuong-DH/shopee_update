import { expect, it } from 'vitest';
import request from 'supertest';
import { createHealthApp } from '../../apps/api/src/health.js';
it('reports not ready when storage is unavailable without exposing the DB error', async () => {
  const app = await createHealthApp(async () => {
    throw new Error('password-secret database unavailable');
  });
  try {
    expect((await request(app.getHttpServer()).get('/health/live')).status).toBe(200);
    const result = await request(app.getHttpServer()).get('/health/ready');
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ status: 'not_ready' });
    expect(JSON.stringify(result.body)).not.toContain('password-secret');
  } finally {
    await app.close();
  }
});
