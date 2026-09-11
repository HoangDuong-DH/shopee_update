import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BlobStore } from '../../packages/persistence/src/blob-store.js';
it('publishes a blob atomically under concurrent imports and detects changed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shopee-blob-test-'));
  const store = new BlobStore(root),
    bytes = Buffer.alloc(1024 * 1024, 42);
  try {
    const hashes = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes)));
    expect(new Set(hashes).size).toBe(1);
    expect((await store.read(hashes[0])).equals(bytes)).toBe(true);
    await writeFile(join(root, 'blobs', hashes[0].slice(0, 2), hashes[0]), 'changed');
    await expect(store.read(hashes[0])).rejects.toThrow('BLOB_HASH_MISMATCH');
  } finally {
    if (root.startsWith(join(tmpdir(), 'shopee-blob-test-')))
      await rm(root, { recursive: true, force: true });
  }
});
