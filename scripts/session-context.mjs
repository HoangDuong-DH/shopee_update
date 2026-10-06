import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0] ?? 'brief';
let ready = true;
try {
  import.meta.resolve('tsx');
  import.meta.resolve('zod');
} catch {
  ready = false;
}
const [major, minor] = process.versions.node.split('.').map(Number);
ready = ready && major === 24 && minor >= 20;
if (!ready) {
  if (!['brief', 'status', 'help'].includes(command)) {
    console.error(
      'SESSION_CONTEXT_DEPENDENCIES_REQUIRED: xem docs/onboarding/CODEX_FIRST_RUN.md; không thay đổi checkpoint.',
    );
    process.exitCode = 2;
  } else {
    console.log(
      '# ListingStudio — khởi đầu tối thiểu\nChưa có runtime/dependencies phù hợp. Không kết luận về checkpoint hoặc trạng thái shop.\nĐọc AGENTS.md → docs/onboarding/START_HERE.md → docs/onboarding/CODEX_FIRST_RUN.md.\nSau thiết lập theo kế hoạch: npm run session:brief -- --feature session-continuity.\nKhông chạy setup đè môi trường vận hành; không tự resume batch.',
    );
  }
} else {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=development',
      '--import',
      'tsx',
      resolve(root, 'scripts/session-context.mts'),
      ...args,
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
}
