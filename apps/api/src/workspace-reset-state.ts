import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
const schema = z.object({ id: z.string(), archiveSchema: z.string(), createdAt: z.string(), hiddenBatchIds: z.array(z.string()), hiddenPreparationIds: z.array(z.string()) });
export async function workspaceResetState() {
  try { return schema.parse(JSON.parse(await readFile(resolve('.local/workspace-reset.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
