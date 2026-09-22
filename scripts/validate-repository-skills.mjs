import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve('skills');
const names = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!names.length) throw new Error('No repository skills found.');

for (const folder of names) {
  if (!/^[a-z0-9-]{1,64}$/.test(folder)) throw new Error(`Invalid skill folder: ${folder}`);
  const skillPath = join(root, folder, 'SKILL.md');
  const text = await readFile(skillPath, 'utf8');
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!frontmatter) throw new Error(`Missing frontmatter: ${skillPath}`);
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== folder) throw new Error(`Skill name does not match folder: ${skillPath}`);
  if (!description || description.includes('TODO'))
    throw new Error(`Missing skill description: ${skillPath}`);
  if (text.includes('[TODO:')) throw new Error(`Unfinished scaffold: ${skillPath}`);

  const openaiPath = join(root, folder, 'agents', 'openai.yaml');
  const openai = await readFile(openaiPath, 'utf8');
  const short = openai.match(/^\s*short_description:\s*["']([^"']+)["']/m)?.[1] ?? '';
  if (short.length < 25 || short.length > 64)
    throw new Error(`Invalid short_description: ${openaiPath}`);
  if (!openai.includes(`$${folder}`)) throw new Error(`Default prompt must mention $${folder}`);

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|#)/.test(target)) continue;
    await access(resolve(dirname(skillPath), target));
  }
}

console.log(`Validated ${names.length} repository skills: ${names.join(', ')}`);
