import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../../apps/web/src/api.js';
import { folderBulkDraftMatches, mergeFolderBulkEntries, readFolderBulkRecovery, readyFolderBulkEntries, runFolderBulkSave, type FolderBulkEntry } from '../../apps/web/src/folder-bulk-save.js';

const id = '11111111-1111-4111-8111-111111111111';
const batch: any = { id, revision: 4, state: {} };
function assembly(key = 'spray'): any {
  return { key, productKey: key, name: key, issues: [], manifest: { product: { productKey: key, sourceRevision: 0 } },
    seed: { productKey: key, expectedRevision: 0, sourceListingId: null, title: 'Xịt ' + key,
      headline: 'Mở đầu tay', body: 'Nội dung giữ nguyên', coverId: id, galleryIds: [id], descriptionImageIds: [],
      tierNames: ['Mùi', 'Dung tích'], variants: [{ importId: id, rowKey: 'exact-row', optionLabels: ['Cam Sả', '100ml'], imageId: id }] } };
}
const entries = () => readyFolderBulkEntries([assembly('one'), assembly('two')], batch, []);
function draft(entry: FolderBulkEntry): any {
  const { productKey, expectedRevision: _revision, ...sourceSelection } = structuredClone(entry.request);
  return { productKey, revision: 1, sourceSelection };
}
function port() {
  const reads = vi.fn(async () => batch), saves = vi.fn(async (request: any) => draft({ request } as FolderBulkEntry));
  const checkpoints: FolderBulkEntry[][] = [];
  return { readBatch: reads, readProduct: vi.fn(async (): Promise<any> => { throw new RequestError('missing', 'NOT_FOUND', 404); }), save: saves,
    checkpoint: (rows: FolderBulkEntry[]) => { checkpoints.push(rows); }, checkpoints, onSaved: vi.fn() };
}

describe('folder bulk local draft saves', () => {
  it('includes only ready portable new sources, skips saved/blocked/manual/revisioned/duplicate identities', () => {
    const blocked = assembly('blocked'); blocked.issues = [{ severity: 'block' }];
    const manual = assembly('manual'); delete manual.manifest;
    const revisioned = assembly('revisioned'); revisioned.manifest.product.sourceRevision = 1;
    const values = readyFolderBulkEntries([assembly(), assembly('existing'), blocked, manual, revisioned, assembly('dupe'), assembly('dupe')], batch, [{ productKey: 'existing' } as any]);
    expect(values.map(x => x.request.productKey)).toEqual(['spray']);
    expect(values[0].request.folderBinding).toEqual({ batchId: id, revision: 4, groupKey: 'spray' });
    expect(values[0].request.variants[0]).toMatchObject({ rowKey: 'exact-row', optionLabels: ['Cam Sả', '100ml'], imageId: id });
  });
  it('uses exact immutable content and images; saves siblings sequentially and records every result', async () => {
    const initial = entries(), options = port();
    const result = await runFolderBulkSave(initial, options);
    expect(result.map(x => x.status)).toEqual(['saved', 'saved']);
    expect(options.save.mock.calls.map(([request]) => request)).toEqual(initial.map(x => x.request));
    expect(options.readBatch).toHaveBeenCalledTimes(2);
    expect(options.onSaved).toHaveBeenCalledTimes(2);
    expect(initial.every(x => x.status === 'queued')).toBe(true);
  });
  it('stops after an unknown result, retains original request, and recovers a committed draft without reposting it', async () => {
    const initial = entries(), options = port();
    options.save.mockRejectedValueOnce(new TypeError('network lost'));
    const held = await runFolderBulkSave(initial, options);
    expect(held.map(x => x.status)).toEqual(['uncertain', 'queued']);
    expect(options.save).toHaveBeenCalledTimes(1);
    const recovery = readFolderBulkRecovery(JSON.stringify({ version: 1, batchId: id, entries: held }), id);
    const resumed = port(); resumed.readProduct.mockResolvedValueOnce(draft(initial[0]));
    const done = await runFolderBulkSave(recovery, resumed);
    expect(done.map(x => x.status)).toEqual(['saved', 'saved']);
    expect(resumed.save.mock.calls.map(([request]) => request.productKey)).toEqual(['two']);
  });
  it('replays exactly the same request only after a missing product readback and current batch revision', async () => {
    const held = entries(); held[0].status = 'uncertain'; held[1].status = 'saved';
    const changed = structuredClone(held[0]); changed.request.body = 'new text';
    const merged = mergeFolderBulkEntries(held, [changed]);
    expect(merged[0].request.body).toBe('Nội dung giữ nguyên');
    const options = port(); await runFolderBulkSave(merged, options);
    expect(options.readProduct).toHaveBeenCalledWith('one');
    expect(options.save.mock.calls[0][0]).toEqual(held[0].request);
    expect(options.save).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite a conflicting existing draft during recovery', async () => {
    const held = entries().slice(0, 1); held[0].status = 'uncertain';
    const options = port(), existing = draft(held[0]); existing.sourceSelection.body = 'Other source';
    options.readProduct.mockResolvedValue(existing);
    const result = await runFolderBulkSave(held, options);
    expect(result[0].status).toBe('failed'); expect(options.save).not.toHaveBeenCalled();
  });
  it('fails closed if the saved input batch changed; does not send stale bindings', async () => {
    const options = port(); options.readBatch.mockResolvedValue({ ...batch, revision: 5 });
    const result = await runFolderBulkSave(entries(), options);
    expect(result.every(x => x.status === 'failed')).toBe(true); expect(options.save).not.toHaveBeenCalled();
  });
  it('continues independent siblings after a definite validation rejection', async () => {
    const options = port(); options.save.mockRejectedValueOnce(new RequestError('Image invalid', 'PENDING_SOURCE_IMAGE_INVALID', 409));
    const result = await runFolderBulkSave(entries(), options);
    expect(result.map(x => x.status)).toEqual(['failed', 'saved']);
  });
  it('persists the saving marker before POST and refuses to write without recovery storage', async () => {
    const options = port(); options.checkpoint = () => { throw Error('Quota exceeded'); };
    await expect(runFolderBulkSave(entries(), options)).rejects.toThrow('Quota exceeded');
    expect(options.save).not.toHaveBeenCalled();
    const recovery = entries(); recovery[0].status = 'saving';
    expect(readFolderBulkRecovery(JSON.stringify({ version: 1, batchId: id, entries: recovery }), id)[0].status).toBe('uncertain');
  });
  it('rejects wrong-batch recovery and misleading saved responses', () => {
    expect(() => readFolderBulkRecovery(JSON.stringify({ version: 1, batchId: id, entries: entries() }), 'different')).toThrow();
    const entry = entries()[0], wrong = draft(entry); wrong.productKey = 'other';
    expect(folderBulkDraftMatches(wrong, entry.request)).toBe(false);
    const changed = draft(entry); changed.sourceSelection.variants[0].imageId = '22222222-2222-4222-8222-222222222222';
    expect(folderBulkDraftMatches(changed, entry.request)).toBe(false);
  });
});
