import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const logs = resolve(root, '.local/launcher');
mkdirSync(logs, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(path) {
  try { const r = await fetch('http://127.0.0.1:4310' + path, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
function start(name, file, config) {
  const out = openSync(resolve(logs, name + '.stdout.log'), 'a');
  const err = openSync(resolve(logs, name + '.stderr.log'), 'a');
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', file], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    env: { ...process.env, PRODUCTION_PILOT_ENABLED: '1', TSX_TSCONFIG_PATH: resolve(config) },
  });
  closeSync(out); closeSync(err);
  child.on('error', () => console.error('Khong mo duoc ' + name + '. Xem .local/launcher.'));
  child.unref();
  return child.pid;
}
try {
  if (!existsSync('.env') || !existsSync('apps/web/dist/index.html')) throw Error('Thieu cau hinh hoac ban giao dien da build. Khong chay setup lai; nho nguoi phu trach kiem tra.');
  console.log('1/3 Kiem tra Docker va co so du lieu...');
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  if (docker.status !== 0) throw Error('Mo Docker Desktop tu Start, doi Engine running, roi bam lai MO_WEB_APP.cmd.');
  const database = spawnSync('docker', ['compose', '--env-file', '.local/docker.env', '-f', 'infra/local/compose.yaml', 'up', '-d', 'postgres'], { windowsHide: true, encoding: 'utf8', timeout: 45000 });
  if (database.status !== 0) throw Error('Chua khoi dong duoc PostgreSQL. Mo Docker Desktop de kiem tra container shopee-product-uploader-dev-postgres-1.');
  console.log('2/3 Khoi dong ung dung va bo doc file...');
  const runtime = { at: new Date().toISOString(), url: 'http://127.0.0.1:4310/' };
  let status = await json('/v1/status');
  if (status?.mode !== 'internal') {
    // If the port is occupied, do not spawn a competing API process.
    try { await fetch(runtime.url, { signal: AbortSignal.timeout(1000) }); throw Error('Cong 4310 dang duoc dung. Khong khoi dong trung; nho nguoi phu trach kiem tra.'); }
    catch (error) { if (error instanceof Error && error.message.startsWith('Cong 4310')) throw error; }
    runtime.apiPid = start('api', 'apps/api/src/main.ts', 'apps/api/tsconfig.json');
  }
  for (let i = 0; i < 40; i++) {
    const ready = await json('/health/ready'); status = await json('/v1/status');
    if (ready?.status === 'ready' && status?.mode === 'internal') break;
    if (i === 39) throw Error('API chua san sang. Xem .local/launcher/api.stderr.log; khong bam dang lai.');
    await sleep(1000);
  }
  if (status?.worker !== 'online') runtime.workerPid = start('worker', 'apps/worker/src/main.ts', 'apps/worker/tsconfig.json');
  for (let i = 0; i < 20; i++) {
    status = await json('/v1/status');
    if (status?.worker === 'online') break;
    if (i === 19) throw Error('Bo doc file chua san sang. Xem .local/launcher/worker.stderr.log.');
    await sleep(1000);
  }
  writeFileSync(resolve(logs, 'runtime.json'), JSON.stringify(runtime, null, 2));
  console.log('3/3 San sang: ' + runtime.url);
  console.log('Day la ban giao dien da build. Khong tu dong dang san pham.');
  if (!process.argv.includes('--no-browser')) {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', runtime.url], { detached: true, stdio: 'ignore', windowsHide: true });
    browser.unref();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
