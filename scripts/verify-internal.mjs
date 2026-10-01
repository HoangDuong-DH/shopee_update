import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readIsolated } from './internal-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `Usage: node scripts/verify-internal.mjs [--browser] [--dry-run]

Run from this script's repository root with Node 24 and isolated dependencies.
Requires internal-environment init, isolated PostgreSQL 5443 and migrations.
Checks: typecheck, repository skills, TS build, web build, legacy, unit/integration.
--browser  Also run ONLY internal-acceptance-intake.spec.ts with its own fixture servers.
--dry-run  Validate environment/dependencies and print check names; do not run checks or write reports.
--help     Show usage; no environment, database or application access.
Results: unique private .local/internal/verification/run-*/ directory.
Does not start/restart the live app, migrate, deploy or call real Shopee.
The fetch guard is not a firewall for other HTTP/socket transports.`;

export function parseArguments(args) {
  if (args.some(arg => !['--help', '--dry-run', '--browser'].includes(arg)) || new Set(args).size !== args.length)
    throw Error('INTERNAL_VERIFY_ARGUMENTS_INVALID');
  return { help: args.includes('--help'), dryRun: args.includes('--dry-run'), browser: args.includes('--browser') };
}

export function assertWorkingDirectory(cwd, projectRoot) {
  const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (normalize(cwd) !== normalize(projectRoot)) throw Error('INTERNAL_VERIFY_CWD_MUST_BE_REPOSITORY_ROOT');
}

export function verifierEnvironment(env, projectRoot, dotenvContents) {
  const database = new URL(env.DATABASE_URL);
  if (database.protocol !== 'postgres:' || database.hostname !== '127.0.0.1' || database.port !== '5443'
    || database.pathname !== '/shopee_internal_test' || database.username !== 'shopee_internal' || database.search || database.hash)
    throw Error('INTERNAL_VERIFY_DATABASE_TARGET_INVALID');
  if (env.INTERNAL_ISOLATED_MODE !== '1' || env.PRODUCTION_PILOT_ENABLED !== '0'
    || env.SHOPEE_PRODUCTION_WRITES !== 'false' || env.CONNECTION_MAINTENANCE_ENABLED !== '0'
    || env.DOTENV_CONFIG_PATH !== resolve(projectRoot, '.local/internal/empty.env') || env.DOTENV_CONFIG_OVERRIDE !== 'false')
    throw Error('INTERNAL_VERIFY_ENVIRONMENT_INVALID');
  if (dotenvContents.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#')))
    throw Error('INTERNAL_VERIFY_DOTENV_MUST_BE_EMPTY');
  // NODE_OPTIONS propagates the guard to child Node processes and test workers.
  // readIsolated supplies an allowlisted environment, never the caller's preloads or secrets.
  const preload = pathToFileURL(resolve(projectRoot, 'scripts/internal-network-guard.mjs')).href;
  return { ...env, NODE_OPTIONS: `--import=${preload}` };
}

export function buildCommands(output, browser = false) {
  const commands = [
    ['typecheck', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.check.json'],
    ['repository-skills', 'scripts/validate-repository-skills.mjs'],
    ['build-typescript', 'node_modules/typescript/bin/tsc', '-b'],
    ['build-web', 'node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'],
    ['legacy', '--test', 'tests/shared.test.js'],
    ['unit-integration', 'node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner',
      '--reporter=default', '--reporter=json', `--outputFile=${resolve(output, 'unit-integration.json')}`],
  ];
  if (browser) commands.push(['browser-intake', 'node_modules/@playwright/test/cli.js', 'test',
    'internal-acceptance-intake.spec.ts', '--config', resolve(output, 'playwright.config.cjs')]);
  return commands;
}

export function browserConfiguration(projectRoot, output) {
  // Deliberately do not inherit playwright.config.ts (its default points to live port 5173).
  // This exact test starts and closes its own fixture API/Vite using an isolated DB schema.
  return { testDir: resolve(projectRoot, 'tests/e2e'), testMatch: 'internal-acceptance-intake.spec.ts',
    fullyParallel: false, workers: 1, retries: 0, timeout: 30000,
    reporter: [['list'], ['json', { outputFile: resolve(output, 'browser-intake.json') }]],
    outputDir: resolve(output, 'browser-artifacts'),
    use: { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1050 },
      trace: 'retain-on-failure', screenshot: 'only-on-failure' } };
}

async function assertDependencies() {
  for (const [name, directory] of [['domain', 'domain'], ['persistence', 'persistence'], ['gateway', 'shopee'], ['agent-runtime', 'agent-runtime']]) {
    const actual = await realpath(resolve(root, 'node_modules/@shopee', name)).catch(() => null);
    const expected = await realpath(resolve(root, 'packages', directory));
    if (!actual || (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected))
      throw Error('INTERNAL_VERIFY_ISOLATED_DEPENDENCIES_REQUIRED');
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertWorkingDirectory(process.cwd(), root);
  if (options.help) { console.log(help); return; }
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('INTERNAL_VERIFY_NODE_24_REQUIRED');
  const { env: isolatedEnv } = await readIsolated(root);
  if (!(await lstat(isolatedEnv.DOTENV_CONFIG_PATH)).isFile()) throw Error('INTERNAL_VERIFY_DOTENV_MUST_BE_REGULAR_FILE');
  const env = verifierEnvironment(isolatedEnv, root, await readFile(isolatedEnv.DOTENV_CONFIG_PATH, 'utf8'));
  await assertDependencies();
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, checks: buildCommands(resolve(root, '.local/internal/verification/preview'), options.browser).map(([name]) => name),
      database: '127.0.0.1:5443/shopee_internal_test', externalFetch: 'blocked', productionWrites: false,
      browser: options.browser ? 'internal-acceptance-intake.spec.ts; own fixture servers' : 'not requested' }, null, 2));
    return;
  }
  const parent = resolve(root, '.local/internal/verification');
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink()) throw Error('INTERNAL_VERIFY_OUTPUT_MUST_NOT_BE_LINK');
  const output = await mkdtemp(resolve(parent, 'run-'));
  if (options.browser) await writeFile(resolve(output, 'playwright.config.cjs'),
    `module.exports = ${JSON.stringify(browserConfiguration(root, output), null, 2)};\n`, { flag: 'wx', mode: 0o600 });
  const results = [], startedAt = new Date().toISOString();
  for (const [name, ...args] of buildCommands(output, options.browser)) {
    console.log(`\nChecking ${name}`);
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    results.push({ name, exitCode: result.status, signal: result.signal, spawnError: result.error?.code ?? null, durationMs: Date.now() - started });
    // Save progress after each step, including the first failure. Never include environment/credentials.
    await writeFile(resolve(output, 'verification.json'), JSON.stringify({ startedAt, observedAt: new Date().toISOString(),
      environment: 'isolated-fixtures', browserRequested: options.browser, results }, null, 2), { mode: 0o600 });
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
  console.log(`Private verification reports: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Avoid leaking raw filesystem/connection error messages into terminal output.
    const code = typeof error?.message === 'string' && /^INTERNAL_VERIFY_[A-Z0-9_]+$/.test(error.message) ? error.message
      : typeof error?.message === 'string' && /^ISOLATED_[A-Z0-9_]+$/.test(error.message) ? error.message : 'INTERNAL_VERIFY_SETUP_FAILED';
    console.error(code); process.exitCode = 1;
  });
}
