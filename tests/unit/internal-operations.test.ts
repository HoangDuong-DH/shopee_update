import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Load executable JS tools without pulling them into the application's TS build.
const environmentModule = '../../scripts/internal-environment.mjs';
const backupModule = '../../scripts/internal-backup.mjs';
const guardModule = '../../scripts/internal-network-guard.mjs';
let validateConfig: any, makeEnvironment: any, createSnapshot: any, verifySnapshot: any,
  databaseIdentity: any, validateRestoreTarget: any, allowLocalFetch: any;
beforeAll(async () => {
  ({ validateConfig, makeEnvironment } = await import(environmentModule));
  ({ createSnapshot, verifySnapshot, databaseIdentity, validateRestoreTarget } = await import(backupModule));
  ({ allowLocalFetch } = await import(guardModule));
});
const directories: string[] = [];
const testRoot = process.cwd();
const config = { version: 1, mode: 'isolated', projectRoot: testRoot, apiPort: 4430, webPort: 5273,
  databasePort: 5443, databaseName: 'shopee_internal_test', databaseUser: 'shopee_internal',
  dataRoot: resolve(testRoot, '.local/internal/data') };
const secrets = { databasePassword: 'a'.repeat(48), encryptionKey: 'b'.repeat(64) };

afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !path.includes('shopee-internal-test-')) throw Error('Unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shopee-internal-test-')); directories.push(root);
  const source = join(root, 'input'), output = join(root, 'backup');
  await mkdir(source); await writeFile(join(source, 'image.jpg'), 'immutable-original');
  return { root, source, output, options: { output, database: { host: '127.0.0.1', port: 5442, database: 'live' },
    sources: [{ label: 'data', path: source }], quiesced: true,
    dump: async (path: string) => writeFile(path, 'fixture-dump-not-a-real-database') } };
}

describe('internal operations isolation', () => {
  it('does not inherit production keys, proxies, preloads or dotenv configuration', () => {
    const env = makeEnvironment(config, secrets, testRoot, { PATH: 'runtime', DATABASE_URL: 'live',
      PRODUCTION_PILOT_ENABLED: '1', APP_ENCRYPTION_KEY: 'live-key', NODE_OPTIONS: '--import live',
      HTTP_PROXY: 'http://proxy', DOTENV_CONFIG_PATH: '.env', SHOPEE_TOKEN: 'live-token' });
    expect(env.PATH).toBe('runtime');
    expect(env.PRODUCTION_PILOT_ENABLED).toBe('0');
    expect(env.CONNECTION_MAINTENANCE_ENABLED).toBe('0');
    expect(env.DATABASE_URL).toContain(':5443/shopee_internal_test');
    expect(env.APP_ENCRYPTION_KEY).toBe(secrets.encryptionKey);
    expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.HTTP_PROXY).toBeUndefined(); expect(env.SHOPEE_TOKEN).toBeUndefined();
    expect(env.DOTENV_CONFIG_PATH).toContain('empty.env');
  });
  it('rejects live ports, live data paths and non-isolated databases', () => {
    expect(() => validateConfig({ ...config, apiPort: 4310 }, testRoot)).toThrow('PORTS_INVALID');
    expect(() => validateConfig({ ...config, dataRoot: resolve(testRoot, '.local/data') }, testRoot)).toThrow('TARGET_INVALID');
    expect(() => validateConfig({ ...config, databaseName: 'shopee_uploader' }, testRoot)).toThrow('TARGET_INVALID');
  });
  it('only accepts literal loopback HTTP origins and blocks redirected fetches', () => {
    expect(allowLocalFetch('http://127.0.0.1:4430/health/live')).toBe(true);
    for (const url of ['https://partner.shopeemobile.com', 'http://localhost.evil.test', 'file:///secret', 'http://x:y@localhost'])
      expect(allowLocalFetch(url)).toBe(false);
    const guard = pathToFileURL(resolve(testRoot, 'scripts/internal-network-guard.mjs')).href;
    const result = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      process.env.INTERNAL_ISOLATED_MODE='1'; let called=0;
      globalThis.fetch=async()=>{called++;return {status:302};};
      await import(${JSON.stringify(guard)});
      try {await fetch('https://example.com');} catch(e) {if(e.message!=='ISOLATED_EXTERNAL_REQUEST_BLOCKED')throw e;}
      if(called!==0)throw Error('External fetch escaped guard');
      try {await fetch('http://localhost');throw Error('Redirect escaped guard');} catch(e) {if(e.message!=='ISOLATED_REDIRECT_BLOCKED')throw e;}
      console.log('blocked');
    `], {
      encoding: 'utf8', windowsHide: true,
      // This child installs a fake fetch before explicitly importing the guard.
      // An inherited preload would cache that import before the fake is installed.
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(result.trim()).toBe('blocked');
  });
});

describe('backup rehearsal protections', () => {
  it('round-trips hashes, refuses overwrite and detects later corruption', async () => {
    const f = await fixture(); const result = await createSnapshot(f.options);
    expect(result.encryptionKeyIncluded).toBe(false);
    expect((await verifySnapshot(f.output)).files).toHaveLength(2);
    await expect(createSnapshot(f.options)).rejects.toThrow();
    expect(await readFile(join(f.source, 'image.jpg'), 'utf8')).toBe('immutable-original');
    await writeFile(join(f.output, 'data/image.jpg'), 'tampered');
    await expect(verifySnapshot(f.output)).rejects.toThrow('CHECKSUM_MISMATCH');
  });
  it('rejects unquiesced writers and output nested inside a source', async () => {
    const f = await fixture();
    await expect(createSnapshot({ ...f.options, quiesced: false })).rejects.toThrow('QUIESCED');
    await expect(createSnapshot({ ...f.options, output: join(f.source, 'nested') })).rejects.toThrow('OVERLAPS_SOURCE');
  });
  it('rejects manifest traversal even if an attacker supplies a checksum', async () => {
    const f = await fixture(); const manifest = await createSnapshot(f.options);
    manifest.files[0].path = '../input/image.jpg';
    await writeFile(join(f.output, 'manifest.json'), JSON.stringify(manifest));
    await expect(verifySnapshot(f.output)).rejects.toThrow('PATH_INVALID');
  });
  it('never permits live/remote restore targets and omits credentials from identity', () => {
    const original = databaseIdentity('postgres://admin:secret@127.0.0.1:5442/live');
    expect(JSON.stringify(original)).not.toContain('secret');
    for (const url of ['postgres://a:b@127.0.0.1:5442/live', 'postgres://a:b@remote:5443/shopee_internal_test', 'postgres://a:b@127.0.0.1:5443/live'])
      expect(() => validateRestoreTarget(url, original)).toThrow('ISOLATED_TARGET');
    const target = 'postgres://a:b@127.0.0.1:5443/shopee_internal_test';
    expect(validateRestoreTarget(target, original).database).toBe('shopee_internal_test');
    expect(() => validateRestoreTarget(target, databaseIdentity(target))).toThrow('SOURCE_EQUALS_TARGET');
    expect(validateRestoreTarget('postgres://a:b@127.0.0.1:5443/shopee_internal_restore', databaseIdentity(target)).database).toBe('shopee_internal_restore');
    expect(() => validateRestoreTarget(target, databaseIdentity('postgres://a:b@localhost:5443/shopee_internal_test'))).toThrow('SOURCE_EQUALS_TARGET');
  });
});
