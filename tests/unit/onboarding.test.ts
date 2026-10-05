import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
const checkout = process.cwd();

afterEach(async () => {
  for (const root of directories.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('shopee-onboarding-test-'))
      throw Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shopee-onboarding-test-'));
  directories.push(root);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.local'));
  for (const name of ['setup-local.mjs', 'onboarding-core.mjs']) {
    const source = await readFile(join(checkout, 'scripts', name)).catch(() => null);
    if (source) await writeFile(join(root, 'scripts', name), source);
  }
  return root;
}

describe('local setup preservation', () => {
  it('refuses an orphan Docker password before creating an app configuration', async () => {
    const root = await fixture();
    await writeFile(join(root, '.local/docker.env'), 'POSTGRES_PASSWORD=orphan-secret\n');
    const child = spawnSync(process.execPath, [join(root, 'scripts/setup-local.mjs')], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(child.status).toBe(1);
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
    expect(await readFile(join(root, '.local/docker.env'), 'utf8')).toBe('POSTGRES_PASSWORD=orphan-secret\n');
    expect(child.stdout + child.stderr).not.toContain('orphan-secret');
  });
});

describe('configuration-only setup', () => {
  it('refuses an incomplete app configuration without changing its contents', async () => {
    const root = await fixture();
    await writeFile(join(root, '.env'), 'APP_ENCRYPTION_KEY=existing-private-key\n');
    const child = spawnSync(process.execPath, [join(root, 'scripts/setup-local.mjs')], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(child.status).toBe(1);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('APP_ENCRYPTION_KEY=existing-private-key\n');
    expect(child.stdout + child.stderr).not.toContain('existing-private-key');
  });

  it('preserves an existing configuration pair without rewriting or reading secrets into output', async () => {
    const root = await fixture();
    await writeFile(join(root, '.env'), 'existing-private-app\n');
    await writeFile(join(root, '.local/docker.env'), 'existing-private-docker\n');
    const child = spawnSync(process.execPath, [join(root, 'scripts/setup-local.mjs')], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(child.status).toBe(0);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('existing-private-app\n');
    expect(await readFile(join(root, '.local/docker.env'), 'utf8')).toBe('existing-private-docker\n');
    expect(child.stdout + child.stderr).not.toContain('existing-private');
  });

  it('creates loopback configuration with every production and maintenance switch disabled', async () => {
    const root = await fixture();
    const child = spawnSync(process.execPath, [join(root, 'scripts/setup-local.mjs')], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(child.status).toBe(0);
    const env = await readFile(join(root, '.env'), 'utf8');
    expect(env).toContain('PRODUCTION_PILOT_ENABLED=0\n');
    expect(env).toContain('CONNECTION_MAINTENANCE_ENABLED=0\n');
    expect(env).toContain('SHOPEE_PRODUCTION_WRITES=false\n');
    expect(env).toContain('PUBLIC_API_ORIGIN=http://127.0.0.1:4310\n');
    expect(env).toContain('WEB_ORIGIN=http://127.0.0.1:5173\n');
    const key = env.match(/^APP_ENCRYPTION_KEY=(.+)$/m)![1];
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(child.stdout + child.stderr).not.toContain(key);
  });
});

async function core() {
  const modulePath = '../../scripts/onboarding-core.mjs';
  const module = await import(modulePath) as any;
  expect(module.inspectOnboarding, 'read-only onboarding inspection is required').toBeTypeOf('function');
  return module;
}

async function bootstrapFixture() {
  const root = await fixture();
  const manifest = { name: 'fresh-fixture', version: '0.1.0', engines: { node: '>=24.20.0 <25' },
    workspaces: ['packages/*'], dependencies: { 'fixture-dep': '1.0.0' },
    scripts: { 'db:migrate': 'node scripts/migrate.mts', build: 'fixture-build' } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    '': manifest, 'node_modules/fixture-dep': { version: '1.0.0', integrity: 'sha512-fixture' },
    'packages/persistence': { name: '@shopee/persistence', version: '0.1.0' },
    'node_modules/@shopee/persistence': { resolved: 'packages/persistence', link: true },
  } };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await mkdir(join(root, 'infra/local'), { recursive: true });
  await writeFile(join(root, 'infra/local/compose.yaml'), 'fixture compose source\n');
  await mkdir(join(root, 'packages/persistence/migrations'), { recursive: true });
  await writeFile(join(root, 'packages/persistence/package.json'), JSON.stringify(lock.packages['packages/persistence']));
  await writeFile(join(root, 'packages/persistence/migrations/001.sql'), 'CREATE TABLE fixture (id int);\n');
  return root;
}

async function installFixtureDependencies(root: string, linkTarget = join(root, 'packages/persistence')) {
  const { symlink } = await import('node:fs/promises');
  await mkdir(join(root, 'node_modules/fixture-dep'), { recursive: true });
  await writeFile(join(root, 'node_modules/fixture-dep/package.json'), '{"name":"fixture-dep","version":"1.0.0"}');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  delete lock.packages[''];
  await writeFile(join(root, 'node_modules/.package-lock.json'), JSON.stringify(lock));
  await mkdir(join(root, 'node_modules/@shopee'), { recursive: true });
  await symlink(linkTarget, join(root, 'node_modules/@shopee/persistence'), 'junction');
}

function inspectionAdapters(overrides: any = {}) {
  return { nodeVersion: '24.20.0', npmCli: '/fixture/npm-cli.js',
    portAvailable: async () => true,
    run: async (request: any) => {
      if (request.args.includes('--version')) return { exitCode: 0, stdout: '11.11.0\n' };
      if (request.args[0] === 'info') return { exitCode: 0, stdout: 'linux\n' };
      if (request.args[0] === 'version') return { exitCode: 0, stdout: '28.0.0\n' };
      if (request.args[0] === 'compose' && request.args[1] === 'version') return { exitCode: 0, stdout: '2.39.0\n' };
      if (request.args[0] === 'volume' && request.args[1] === 'ls') return { exitCode: 0, stdout: '' };
      if (request.args[0] === 'ps') return { exitCode: 0, stdout: '' };
      throw Error('Unexpected external operation in inspection');
    }, ...overrides };
}

describe('read-only fresh-machine plan', () => {
  it('accepts a clean checkout before dependencies are installed and performs no mutation', async () => {
    const root = await bootstrapFixture(); const m = await core();
    const plan = await m.inspectOnboarding(root, {}, inspectionAdapters());
    expect(plan.ready).toBe(true);
    expect(plan.mode).toBe('plan');
    expect(plan.configuration).toBe('fresh');
    expect(plan.ports).toEqual({ apiPort: 4310, webPort: 5173, databasePort: 5442 });
    expect(plan.checks.find((c: any) => c.id === 'dependencies').status).toBe('pending');
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
    expect(await readFile(join(root, '.local/onboarding/receipt.json')).catch(() => null)).toBeNull();
  });

  it('blocks an existing app configuration without reading or exposing its secrets', async () => {
    const root = await bootstrapFixture(); const m = await core();
    await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://someone:do-not-read@live.example:5432/live\n');
    const plan = await m.inspectOnboarding(root, {}, inspectionAdapters());
    expect(plan.ready).toBe(false);
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'configuration', code: 'EXISTING_CONFIGURATION', status: 'blocked' }));
    expect(JSON.stringify(plan)).not.toContain('do-not-read');
    expect(JSON.stringify(plan)).not.toContain('live.example');
  });

  it('requires exact dependencies for developer skip-install and refuses a workspace borrowed from another root', async () => {
    const root = await bootstrapFixture(); const other = await bootstrapFixture(); const m = await core();
    expect((await m.inspectOnboarding(root, { skipInstall: true }, inspectionAdapters())).ready).toBe(false);
    await installFixtureDependencies(root, join(other, 'packages/persistence'));
    const plan = await m.inspectOnboarding(root, { skipInstall: true }, inspectionAdapters());
    expect(plan.ready).toBe(false);
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'dependencies', code: 'DEPENDENCIES_DIFFERENT_ROOT' }));
  });

  it('accepts exact same-root installed dependencies for developer rehearsal', async () => {
    const root = await bootstrapFixture(); const m = await core();
    await installFixtureDependencies(root);
    expect((await m.inspectOnboarding(root, { skipInstall: true }, inspectionAdapters())).ready).toBe(true);
    await writeFile(join(root, 'node_modules/fixture-dep/package.json'), '{"version":"2.0.0"}');
    const plan = await m.inspectOnboarding(root, { skipInstall: true }, inspectionAdapters());
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'dependencies', code: 'DEPENDENCIES_STALE' }));
    expect(plan.ready).toBe(false);
  });

  it('rejects unsupported Node versions and occupied selected ports before writing config', async () => {
    const root = await bootstrapFixture(); const m = await core();
    for (const nodeVersion of ['24.19.9', '25.0.0', '22.20.0']) {
      const plan = await m.inspectOnboarding(root, {}, inspectionAdapters({ nodeVersion }));
      expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'node', code: 'NODE_VERSION_UNSUPPORTED' }));
      expect(plan.ready).toBe(false);
    }
    const plan = await m.inspectOnboarding(root, { apiPort: 4430, webPort: 5273, databasePort: 5542 },
      inspectionAdapters({ portAvailable: async (port: number) => port !== 5273 }));
    expect(plan.ready).toBe(false);
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'port-web', code: 'PORT_OCCUPIED' }));
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
  });

  it('refuses nonempty source data and a pre-existing Docker volume', async () => {
    const root = await bootstrapFixture(); const m = await core();
    await mkdir(join(root, '.local/data')); await writeFile(join(root, '.local/data/source.png'), 'original');
    const plan = await m.inspectOnboarding(root, {}, inspectionAdapters());
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'data', code: 'EXISTING_LOCAL_DATA' }));
    const fresh = await bootstrapFixture();
    const adapters = inspectionAdapters(); const probe = adapters.run;
    adapters.run = async (request: any) => request.args[0] === 'volume' && request.args[1] === 'ls'
      ? { exitCode: 0, stdout: `${(await m.rootIdentity(fresh)).composeProject}_database\n` } : probe(request);
    const blocked = await m.inspectOnboarding(fresh, {}, adapters);
    expect(blocked.checks).toContainEqual(expect.objectContaining({ id: 'database', code: 'EXISTING_DOCKER_VOLUME' }));
    expect(blocked.ready).toBe(false);
  });

  it('refuses linked configuration paths and invalid or duplicate ports', async () => {
    const root = await bootstrapFixture(); const other = await bootstrapFixture(); const m = await core();
    const { symlink } = await import('node:fs/promises');
    await symlink(join(other, '.local'), join(root, '.local/data'), 'junction');
    const plan = await m.inspectOnboarding(root, {}, inspectionAdapters());
    expect(plan.checks).toContainEqual(expect.objectContaining({ id: 'paths', code: 'SYMLINK_TARGET' }));
    for (const options of [{ apiPort: 5173 }, { databasePort: 0 }, { apiPort: 65536 }, { webPort: 1023 }]) {
      const result = await m.inspectOnboarding(other, options, inspectionAdapters());
      expect(result.ready).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({ id: 'ports', code: 'PORTS_INVALID' }));
    }
  });
});


describe('authorization callback origins', () => {
  it('sets the web origin field consumed by authorization return links', async () => {
    const root = await fixture();
    const child = spawnSync(process.execPath, [join(root, 'scripts/setup-local.mjs')], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(child.status).toBe(0);
    expect(await readFile(join(root, '.env'), 'utf8')).toContain('PUBLIC_WEB_ORIGIN=http://127.0.0.1:5173\n');
  });
});

async function applyCore() {
  const m = await core();
  expect(m.applyOnboarding, 'fresh-machine apply is required').toBeTypeOf('function');
  return m;
}

function applyAdapters(root: string, failures: any = {}) {
  const state: any = { volume: false, container: false, migrated: false, mutations: [], labels: {}, ports: {} };
  const probes = inspectionAdapters();
  const adapters: any = { ...probes,
    databaseState: async () => state.migrated
      ? { tables: ['schema_migrations', 'fixture'], migrations: [{ name: '001.sql', checksum: '1fe9e6c9738347e9a235c7327c310458c467e1bfcbbee8ee10148c17ca08431d' }], connectionCount: 0 }
      : { tables: [], migrations: [], connectionCount: 0 },
    run: async (request: any) => {
      const args = request.args;
      if (args[0] === 'volume' && args[1] === 'ls') return { exitCode: 0, stdout: state.volume ? `${state.volumeName}\n` : '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { exitCode: 0, stdout: JSON.stringify(state.labels) };
      if (args[0] === 'ps') return { exitCode: 0, stdout: state.container ? 'fixture-container\n' : '' };
      if (args[0] === 'inspect') return { exitCode: 0, stdout: JSON.stringify({ labels: { ...state.labels, 'com.docker.compose.service': 'postgres' },
        ports: state.ports, mounts: [{ Type: 'volume', Name: state.volumeName, Destination: '/var/lib/postgresql/data' }],
        state: { Running: true, Health: { Status: 'healthy' } } }) };
      if (args.includes('ci')) {
        state.mutations.push('install');
        if (failures.install) return { exitCode: 1, stdout: '', stderr: 'do-not-print-password' };
        await installFixtureDependencies(root);
        return { exitCode: 0, stdout: '' };
      }
      if (args[0] === 'compose' && args.includes('up')) {
        state.mutations.push('database');
        const m = await core(); const owned = await m.readOwnedConfiguration(root);
        expect(args).toContain('--wait');
        expect(request.env.COMPOSE_PROJECT_NAME).toBe(owned.identity.composeProject);
        expect(request.env.POSTGRES_PORT).toBe(String(owned.ports.databasePort));
        state.volume = true; state.container = true; state.volumeName = owned.identity.volumeName;
        state.labels = { 'com.docker.compose.project': owned.identity.composeProject, 'com.docker.compose.volume': 'database',
          'com.shopee-uploader.onboarding.root': owned.identity.rootHash, 'com.shopee-uploader.onboarding.config': owned.receipt.configId };
        state.ports = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(owned.ports.databasePort) }] };
        if (failures.database) return { exitCode: 1, stdout: '', stderr: 'do-not-print-password' };
        return { exitCode: 0, stdout: '' };
      }
      if (args.includes('db:migrate')) {
        state.mutations.push('migrations');
        expect(request.env.PRODUCTION_PILOT_ENABLED).toBe('0');
        expect(request.env.SHOPEE_PRODUCTION_WRITES).toBe('false');
        expect(request.env.CONNECTION_MAINTENANCE_ENABLED).toBe('0');
        expect(request.env.DATABASE_URL).toMatch(/@127\.0\.0\.1:5542\/shopee_uploader$/);
        expect(request.env.NODE_OPTIONS).toBeUndefined();
        if (failures.migrations) return { exitCode: 1, stdout: '', stderr: 'do-not-print-password' };
        state.migrated = true;
        return { exitCode: 0, stdout: '' };
      }
      if (args.includes('build')) {
        state.mutations.push('build');
        if (failures.build) return { exitCode: 1, stdout: '', stderr: 'do-not-print-password' };
        for (const [name, content] of [['apps/web/dist/index.html', '<html>fixture</html>'], ['apps/api/dist/main.js', 'fixture api'],
          ['apps/worker/dist/main.js', 'fixture worker'], ['packages/persistence/dist/index.js', 'fixture persistence']]) {
          await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content);
        }
        return { exitCode: 0, stdout: '' };
      }
      return probes.run(request);
    },
  };
  return { adapters, state };
}
const fixturePorts = { apiPort: 4430, webPort: 5273, databasePort: 5542 };

describe('fresh-machine apply and receipts', () => {
  it('uses production React only for the build and keeps build dependencies installable', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root);
    const observed = new Map<string, any>(); const run = f.adapters.run;
    f.adapters.run = async (request: any) => {
      const phase = ['ci', 'db:migrate', 'build'].find(name => request.args.includes(name));
      if (phase) {
        const child = spawnSync(process.execPath, ['--eval', `
          const React = require(process.argv[1]);
          process.stdout.write(JSON.stringify({ nodeEnv: process.env.NODE_ENV,
            developmentReact: Object.hasOwn(React.createElement('div'), '_store'),
            omit: process.env.npm_config_omit ?? null, productionInstall: process.env.npm_config_production ?? null,
            pilot: process.env.PRODUCTION_PILOT_ENABLED, writes: process.env.SHOPEE_PRODUCTION_WRITES,
            maintenance: process.env.CONNECTION_MAINTENANCE_ENABLED, preload: process.env.NODE_OPTIONS ?? null }));
        `, join(checkout, 'node_modules/react')], { cwd: root, env: request.env, encoding: 'utf8', windowsHide: true });
        expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
        observed.set(phase, JSON.parse(child.stdout));
      }
      return run(request);
    };
    expect((await m.applyOnboarding(root, fixturePorts, f.adapters)).status).toBe('complete');
    expect(observed.get('ci')).toMatchObject({ nodeEnv: 'development', omit: null, productionInstall: null });
    expect(observed.get('db:migrate').nodeEnv).toBe('development');
    expect(observed.get('build')).toMatchObject({ nodeEnv: 'production', developmentReact: false });
    for (const value of observed.values()) {
      expect(value).toMatchObject({ pilot: '0', writes: 'false', maintenance: '0', preload: null });
    }
    expect(m.runtimeEnvironment(await m.readOwnedConfiguration(root)).NODE_ENV).toBe('development');
  });

  it('installs and verifies a new owned database before migrating and building, with no application start', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root);
    const result = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(result.status).toBe('complete');
    expect(f.state.mutations).toEqual(['install', 'database', 'migrations', 'build']);
    const owned = await m.readOwnedConfiguration(root);
    expect(owned.ports).toEqual(fixturePorts);
    expect(owned.env.PUBLIC_API_ORIGIN).toBe('http://127.0.0.1:4430');
    expect(owned.env.PUBLIC_WEB_ORIGIN).toBe('http://127.0.0.1:5273');
    const receiptText = await readFile(join(root, '.local/onboarding/receipt.json'), 'utf8');
    expect(receiptText).not.toContain(owned.env.APP_ENCRYPTION_KEY);
    expect(receiptText).not.toContain(owned.docker.POSTGRES_PASSWORD);
    expect(receiptText).not.toContain(owned.env.DATABASE_URL);
    expect(owned.receipt.buildIdentity).toEqual(expect.objectContaining({ fileCount: 4, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(Object.values(owned.receipt.phases).every((p: any) => p.state === 'complete')).toBe(true);
    const again = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(again.status).toBe('complete');
    expect(f.state.mutations).toEqual(['install', 'database', 'migrations', 'build']);
  });

  it('blocks an operating setup before any install, Docker up or migration', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root);
    await writeFile(join(root, '.env'), 'private-operating-config\n');
    const result = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(result.status).toBe('blocked');
    expect(f.state.mutations).toEqual([]);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('private-operating-config\n');
    expect(JSON.stringify(result)).not.toContain('private-operating-config');
  });

  it('resumes a failed installation with the same key and refuses configuration tampering', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root, { install: true });
    const result = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(result.status).toBe('failed');
    expect(result.phase).toBe('install');
    expect(JSON.stringify(result)).not.toContain('do-not-print-password');
    const original = await readFile(join(root, '.env'), 'utf8');
    const owned = await m.readOwnedConfiguration(root);
    expect(owned.receipt.phases.install.state).toBe('failed');
    const resumed = applyAdapters(root);
    expect((await m.applyOnboarding(root, fixturePorts, resumed.adapters)).status).toBe('complete');
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(original);
    await writeFile(join(root, '.local/docker.env'), 'POSTGRES_PASSWORD=changed\n');
    await expect(m.readOwnedConfiguration(root)).rejects.toThrow('CONFIGURATION_CHANGED');
    const blocked = await m.applyOnboarding(root, fixturePorts, resumed.adapters);
    expect(blocked.status).toBe('blocked');
    expect(blocked.plan.checks).toContainEqual(expect.objectContaining({ code: 'CONFIGURATION_CHANGED' }));
  });

  it('never retries an unclear migration result and keeps the exact receipt and configuration', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root, { migrations: true });
    const first = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(first.status).toBe('failed'); expect(first.phase).toBe('migrations');
    const appBefore = await readFile(join(root, '.env'), 'utf8');
    const receiptBefore = await readFile(join(root, '.local/onboarding/receipt.json'), 'utf8');
    const again = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(again.status).toBe('blocked');
    expect(again.plan.checks).toContainEqual(expect.objectContaining({ code: 'MIGRATION_REVIEW_REQUIRED' }));
    expect(f.state.mutations).toEqual(['install', 'database', 'migrations']);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(appBefore);
    expect(await readFile(join(root, '.local/onboarding/receipt.json'), 'utf8')).toBe(receiptBefore);
  });

  it('refuses a moved receipt and strips inherited credentials, proxies, preloads and production flags', async () => {
    const root = await bootstrapFixture(); const other = await bootstrapFixture(); const m = await applyCore();
    const f = applyAdapters(root, { install: true }); await m.applyOnboarding(root, fixturePorts, f.adapters);
    const owned = await m.readOwnedConfiguration(root);
    const env = m.runtimeEnvironment(owned, { PATH: 'fixture-path', NODE_OPTIONS: '--import unsafe', HTTP_PROXY: 'http://proxy',
      DATABASE_URL: 'live', SHOPEE_TOKEN: 'token', PRODUCTION_PILOT_ENABLED: '1', CONNECTION_MAINTENANCE_ENABLED: '1' });
    expect(env.PATH).toBe('fixture-path'); expect(env.SHOPEE_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.DATABASE_URL).toBe(owned.env.DATABASE_URL); expect(env.PRODUCTION_PILOT_ENABLED).toBe('0');
    for (const name of ['.env', '.local/docker.env', '.local/onboarding/receipt.json']) {
      await mkdir(dirname(join(other, name)), { recursive: true }); await writeFile(join(other, name), await readFile(join(root, name)));
    }
    await expect(m.readOwnedConfiguration(other)).rejects.toThrow('OWNERSHIP_RECEIPT_INVALID');
  });
});


describe('onboarding command surfaces', () => {
  it('binds setup commands to their checkout even when launched from another working directory', async () => {
    const root = await bootstrapFixture(); const unrelated = await bootstrapFixture();
    const source = await readFile(join(checkout, 'scripts/bootstrap.mjs')).catch(() => null);
    expect(source, 'bootstrap CLI must exist').not.toBeNull();
    await writeFile(join(root, 'scripts/bootstrap.mjs'), source!);
    const child = spawnSync(process.execPath, [join(root, 'scripts/bootstrap.mjs'), '--json'], {
      cwd: unrelated, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    const result = JSON.parse(child.stdout);
    expect(result.projectRoot.toLowerCase()).toBe(root.toLowerCase());
    expect(result.mode).toBe('plan');
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
    expect(await readFile(join(unrelated, '.env')).catch(() => null)).toBeNull();
  });

  it('refuses CLI root overrides without inspecting or creating that root', async () => {
    const root = await bootstrapFixture();
    const source = await readFile(join(checkout, 'scripts/bootstrap.mjs')).catch(() => null);
    expect(source, 'bootstrap CLI must exist').not.toBeNull();
    await writeFile(join(root, 'scripts/bootstrap.mjs'), source!);
    const child = spawnSync(process.execPath, [join(root, 'scripts/bootstrap.mjs'), '--apply', '--root', root], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain('UNKNOWN_BOOTSTRAP_ARGUMENT');
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
  });

  it('makes doctor an inspect-only check with required installed dependencies and sanitized errors', async () => {
    const root = await bootstrapFixture(); const m = await core();
    expect(m.inspectDoctor, 'structured inspect-only doctor is required').toBeTypeOf('function');
    const report = await m.inspectDoctor(root, {}, inspectionAdapters({ run: async () => ({ exitCode: 1,
      stdout: 'postgres://admin:private-password@live.example/live', stderr: 'private-error-token' }) }));
    expect(report.mode).toBe('doctor'); expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'dependencies', status: 'blocked' }));
    expect(JSON.stringify(report)).not.toContain('private-password');
    expect(JSON.stringify(report)).not.toContain('private-error-token');
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
  });
});

describe('onboarding finalization and health checks', () => {
  it('finalizes a receipt interrupted after the build without replaying any completed phase', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root);
    expect((await m.applyOnboarding(root, fixturePorts, f.adapters)).status).toBe('complete');
    const path = join(root, '.local/onboarding/receipt.json');
    const receipt = JSON.parse(await readFile(path, 'utf8')); receipt.status = 'incomplete';
    await writeFile(path, JSON.stringify(receipt));
    expect((await m.applyOnboarding(root, fixturePorts, f.adapters)).status).toBe('complete');
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('complete');
    expect(f.state.mutations).toEqual(['install', 'database', 'migrations', 'build']);
  });

  it('refuses a Windows-container Docker engine before creating any configuration', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const adapters = inspectionAdapters();
    const probe = adapters.run;
    adapters.run = async (request: any) => request.args[0] === 'info'
      ? { exitCode: 0, stdout: 'windows\n' } : probe(request);
    const result = await m.applyOnboarding(root, fixturePorts, adapters);
    expect(result.status).toBe('blocked');
    expect(result.plan.checks).toContainEqual(expect.objectContaining({ code: 'DOCKER_LINUX_ENGINE_REQUIRED' }));
    expect(await readFile(join(root, '.env')).catch(() => null)).toBeNull();
  });

  it('lets doctor verify occupied ports only after the launcher proves their processes belong to this setup', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root);
    expect((await m.applyOnboarding(root, fixturePorts, f.adapters)).status).toBe('complete');
    f.adapters.portAvailable = async (port: number) => port === 5542;
    f.adapters.inspectRuntime = async () => ({ owned: true, running: true, healthy: true, ports: [4430, 5273] });
    expect((await m.inspectDoctor(root, fixturePorts, f.adapters)).ready).toBe(true);
    f.adapters.inspectRuntime = async () => ({ owned: false, running: true, healthy: true, ports: [4430, 5273] });
    const unowned = await m.inspectDoctor(root, fixturePorts, f.adapters);
    expect(unowned.ready).toBe(false);
    expect(unowned.checks).toContainEqual(expect.objectContaining({ code: 'PORT_OCCUPIED' }));
    const plan = await m.inspectOnboarding(root, fixturePorts, f.adapters);
    expect(plan.ready).toBe(false);
  });

  it('refuses a missing or relabelled owned volume without recreating it', async () => {
    const root = await bootstrapFixture(); const m = await applyCore(); const f = applyAdapters(root);
    expect((await m.applyOnboarding(root, fixturePorts, f.adapters)).status).toBe('complete');
    f.state.labels['com.shopee-uploader.onboarding.config'] = 'different-setup';
    const mismatched = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(mismatched.status).toBe('blocked');
    expect(mismatched.plan.checks).toContainEqual(expect.objectContaining({ code: 'DOCKER_OWNERSHIP_MISMATCH' }));
    f.state.volume = false; f.state.container = false;
    const missing = await m.applyOnboarding(root, fixturePorts, f.adapters);
    expect(missing.status).toBe('blocked');
    expect(missing.plan.checks).toContainEqual(expect.objectContaining({ code: 'OWNED_VOLUME_MISSING' }));
    expect(f.state.mutations).toEqual(['install', 'database', 'migrations', 'build']);
  });
});

describe('sanitized tool output', () => {
  it('keeps tool version warnings and arbitrary output out of the JSON report', async () => {
    const root = await bootstrapFixture(); const m = await core(); const adapters = inspectionAdapters();
    const probe = adapters.run;
    adapters.run = async (request: any) => request.args.includes('--version')
      ? { exitCode: 0, stdout: '11.11.0\nwarning-private-value\n' } : probe(request);
    const plan = await m.inspectOnboarding(root, {}, adapters);
    expect(plan.ready).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('warning-private-value');
  });
});

describe('verification build environments', () => {
  it.each(['verify.mjs', 'verify-internal.mjs'])('%s passes production environment only to the web build', async script => {
    const root = await fixture();
    for (const name of [script, 'internal-environment.mjs', 'internal-network-guard.mjs']) {
      await writeFile(join(root, 'scripts', name), await readFile(join(checkout, 'scripts', name)));
    }
    const observation = (name: string) => `
      const name = ${JSON.stringify(name)};
      import('node:fs').then(({ appendFileSync }) => appendFileSync('.local/stages.jsonl', JSON.stringify({
        name: name === 'typescript' ? process.argv.includes('-b') ? 'build-typescript' : 'typecheck' : name,
        nodeEnv: process.env.NODE_ENV, pilot: process.env.PRODUCTION_PILOT_ENABLED,
        writes: process.env.SHOPEE_PRODUCTION_WRITES, maintenance: process.env.CONNECTION_MAINTENANCE_ENABLED,
        guarded: (process.env.NODE_OPTIONS ?? '').includes('internal-network-guard.mjs'),
      }) + '\\n'));
    `;
    // Only the external tools are substituted. Both verifier entry points, their
    // environment selection, isolated loader and child processes execute unchanged.
    for (const [path, name] of [
      ['node_modules/typescript/bin/tsc', 'typescript'], ['node_modules/vite/bin/vite.js', 'build-web'],
      ['scripts/validate-repository-skills.mjs', 'repository-skills'], ['tests/shared.test.js', 'legacy'],
      ['node_modules/vitest/vitest.mjs', 'unit-integration'],
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), observation(name));
    }
    if (script === 'verify-internal.mjs') {
      const { symlink } = await import('node:fs/promises');
      await mkdir(join(root, 'node_modules/@shopee'), { recursive: true });
      for (const [name, directory] of [['domain', 'domain'], ['persistence', 'persistence'], ['gateway', 'shopee'], ['agent-runtime', 'agent-runtime']]) {
        await mkdir(join(root, 'packages', directory), { recursive: true });
        await symlink(join(root, 'packages', directory), join(root, 'node_modules/@shopee', name), 'junction');
      }
      const internal = join(root, '.local/internal');
      await mkdir(internal, { recursive: true });
      await writeFile(join(internal, 'isolated-environment.json'), JSON.stringify({ version: 1, mode: 'isolated', projectRoot: root,
        apiPort: 4430, webPort: 5273, databasePort: 5443, databaseName: 'shopee_internal_test', databaseUser: 'shopee_internal',
        dataRoot: join(internal, 'data') }));
      await writeFile(join(internal, 'secrets.json'), JSON.stringify({ databasePassword: 'a'.repeat(48), encryptionKey: 'b'.repeat(64) }));
      await writeFile(join(internal, 'empty.env'), '# fixture\n');
    }
    const child = spawnSync(process.execPath, [join(root, 'scripts', script)], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'development',
        PRODUCTION_PILOT_ENABLED: '0', SHOPEE_PRODUCTION_WRITES: 'false', CONNECTION_MAINTENANCE_ENABLED: '0' },
    });
    expect(child.error).toBeUndefined(); expect(child.status, child.stdout + child.stderr).toBe(0);
    const stages = (await readFile(join(root, '.local/stages.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(stages.map(stage => [stage.name, stage.nodeEnv])).toEqual([
      ['typecheck', 'development'], ['repository-skills', 'development'], ['build-typescript', 'development'],
      ['build-web', 'production'], ['legacy', 'development'], ['unit-integration', 'development'],
    ]);
    for (const stage of stages) {
      expect(stage).toMatchObject({ pilot: '0', writes: 'false', maintenance: '0', guarded: script === 'verify-internal.mjs' });
    }
  });
});
