import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const script = resolve('scripts/windows-entry.ps1');
function preflight(minimumBytes) {
  const command = "$ErrorActionPreference='Stop'; "
    + '$taskParsed=[Management.Automation.Language.Parser]::ParseFile(' + quote(script) + ',[ref]$null,[ref]$null); '
    + "$taskGuard=$taskParsed.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-SetupDiskSpace'},$true); "
    + "if (!$taskGuard) {throw 'Installer disk preflight is missing.'}; "
    + '. ([ScriptBlock]::Create($taskGuard.Extent.Text)); '
    + 'Assert-SetupDiskSpace -CheckoutPath ' + quote(process.cwd()) + ' -MinimumBytes ' + minimumBytes;
  return spawnSync(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', windowsHide: true });
}
test('installer disk preflight accepts an available budget without mutating the checkout', { skip: !windows }, () => {
  const result = preflight('0'); assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('installer disk preflight refuses an unavailable budget with an actionable space message', { skip: !windows }, () => {
  const result = preflight('9223372036854775807');
  assert.equal(result.status, 1); assert.match(result.stderr, /free space.*setup|setup.*free space/i);
});
test('installer disk preflight rejects an invalid negative budget', { skip: !windows }, () => {
  const result = preflight('-1');
  assert.equal(result.status, 1); assert.match(result.stderr, /disk space budget is invalid/i);
});
