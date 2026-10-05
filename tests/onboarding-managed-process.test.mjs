import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processInfo } from '../scripts/local-launcher.mjs';
test('managed process authenticates over local IPC and rejects a different launcher token', async () => {
  const token = randomBytes(32).toString('hex');
  const pipe = process.platform === 'win32' ? ['', '', '.', 'pipe', 'listing-test-' + token.slice(0, 32)].join(String.fromCharCode(92)) : '/tmp/listing-test-' + token.slice(0, 16) + '.sock';
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/managed-process.mjs')).href, '-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', env: { ...process.env, LISTINGSTUDIO_LAUNCH_PIPE: pipe, LISTINGSTUDIO_LAUNCH_TOKEN: token } });
  try {
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    let actual;
    for (let index = 0; index < 20; index++) { try { actual = await processInfo({pid:child.pid,pipe,token}); } catch {} if (actual) break; await new Promise(done=>setTimeout(done,100)); }
    assert.equal(actual?.pid, child.pid); assert.equal(actual.executable, process.execPath); assert.ok(actual.startedAt);
    await assert.rejects(processInfo({pid:child.pid,pipe,token:'b'.repeat(64)}), /ownership channel/);
  } finally { child.kill(); await new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); }); }
});
