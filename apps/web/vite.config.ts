import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, workspaceRoot, '');
  const apiPort = Number(process.env.API_PORT ?? fileEnv.API_PORT ?? 4310);
  const webPort = Number(process.env.WEB_PORT ?? fileEnv.WEB_PORT ?? 5173);
  if (![apiPort, webPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || apiPort === webPort) {
    throw new Error('API_PORT and WEB_PORT must be different valid local ports.');
  }
  const proxy = { '/v1': `http://127.0.0.1:${apiPort}`, '/health': `http://127.0.0.1:${apiPort}` };
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: webPort, strictPort: true, proxy },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
