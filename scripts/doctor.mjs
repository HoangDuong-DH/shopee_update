import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      nodeTarget: 24,
      gitRepository: git.status === 0,
      dockerServer: docker.status === 0 ? docker.stdout.trim() : 'unavailable',
      environmentConfigured: existsSync('.env'),
      sourceKnowledgePresent: existsSync('knowledge-base/shopee-open-platform/AGENT_GUIDE.md'),
    },
    null,
    2,
  ),
);
if (Number(process.versions.node.split('.')[0]) !== 24) process.exitCode = 1;
