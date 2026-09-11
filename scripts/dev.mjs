import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const node = process.execPath;
const children = [
  spawn(node, ['--conditions=development', '--import', 'tsx', 'apps/api/src/main.ts'], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json') },
  }),
  spawn(node, ['--conditions=development', '--import', 'tsx', 'apps/worker/src/main.ts'], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/worker/tsconfig.json') },
  }),
  spawn(node, [resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/web/vite.config.ts'], {
    stdio: 'inherit',
    windowsHide: true,
  }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.once('SIGINT', () => close());
process.once('SIGTERM', () => close());
for (const child of children) {
  child.on('error', () => close(1));
  child.on('exit', (code) => {
    if (!closing) close(code ?? 1);
  });
}
