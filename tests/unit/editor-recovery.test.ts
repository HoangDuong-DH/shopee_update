import { describe, expect, it } from 'vitest';
import type { ListingDraft } from '@shopee/domain';
import { fixtureDraft } from '../helpers/fixtures.js';
import {
  buildEditorPayload, editorRecoveryKey, makeEditorRecovery, readEditorRecovery, writeEditorRecovery,
  findEditorRecoveries, compareEditorSaveResult, type EditorRecoveryStorage, type EditorRecovery,
} from '../../apps/web/src/editor-recovery.js';

const seed = {
  productKey: 'source-qa', expectedRevision: 2, title: 'Tiêu đề nguồn', headline: 'Mở đầu', body: 'Nội dung\nnguyên văn',
  galleryIds: [] as string[], descriptionImageIds: [] as string[], tierNames: ['Loại'],
  variants: [{ importId: '11111111-1111-4111-8111-111111111111', rowKey: 'row-a', optionLabels: [' Nguyên  văn '] }],
};
function copy(): EditorRecovery {
  return makeEditorRecovery(seed, {
    form: { ...seed, title: 'Chữ vừa sửa', body: ' Giữ\nđúng khoảng trắng ' }, layout: 'headline-images-body', section: 'content', sourceImportIds: [seed.variants[0]!.importId],
    pending: { payload: { ...seed, title: 'Chữ vừa sửa' }, variants: [{ sku: 'SKU-EXACT', originalPrice: '12345' }], sourceFiles: [], submittedAt: '2026-10-01T00:00:00Z' },
  });
}
class Storage implements EditorRecoveryStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
function saved(): ListingDraft {
  const value = fixtureDraft(); value.productKey = seed.productKey; value.revision = 3;
  const { productKey: _, expectedRevision: __, ...selection } = { ...seed, title: 'Chữ vừa sửa' };
  value.sourceSelection = structuredClone(selection); value.tierNames = ['Loại']; value.coverKey = ''; value.galleryKeys = [];
  value.title.value = 'Chữ vừa sửa';
  value.description = [{ type: 'text', text: 'Mở đầu\n\n' }, { type: 'text', text: '\n\nNội dung\nnguyên văn' }];
  value.variants = [{ ...value.variants[0]!, sku: { ...value.variants[0]!.sku, value: 'SKU-EXACT' }, originalPrice: { ...value.variants[0]!.originalPrice, value: '12345' }, optionLabels: [' Nguyên  văn '], imageKey: undefined }];
  return value;
}

describe('durable revision-bound editor recovery', () => {
  it('restores text and pending payload after storage reload without altering whitespace or source bindings', () => {
    const storage = new Storage(); expect(writeEditorRecovery(storage, copy())).toBe(true);
    const result = readEditorRecovery(storage.getItem(editorRecoveryKey('source-qa', 2)), seed);
    expect(result.state).toBe('restored');
    expect(result.copy?.form.body).toBe(' Giữ\nđúng khoảng trắng ');
    expect(result.copy?.pending?.payload.body).toBe('Nội dung\nnguyên văn');
    expect(result.copy?.form.variants[0]?.optionLabels).toEqual([' Nguyên  văn ']);
  });
  it('keeps old revision copies separate instead of applying their fields to a newer source', () => {
    expect(readEditorRecovery(JSON.stringify(copy()), { ...seed, expectedRevision: 3 }).state).toBe('stale');
    expect(readEditorRecovery(JSON.stringify(copy()), { ...seed, body: 'Nguồn đã khác' }).state).toBe('stale');
    expect(editorRecoveryKey('source-qa', 2)).not.toBe(editorRecoveryKey('source-qa', 3));
  });
  it('retains only this product’s copies for deliberate conflict review', () => {
    const storage = new Storage(); writeEditorRecovery(storage, copy());
    writeEditorRecovery(storage, makeEditorRecovery({ ...seed, productKey: 'another' }, { form: { ...seed, productKey: 'another' }, layout: '', section: 'content', sourceImportIds: null }));
    expect(findEditorRecoveries(storage, 'source-qa').map(value => value.expectedRevision)).toEqual([2]);
  });
  it('does not serialize secrets, approval receipts or unknown form properties', () => {
    const payload = buildEditorPayload(seed, { ...seed, partnerKey: 'must-not-persist', mappingConfirmation: { kind: 'user_decision', fileSha256: 'fake', locator: 'fake', observedAt: 'fake' } } as typeof seed);
    expect(payload).not.toHaveProperty('partnerKey'); expect(payload).not.toHaveProperty('mappingConfirmation');
    expect(payload.variants[0]?.rowKey).toBe('row-a');
  });
  it('reports quota failure and rejects damaged storage instead of claiming a durable save', () => {
    const storage = new Storage(); storage.setItem = () => { throw Error('QuotaExceeded'); };
    expect(writeEditorRecovery(storage, copy())).toBe(false);
    expect(readEditorRecovery('{broken', seed).state).toBe('invalid');
    expect(readEditorRecovery(JSON.stringify({ ...copy(), productKey: 'another' }), seed).state).toBe('invalid');
  });
  it('freezes the pending exact request even if the editable form subsequently changes', () => {
    const form = { ...seed, title: 'Chữ trước gửi' }; const value = makeEditorRecovery(seed, { form, layout: '', section: 'content', sourceImportIds: null, pending: { payload: form, variants: [], sourceFiles: [], submittedAt: '2026-10-01T00:00:00Z' } });
    form.title = 'Chữ sau gửi';
    expect(value.pending?.payload.title).toBe('Chữ trước gửi');
  });
});

describe('local save acknowledgement after response loss', () => {
  it('accepts only the exact product, next revision, source selection and expected integer SKU prices', () => {
    expect(compareEditorSaveResult(copy().pending!, saved()).state).toBe('saved');
  });
  it.each(['price', 'options', 'images', 'source-row', 'revision', 'title', 'body'] as const)('keeps a differing %s out of the saved state', field => {
    const value = saved();
    if (field === 'price') value.variants[0]!.originalPrice.value = '12344';
    if (field === 'options') value.variants[0]!.optionLabels = ['Nguyên văn'];
    if (field === 'images') value.galleryKeys = ['another-image'];
    if (field === 'source-row') value.sourceSelection!.variants[0]!.rowKey = 'another-row';
    if (field === 'revision') value.revision = 4;
    if (field === 'title') value.title.value = 'Nội dung khác payload';
    if (field === 'body') value.description = [{ type: 'text', text: 'Bị mất nội dung' }];
    expect(compareEditorSaveResult(copy().pending!, value).state).toBe('conflict');
  });
  it('does not infer source prices when an old pending request lacks its expected SKU price snapshot', () => {
    const pending = copy().pending!; pending.variants = [];
    expect(compareEditorSaveResult(pending, saved()).state).toBe('unknown');
  });
  it('does not acknowledge selected media without the exact original file evidence in the local readback', () => {
    const pending = copy().pending!, value = saved(), imageId = '22222222-2222-4222-8222-222222222222';
    pending.payload.coverId = imageId; pending.sourceFiles = [{ id: imageId, sha256: 'a'.repeat(64) }];
    value.sourceSelection!.coverId = imageId; value.coverKey = imageId;
    expect(compareEditorSaveResult(pending, value).state).toBe('unknown');
    value.assets = [{ key: imageId, sha256: 'a'.repeat(64), bytes: 80, width: 1, height: 1, mime: 'image/png',
      source: { kind: 'product_file', fileSha256: 'a'.repeat(64), locator: 'Bộ nguồn/ảnh bìa.png', observedAt: '2026-10-01T00:00:00Z' } }];
    expect(compareEditorSaveResult(pending, value).state).toBe('saved');
    value.assets[0]!.sha256 = 'b'.repeat(64);
    expect(compareEditorSaveResult(pending, value).state).toBe('conflict');
  });
  it('does not acknowledge selected media when the pending request lacks its original SHA', () => {
    const pending = copy().pending!, value = saved(), imageId = '22222222-2222-4222-8222-222222222222';
    pending.payload.coverId = imageId; value.sourceSelection!.coverId = imageId; value.coverKey = imageId;
    expect(compareEditorSaveResult(pending, value).state).toBe('unknown');
  });
  it('reports an unchanged base as retryable without marking it saved or sending anything', () => {
    const value = saved(); value.revision = 2;
    expect(compareEditorSaveResult(copy().pending!, value).state).toBe('unchanged');
  });
  it('rejects another product and malformed local responses without changing the selected source', () => {
    expect(compareEditorSaveResult(copy().pending!, { ...saved(), productKey: 'another' }).state).toBe('unknown');
    expect(compareEditorSaveResult(copy().pending!, { productKey: seed.productKey, revision: 3 } as ListingDraft).state).toBe('unknown');
  });
});
