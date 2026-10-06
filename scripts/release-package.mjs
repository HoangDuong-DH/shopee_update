import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const rootFiles = new Set(['README.md', 'AGENTS.md', 'HUONG_DAN_MO_WEB_APP.md', 'MO_WEB_APP.cmd',
  'SETUP_LISTINGSTUDIO.cmd', 'START_LISTINGSTUDIO.cmd', 'STOP_LISTINGSTUDIO.cmd',
  'package.json', 'package-lock.json', '.node-version', '.env.example', '.gitignore', '.gitattributes',
  '.prettierignore', '.prettierrc.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.check.json',
  'vitest.config.mts', 'playwright.config.ts', 'manifest.json', 'content.js', 'content.css', 'popup.js', 'popup.html', 'shared.js']);
const scripts = new Set(['README.md', 'bootstrap.mjs', 'onboarding-core.mjs', 'setup-local.mjs', 'doctor.mjs',
  'start-local.mjs', 'local-launcher.mjs', 'managed-process.mjs', 'runtime-files.mjs', 'local-supervisor-policy.mjs', 'local-supervisor.mjs', 'connection-maintenance-policy.mjs', 'windows-entry.ps1', 'release-package.mjs', 'migrate.mts',
  'dev.mjs', 'verify.mjs', 'verify-internal.mjs', 'runtime-endurance.mts', 'runtime-endurance-core.mjs', 'import-recipe-product.mts', 'import-recipe.mts', 'internal-environment.mjs', 'internal-network-guard.mjs',
  'internal-backup.mjs', 'transfer-local.mjs', 'transfer-files.mjs', 'transfer-database.mjs', 'transfer-restore.mjs', 'reference-library.mjs', 'validate-repository-skills.mjs', 'evaluate-harness.mjs',
  'session-context.mjs', 'session-context.mts', 'run-pass1-production-batch.mts', 'inspect-pass1-size-charts.mts', 'inspect-pass1-category-recommendations.mts']);
const excludedParts = new Set(['node_modules', 'dist', 'coverage', '.local', '.git', '.cache', '.claude', '.codex', '.agents', 'outputs', 'output', 'tmp', 'test-results', 'playwright-report', 'private']);
export function isReleasePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || path.startsWith('/')) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || excludedParts.has(part))) return false;
  if (/\.(?:log|tsbuildinfo|xlsx|docx|zip|sqlite(?:3)?|db|pem|key|dump)$/i.test(path)) return false;
  if (parts.some(part => part.startsWith('.env') && part !== '.env.example')) return false;
  if (rootFiles.has(path)) return true;
  if (parts[0] === 'scripts') return parts.length === 2 && scripts.has(parts[1]);
  if (parts[0] === '.github') return path === '.github/workflows/check.yml';
  if (['apps', 'packages', 'tests', 'skills', 'infra'].includes(parts[0])) return true;
  if (parts[0] === 'docs') return !['delivery', 'sources', 'research', 'test-reports'].includes(parts[1]) && !(parts[1] === 'handoffs' && /^20/.test(parts[2] ?? ''));
  return false;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function noLinks(path) {
  let current = resolve(path);
  for (;;) {
    const st = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (st?.isSymbolicLink()) throw Error('Symbolic link is not allowed in a source release.');
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
function guardSecrets(path, bytes) {
  if (!/\.(?:json|[cm]?[jt]sx?|md|yaml|yml|ps1|cmd)$/.test(path) && path !== '.env.example') return;
  const text = bytes.toString('utf8');
  if (/(?:APP_ENCRYPTION_KEY|SHOPEE_(?:SANDBOX_)?PARTNER_KEY)\s*[=:]\s*["']?[a-f\d]{32,}/i.test(text) ||
    /["'](?:access_token|refresh_token)["']\s*:\s*["'][a-zA-Z\d_-]{40,}["']/.test(text) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw Error('Possible real credential in ' + path + '; export blocked.');
}
export async function createSourceRelease({ root, output, candidates, revision = 'working-tree' }) {
  root = resolve(root); output = resolve(output);
  await noLinks(root); await noLinks(output);
  const archive = resolve(output, 'LISTINGSTUDIO_SOURCE.zip');
  const receiptPath = resolve(output, 'release-receipt.json');
  if (await lstat(archive).catch(() => null) || await lstat(receiptPath).catch(() => null)) throw Error('Release already exists; choose a new output directory.');
  if (!candidates) {
    const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (git.status !== 0) throw Error('Export from the source Git checkout; no source inventory was found.');
    candidates = git.stdout.split('\0').filter(Boolean);
  }
  const paths = [...new Set(candidates)].filter(isReleasePath).sort();
  const entries = {}; const files = [];
  for (const path of paths) {
    const full = resolve(root, ...path.split('/'));
    const rel = relative(root, full);
    if (rel.startsWith('..' + sep) || rel === '..') throw Error('Path outside source checkout.');
    await noLinks(full);
    const info = await lstat(full); if (!info.isFile()) throw Error('Source is not a regular file: ' + path);
    const bytes = await readFile(full); guardSecrets(path, bytes);
    entries[path] = new Uint8Array(bytes);
    files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
  }
  if (!files.length) throw Error('Source inventory is empty.');
  for (const file of files) if (sha(await readFile(resolve(root, file.path))) !== file.sha256) throw Error('Source changed while exporting; run again after edits finish.');
  const manifest = { version: 1, createdAt: new Date().toISOString(), repositoryRevision: revision,
    content: 'Current source files; working tree changes are included, not published to GitHub.',
    databaseIncluded: false, credentialsIncluded: false, privateEvidenceIncluded: false,
    sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
  entries['RELEASE_MANIFEST.json'] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  const bytes = zipSync(entries, { level: 6 });
  await mkdir(output, { recursive: true });
  await writeFile(archive, bytes, { flag: 'wx' });
  const receipt = { version: 1, createdAt: manifest.createdAt, archive: 'LISTINGSTUDIO_SOURCE.zip',
    sha256: sha(bytes), archiveBytes: bytes.length, sourceFileCount: files.length, sourceBytes: manifest.sourceBytes,
    databaseIncluded: false, credentialsIncluded: false, privateEvidenceIncluded: false,
    sourceRevision: revision, gitHubPublished: false };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { ...receipt, archive, receiptPath };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const args = process.argv.slice(2); if (args.length && (args.length !== 2 || args[0] !== '--output')) throw Error('Usage: node scripts/release-package.mjs [--output <directory>]');
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
    const revision = git.status === 0 ? git.stdout.trim() : 'working-tree';
    console.log(JSON.stringify(await createSourceRelease({ root, output: args[1] ?? resolve(root, 'outputs/handoff'), revision }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
