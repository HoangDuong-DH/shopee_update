import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const commands = [
  ['typecheck', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.check.json'],
  ['build-typescript', 'node_modules/typescript/bin/tsc', '-b'],
  ['build-web', 'node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'],
  ['legacy', '--test', 'tests/shared.test.js'],
  [
    'unit-integration',
    'node_modules/vitest/vitest.mjs',
    'run',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=.local/test-results.json',
  ],
];
const results = [];
await mkdir('.local', { recursive: true });
for (const [name, ...args] of commands) {
  const start = Date.now();
  console.log('\nChecking ' + name);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  results.push({ name, exitCode: r.status, durationMs: Date.now() - start });
  if (r.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
await writeFile(
  '.local/verification.json',
  JSON.stringify({ observedAt: new Date().toISOString(), results }, null, 2),
);
