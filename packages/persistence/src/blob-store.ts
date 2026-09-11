import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
export class BlobStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(sha: string) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('INVALID_BLOB_HASH');
    return join(this.root, 'blobs', sha.slice(0, 2), sha);
  }
  async put(bytes: Uint8Array) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const path = this.path(sha),
      directory = join(this.root, 'blobs', sha.slice(0, 2));
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, randomUUID() + '.pending');
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      try {
        await link(temporary, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const old = await this.read(sha);
        if (old.length !== bytes.length) throw new Error('BLOB_HASH_MISMATCH');
      }
    } finally {
      await unlink(temporary).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      });
    }
    return sha;
  }
  async read(sha: string) {
    const bytes = await readFile(this.path(sha));
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new Error('BLOB_HASH_MISMATCH');
    return bytes;
  }
}
