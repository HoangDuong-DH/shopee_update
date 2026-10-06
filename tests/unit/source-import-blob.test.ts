import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BlobStore } from '../../packages/persistence/src/blob-store.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'import-blob-'));
  directories.push(root);
  return new BlobStore(root);
}
it('rejects an oversized blob through its bounded read even when metadata underestimated it', async () => {
  const blobs = await store();
  const sha = await blobs.put(new Uint8Array(5000));
  await expect(blobs.read(sha, { maxBytes: 4096 })).rejects.toThrow('SOURCE_FILE_TOO_LARGE');
  expect((await blobs.read(sha)).byteLength).toBe(5000);
});
it('cancels before opening the blob and retains the original bytes', async () => {
  const blobs = await store();
  const sha = await blobs.put(new Uint8Array([1, 2]));
  const controller = new AbortController();
  controller.abort(Error('SOURCE_IMPORT_TIMEOUT'));
  await expect(blobs.read(sha, { signal: controller.signal, maxBytes: 10 })).rejects.toThrow(
    'SOURCE_IMPORT_TIMEOUT',
  );
  expect(await blobs.read(sha)).toEqual(Buffer.from([1, 2]));
});
it('keeps hash verification with streaming limits', async () => {
  const blobs = await store();
  const bytes = Buffer.from([1, 2]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(blobs.root, 'blobs', sha.slice(0, 2)), { recursive: true });
  await writeFile(join(blobs.root, 'blobs', sha.slice(0, 2), sha), Buffer.from([3, 4]));
  await expect(blobs.read(sha, { maxBytes: 10 })).rejects.toThrow('BLOB_HASH_MISMATCH');
});

it('keeps the original while cancelling a streamed read and closes the read handle', async () => {
  const blobs = await store();
  const sha = await blobs.put(new Uint8Array(8 * 1024 * 1024));
  const controller = new AbortController();
  const running = blobs.read(sha, { signal: controller.signal, maxBytes: 16 * 1024 * 1024 });
  const timer = setTimeout(() => controller.abort(Error('SOURCE_IMPORT_TIMEOUT')), 0);
  try {
    await expect(running).rejects.toThrow('SOURCE_IMPORT_TIMEOUT');
    expect((await blobs.read(sha, { maxBytes: 16 * 1024 * 1024 })).byteLength).toBe(
      8 * 1024 * 1024,
    );
  } finally {
    clearTimeout(timer);
  }
});
