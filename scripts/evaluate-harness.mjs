import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
await mkdir('.local', { recursive: true });
await rm('.local/harness-test-results.json', { force: true });
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/unit/harness.test.ts',
    'tests/unit/management-harness.test.ts',
    'tests/unit/knowledge.test.ts',
    'tests/integration/assistant.test.ts',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=.local/harness-test-results.json',
  ],
  { stdio: 'inherit', windowsHide: true },
);
let counts = null;
try {
  const output = JSON.parse(await readFile('.local/harness-test-results.json', 'utf8'));
  counts = {
    total: output.numTotalTests,
    passed: output.numPassedTests,
    failed: output.numFailedTests,
  };
} catch {}
await writeFile(
  '.local/harness-evaluation.json',
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      mode: 'deterministic_harness_fixtures',
      modelConfigured: false,
      modelAccuracy: 'not_measured',
      shopeeRequests: 0,
      exitCode: result.status,
      counts,
    },
    null,
    2,
  ),
);
process.exitCode = result.status === 0 ? 0 : 1;
