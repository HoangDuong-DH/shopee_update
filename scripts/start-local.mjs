import { runLocalLauncher } from './local-launcher.mjs';
try { await runLocalLauncher('start', { noBrowser: process.argv.includes('--no-browser') }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
