// Imported only by an explicitly owned launcher. Local IPC proves which process it started.
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
const pipe = process.env.LISTINGSTUDIO_LAUNCH_PIPE;
const token = process.env.LISTINGSTUDIO_LAUNCH_TOKEN;
if (pipe || token) {
  if (!pipe || !/^[a-f0-9]{64}$/.test(token ?? '')) throw Error('Invalid managed launch identity.');
  const identity = { pid: process.pid, executable: process.execPath, commandLine: process.argv.join(' '), startedAt: new Date().toISOString(), projectRoot: process.cwd() };
  const exitPath = process.env.LISTINGSTUDIO_LAUNCH_EXIT_PATH;
  if (exitPath) {
    if (!isAbsolute(exitPath) || !resolve(exitPath).startsWith(resolve(process.cwd(), '.local') + (process.platform === 'win32' ? '\\' : '/'))) throw Error('Invalid managed exit receipt path.');
    process.once('exit', exitCode => {
      try { writeFileSync(exitPath, JSON.stringify({ version: 1, pid: identity.pid, startedAt: identity.startedAt, projectRoot: identity.projectRoot, at: new Date().toISOString(), exitCode }), { flag: 'wx', mode: 0o600 }); } catch {}
    });
  }
  const server = createServer(socket => {
    socket.setTimeout(1500, () => socket.destroy());
    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 256) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      if (data.trim() !== token) { socket.destroy(); return; }
      socket.end(JSON.stringify(identity) + '\n');
    });
    socket.on('error', () => {});
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(pipe, done); });
  server.unref();
}
