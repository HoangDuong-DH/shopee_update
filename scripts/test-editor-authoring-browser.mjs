import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readIsolated } from './internal-environment.mjs';
import { verifierEnvironment } from './verify-internal.mjs';

// Component fixtures only. No application API proxy, DB fixture, or external requests.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (resolve(process.cwd()) !== root) throw Error('EDITOR_FIXTURE_CWD_INVALID');
const options = process.argv.slice(2);
if (options.some(option => option !== '--authorization-recovery')) throw Error('EDITOR_FIXTURE_OPTION_INVALID');
const authorizationRecovery = options.includes('--authorization-recovery');
const { env } = await readIsolated();
const safeEnv = verifierEnvironment(env, root, await readFile(env.DOTENV_CONFIG_PATH, 'utf8'));
const outputParent = resolve(root, authorizationRecovery ? 'output/playwright/authorization-recovery' : 'output/playwright/editor-authoring');
await mkdir(outputParent, { recursive: true });
const output = await mkdtemp(resolve(outputParent, 'run-'));
const fixtureModule = '/@fs/' + resolve(root, 'tests/e2e/fixtures/editor-authoring.tsx').replaceAll('\\', '/');
const server = await createServer({ configFile: false, root: resolve(root, 'apps/web'), plugins: [react()], appType: 'custom', logLevel: 'error',
  cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [root] }, proxy: {} } });
server.middlewares.use(async (request, response, next) => {
  if (request.url?.startsWith('/frontend-fixture')) {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml(request.url, `<!doctype html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Editor component fixture</title></head><body><div id="root"></div><script type="module" src="${fixtureModule}"></script></body></html>`));
  } else next();
});
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || [4310, 4430, 5173, 5273].includes(address.port)) throw Error('EDITOR_FIXTURE_PORT_INVALID');
  const baseURL = 'http://127.0.0.1:' + address.port;
  const configPath = resolve(output, 'playwright.config.cjs');
  await writeFile(configPath, `module.exports=${JSON.stringify({ metadata: { editorAuthoringFixture: true, authorizationRecoveryFixture: authorizationRecovery }, testDir: resolve(root, 'tests/e2e'), testMatch: authorizationRecovery ? 'production-authorization-recovery-components.spec.ts' : 'editor-authoring-components.spec.ts', workers: 1, fullyParallel: false, timeout: 30000,
    reporter: [['list'], ['json', { outputFile: resolve(output, 'results.json') }]], outputDir: resolve(output, 'artifacts'),
    use: { baseURL, channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' } }, null, 2)};\n`);
  console.log(JSON.stringify({ scope: 'component fixtures only', baseURL, output, productionWrites: false, externalRequests: 'blocked by browser route', database: 'unused' }));
  const result = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', configPath], { cwd: root, env: safeEnv, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('close', code => resolveExit(code ?? 1));
  });
  process.exitCode = result;
} finally { await server.close(); }
