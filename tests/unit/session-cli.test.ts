import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadContextRegistry } from '../../packages/agent-runtime/src/session-store.js';
const root = process.cwd();

describe('session CLI and delivery', () => {
  it('validates the actual dynamic registry and all referenced files', async () => {
    const registry = await loadContextRegistry(root);
    expect(registry.features.length).toBeGreaterThanOrEqual(8);
    expect(new Set(registry.features.map((feature) => feature.id)).size).toBe(
      registry.features.length,
    );
  });
  it('reads a bounded real context packet without invoking a business operation', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/session-context.mjs', 'brief', '--feature', 'session-continuity'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32769);
    expect(result.stdout).toContain('"readOnly": true');
    expect(result.stderr).toMatch(/SESSION_CONTEXT_PACKET_BYTES=\d+/);
  });
  it('rejects invalid CLI options and unknown tasks with safe errors', () => {
    const invalid = spawnSync(
      process.execPath,
      ['scripts/session-context.mjs', 'brief', '--root', 'elsewhere'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('ARGUMENT_INVALID');
    const missing = spawnSync(
      process.execPath,
      ['scripts/session-context.mjs', 'brief', '--task', 'not-a-real-task'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('UNKNOWN_TASK');
  });
  it('provides a cold-start guide without installing dependencies or touching private state', async () => {
    const cold = await mkdtemp(join(tmpdir(), 'listing-context-cold-'));
    try {
      await mkdir(join(cold, 'scripts'));
      await writeFile(
        join(cold, 'scripts/session-context.mjs'),
        await readFile(join(root, 'scripts/session-context.mjs')),
      );
      const brief = spawnSync(process.execPath, ['scripts/session-context.mjs', 'brief'], {
        cwd: cold,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      expect(brief.status).toBe(0);
      expect(brief.stdout).toContain('CODEX_FIRST_RUN');
      const write = spawnSync(
        process.execPath,
        [
          'scripts/session-context.mjs',
          'checkpoint',
          '--input',
          '.local/task.json',
          '--expected-revision',
          '0',
        ],
        { cwd: cold, encoding: 'utf8', windowsHide: true, timeout: 10000 },
      );
      expect(write.status).toBe(2);
      expect(write.stderr).toContain('DEPENDENCIES_REQUIRED');
      await expect(readFile(join(cold, '.local/session-context/state.json'))).rejects.toThrow();
    } finally {
      if (!resolve(cold).startsWith(resolve(tmpdir(), 'listing-context-cold-')))
        throw new Error('Unsafe fixture cleanup');
      await rm(cold, { recursive: true, force: true });
    }
  });
  it('ships the mechanism and public docs, excluding all private session state', async () => {
    const { isReleasePath } = (await import(
      pathToFileURL(join(root, 'scripts/release-package.mjs')).href
    )) as { isReleasePath: (path: string) => boolean };
    for (const path of [
      'scripts/session-context.mjs',
      'scripts/session-context.mts',
      'docs/context/features.json',
      'docs/ai/SESSION_CONTINUITY.md',
      'packages/agent-runtime/src/session-store.ts',
    ])
      expect(isReleasePath(path)).toBe(true);
    expect(isReleasePath('.local/session-context/state.json')).toBe(false);
    expect(isReleasePath('.local/session-context/journal/00000001.json')).toBe(false);
  });
});
