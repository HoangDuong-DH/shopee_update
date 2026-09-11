import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createFolderReader } from '../../apps/web/src/folder-reader.js';
import type { ImportRecord } from '../../apps/web/src/api.js';

const record = (id: string, status = 'ready', content = id): ImportRecord => ({
  id,
  sha256: createHash('sha256').update(content).digest('hex'),
  filename: id + '.png',
  kind: 'image',
  status,
  bytes: Buffer.byteLength(content),
  createdAt: '',
  message: '',
  body: {},
});
function source(name: string, path: string) {
  const file = new File([name], name, { type: 'image/png' });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}
describe('whole-folder reader', () => {
  it('keeps original path and bytes, limits concurrency and reuses received files on retry', async () => {
    const uploads: string[] = [];
    let active = 0,
      max = 0;
    const reader = createFolderReader({
      request: async (_path, init) => {
        active++;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const bytes = await (init!.body as File).text();
        uploads.push(bytes);
        active--;
        return record(bytes) as never;
      },
      concurrency: 2,
    });
    const files = ['a.png', 'b.png', 'c.png'].map((n) => source(n, 'batch/listing/' + n));
    const first = await reader(files);
    const again = await reader(files);
    expect(first.map((f) => f.relativePath)).toEqual(files.map((f) => f.webkitRelativePath));
    expect(again).toEqual(first);
    expect(uploads.sort()).toEqual(['a.png', 'b.png', 'c.png']);
    expect(max).toBe(2);
  });
  it('returns a failed file separately and retries only that source', async () => {
    const counts: Record<string, number> = {};
    const reader = createFolderReader({
      request: async (_path, init) => {
        const name = (init!.body as File).name;
        counts[name] = (counts[name] ?? 0) + 1;
        if (name === 'b.png' && counts[name] === 1) throw new Error('Tạm mất kết nối');
        return record(name) as never;
      },
    });
    const files = [source('a.png', 'one/a.png'), source('b.png', 'two/b.png')];
    const first = await reader(files);
    expect(first[0].record?.status).toBe('ready');
    expect(first[1]).toMatchObject({ record: null, error: 'Tạm mất kết nối' });
    await reader(files);
    expect(counts).toEqual({ 'a.png': 1, 'b.png': 2 });
  });
  it('polls already received queued sources without uploading them again', async () => {
    let uploads = 0;
    const reader = createFolderReader({
      request: async (_path, init) => {
        if (init?.method === 'POST') {
          uploads++;
          return record('id', 'queued', 'queued.png') as never;
        }
        return record('id', 'ready', 'queued.png') as never;
      },
      pause: async () => {},
    });
    const output = await reader([source('queued.png', 'one/queued.png')]);
    expect(output[0].record?.status).toBe('ready');
    expect(uploads).toBe(1);
  });
  it('does not send unsupported files or merge different folders with identical filenames', async () => {
    let calls = 0;
    const reader = createFolderReader({
      request: async () => {
        calls++;
        return record('id', 'ready', 'same.png') as never;
      },
    });
    const output = await reader([
      source('unsupported.pdf', 'one/unsupported.pdf'),
      source('same.png', 'one/same.png'),
      source('same.png', 'two/same.png'),
    ]);
    expect(output[0].record).toBeNull();
    expect(output[0].error).toContain('chưa hỗ trợ');
    expect(output.slice(1).map((f) => f.relativePath)).toEqual(['one/same.png', 'two/same.png']);
    expect(calls).toBe(1);
  });
  it('reuses verified identical bytes under different filenames without losing the folder aliases', async () => {
    const existing = record('existing', 'ready', 'same original pixels');
    const reader = createFolderReader({
      known: () => [existing],
      request: async () => {
        throw new Error('Should reuse the verified local source');
      },
    });
    const files = ['one/bìa.png', 'two/ảnh gốc.png'].map((path) => {
      const file = new File(['same original pixels'], path.split('/').at(-1)!);
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    });
    const result = await reader(files);
    expect(result.map((item) => item.relativePath)).toEqual(
      files.map((file) => file.webkitRelativePath),
    );
    expect(
      result.every((item) => item.record?.id === existing.id && item.sha256 === existing.sha256),
    ).toBe(true);
    expect(existing.filename).toBe('existing.png');
  });
  it('rejects mismatched content, byte count, file kind or changed polling identity before using a source', async () => {
    for (const change of [{ sha256: 'different' }, { bytes: 999 }, { kind: 'docx' as const }]) {
      const reader = createFolderReader({
        request: async () => ({ ...record('one.png'), ...change }),
      });
      const [result] = await reader([source('one.png', 'one/one.png')]);
      expect(result.record).toBeNull();
      expect(result.error).toContain('chưa khớp tệp gốc');
    }
    const reader = createFolderReader({
      request: async (_path, init) =>
        init?.method === 'POST'
          ? record('initial', 'queued', 'one.png')
          : record('different-id', 'ready', 'one.png'),
    });
    const [result] = await reader([source('one.png', 'one/one.png')]);
    expect(result.record).toBeNull();
    expect(result.error).toContain('chưa khớp tệp gốc');
  });
});
