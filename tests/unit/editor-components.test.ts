import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImagePicker } from '../../apps/web/src/ImagePicker.js';
import { Preview } from '../../apps/web/src/Preview.js';
import { fixtureDraft } from '../helpers/fixtures.js';
import { Editor } from '../../apps/web/src/Editor.js';
import { editorRecoveryKey, makeEditorRecovery } from '../../apps/web/src/editor-recovery.js';

const id = '22222222-2222-4222-8222-222222222222';
const image = { id, sha256: 'a'.repeat(64), filename: 'Bộ nguồn/ảnh đã chọn.png', kind: 'image' as const, status: 'ready', bytes: 300, createdAt: '2026-10-01T00:00:00Z', message: '' };
afterEach(() => vi.unstubAllGlobals());
describe('scope and recovery affordances', () => {
  it('shows existing images with a clear next action while an unknown source disables choosing replacements', () => {
    const html = renderToStaticMarkup(createElement(ImagePicker, { title: 'Ảnh bìa', images: [image], selectedIds: [id], editable: true, single: true, sourceImportIds: null, onChange: () => {} }));
    expect(html).toContain('/v1/media/' + id);
    expect(html).toContain('Chưa xác định được đúng bộ nguồn');
    expect(html).not.toContain('>Đổi ảnh<');
  });
  it('makes the selected file’s actual provenance visible instead of describing the global image library as this source', () => {
    const html = renderToStaticMarkup(createElement(ImagePicker, { title: 'Ảnh bìa', images: [image], selectedIds: [id], editable: true, single: true, sourceImportIds: [id], onChange: () => {} }));
    expect(html).toContain('SHA-256'); expect(html).toContain('a'.repeat(64));
    expect(html).toContain('Bộ nguồn/ảnh đã chọn.png');
  });
  it('holds the production continuation until an explicit production shop is chosen', () => {
    const html = renderToStaticMarkup(createElement(Preview, { draft: fixtureDraft(), shops: [], onEdit: () => {}, onPlan: () => {}, onProduction: () => {} }));
    expect(html).toMatch(/disabled=""[^>]*>[^<]*Mở đợt đăng qua API/);
    expect(html).toContain('Chọn shop để tiếp tục');
  });
});

describe('editor recovery on opening a source', () => {
  const seed = { productKey: 'qa-editor-reload', expectedRevision: 2, title: 'Nguồn hiện tại', headline: 'Mở đầu nguồn', body: 'Nội dung nguồn', galleryIds: [], descriptionImageIds: [], tierNames: [], variants: [{ importId: '11111111-1111-4111-8111-111111111111', rowKey: 'row-a', optionLabels: [] }] };
  function storage(value: string) {
    const data = new Map([[editorRecoveryKey(seed.productKey, 2), value]]);
    vi.stubGlobal('window', {}); vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, length: data.size, key: (index: number) => [...data.keys()][index] ?? null });
  }
  it('opens the exact revision’s working copy with its typed content visible', () => {
    storage(JSON.stringify(makeEditorRecovery(seed, { form: { ...seed, title: 'Chữ đang sửa chưa lưu', body: ' Giữ\nnguyên văn ' }, layout: 'headline-images-body', section: 'content', sourceImportIds: [] })));
    const html = renderToStaticMarkup(createElement(Editor, { seed, imports: [], onSaved: () => {}, onCancel: () => {}, sourceImportIds: [] }));
    expect(html).toContain('value="Chữ đang sửa chưa lưu"'); expect(html).toContain(' Giữ\nnguyên văn ');
    expect(html).toContain('Đã khôi phục phần đang sửa');
  });
  it('shows a stale copy separately and keeps the newer source in the editable form', () => {
    storage(JSON.stringify(makeEditorRecovery(seed, { form: { ...seed, title: 'Chữ của bản cũ' }, layout: 'headline-images-body', section: 'content', sourceImportIds: [] })));
    const html = renderToStaticMarkup(createElement(Editor, { seed: { ...seed, expectedRevision: 3, title: 'Nguồn phiên bản mới' }, imports: [], onSaved: () => {}, onCancel: () => {}, sourceImportIds: [] }));
    expect(html).toContain('value="Nguồn phiên bản mới"'); expect(html).toContain('Phần sửa đã giữ riêng từ bản nguồn 2');
    expect(html).toContain('value="Chữ của bản cũ"');
  });
});
