import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
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
  async read(sha: string, options: { signal?: AbortSignal; maxBytes?: number } = {}) {
    options.signal?.throwIfAborted();
    if (options.maxBytes === undefined) {
      const bytes = await readFile(this.path(sha), { signal: options.signal });
      options.signal?.throwIfAborted();
      if (createHash('sha256').update(bytes).digest('hex') !== sha)
        throw new Error('BLOB_HASH_MISMATCH');
      return bytes;
    }
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes <= 0 ||
      options.maxBytes > 64 * 1024 * 1024
    )
      throw Error('INVALID_BLOB_READ_LIMIT');
    const stream = createReadStream(this.path(sha), {
      highWaterMark: 256 * 1024,
      signal: options.signal,
    });
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let total = 0;
    try {
      for await (const data of stream) {
        options.signal?.throwIfAborted();
        const chunk = data as Buffer;
        total += chunk.byteLength;
        if (total > options.maxBytes) throw Error('SOURCE_FILE_TOO_LARGE');
        hash.update(chunk);
        chunks.push(chunk);
      }
      options.signal?.throwIfAborted();
      if (hash.digest('hex') !== sha) throw Error('BLOB_HASH_MISMATCH');
      return Buffer.concat(chunks, total);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      stream.destroy();
    }
  }
}
