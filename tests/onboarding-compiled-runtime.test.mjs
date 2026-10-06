import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('compiled worker dependencies load without source loaders or development conditions', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.TSX_TSCONFIG_PATH;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    await import('@shopee/persistence');
    await import('@shopee/gateway');
    await import('./apps/worker/dist/imports.js');
    await import('./apps/worker/dist/sandbox-create-trials.js');
    console.log('compiled graph ready');
  `], { cwd: resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /compiled graph ready/);
});
