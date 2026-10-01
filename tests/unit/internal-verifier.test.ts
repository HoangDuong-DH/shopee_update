import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const modulePath = '../../scripts/verify-internal.mjs';
let parseArguments: any, assertWorkingDirectory: any, verifierEnvironment: any, buildCommands: any, browserConfiguration: any;
beforeAll(async () => {
  ({ parseArguments, assertWorkingDirectory, verifierEnvironment, buildCommands, browserConfiguration } = await import(modulePath));
});
const root = process.cwd();
const valid = () => ({ DATABASE_URL: 'postgres://shopee_internal:fixture@127.0.0.1:5443/shopee_internal_test',
  INTERNAL_ISOLATED_MODE: '1', PRODUCTION_PILOT_ENABLED: '0', SHOPEE_PRODUCTION_WRITES: 'false', CONNECTION_MAINTENANCE_ENABLED: '0',
  DOTENV_CONFIG_PATH: resolve(root, '.local/internal/empty.env'), DOTENV_CONFIG_OVERRIDE: 'false' });

describe('reproducible internal verification', () => {
  it('rejects arbitrary commands, filters and duplicate arguments', () => {
    expect(parseArguments(['--browser', '--dry-run'])).toEqual({ help: false, dryRun: true, browser: true });
    for (const args of [['--config=playwright.config.ts'], ['--browser', '--browser'], ['tests/e2e']])
      expect(() => parseArguments(args)).toThrow('ARGUMENTS_INVALID');
  });
  it('rejects running the worktree verifier from another checkout', () => {
    expect(() => assertWorkingDirectory(resolve(root, '..'), root)).toThrow('CWD_MUST_BE_REPOSITORY_ROOT');
    expect(() => assertWorkingDirectory(root, root)).not.toThrow();
  });
  it('rejects live, remote, alternate DB and connection override targets', () => {
    for (const url of ['postgres://shopee_internal:x@127.0.0.1:5442/shopee_internal_test',
      'postgres://shopee_internal:x@example.com:5443/shopee_internal_test',
      'postgres://shopee_internal:x@127.0.0.1:5443/production',
      'postgres://shopee_internal:x@127.0.0.1:5443/shopee_internal_test?host=remote'])
      expect(() => verifierEnvironment({ ...valid(), DATABASE_URL: url }, root, '')).toThrow('DATABASE_TARGET_INVALID');
  });
  it('rejects populated dotenv and enabled write/maintenance flags', () => {
    expect(() => verifierEnvironment(valid(), root, '# comment\nSHOPEE_TOKEN=value')).toThrow('DOTENV_MUST_BE_EMPTY');
    for (const flag of ['PRODUCTION_PILOT_ENABLED', 'SHOPEE_PRODUCTION_WRITES', 'CONNECTION_MAINTENANCE_ENABLED'])
      expect(() => verifierEnvironment({ ...valid(), [flag]: '1' }, root, '')).toThrow('ENVIRONMENT_INVALID');
  });
  it('does not run browser by default and preserves the sequential verification stages', () => {
    expect(buildCommands(resolve(root, '.local/results')).map(([name]: string[]) => name)).toEqual([
      'typecheck', 'repository-skills', 'build-typescript', 'build-web', 'legacy', 'unit-integration',
    ]);
  });
  it('isolates optional browser config from live baseURL and pins exactly one fixture spec', () => {
    const output = resolve(root, '.local/internal/verification/test');
    const config = browserConfiguration(root, output);
    expect(config.testMatch).toBe('internal-acceptance-intake.spec.ts');
    expect(config.use.baseURL).toBeUndefined(); expect(config.webServer).toBeUndefined();
    const command = buildCommands(output, true).at(-1);
    expect(command).toEqual(['browser-intake', 'node_modules/@playwright/test/cli.js', 'test',
      'internal-acceptance-intake.spec.ts', '--config', resolve(output, 'playwright.config.cjs')]);
    expect(config.reporter[1][1].outputFile).toBe(resolve(output, 'browser-intake.json'));
  });
  it('propagates an effective external fetch guard to a child Node process without making a request', () => {
    const env = verifierEnvironment(valid(), root, '# empty\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      try { await fetch('https://example.invalid'); process.exitCode=2; }
      catch(error) { if(error.message!=='ISOLATED_EXTERNAL_REQUEST_BLOCKED') process.exitCode=3; }
    `], { env, encoding: 'utf8', windowsHide: true });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
