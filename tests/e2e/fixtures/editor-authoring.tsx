import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from '../../../apps/web/src/Editor.js';
import { ImagePicker } from '../../../apps/web/src/ImagePicker.js';
import { Preview, type PreviewContinuation } from '../../../apps/web/src/Preview.js';
import { ProductionPreparation } from '../../../apps/web/src/ProductionPreparation.js';
import { ProductionConnectionForm } from '../../../apps/web/src/ProductionConnectionForm.js';
import { seed, imports, sourceIds, variants, shops, galleryId, draftFromPayload } from './editor-authoring-data.js';
import type { ListingDraft } from '@shopee/domain';
import '../../../apps/web/src/style.css';

function Fixture() {
  const query = new URLSearchParams(location.search), component = query.get('component') ?? 'editor';
  const revision = Number(query.get('revision') ?? seed.expectedRevision), scope = query.get('scope') === 'unknown' ? null : sourceIds;
  const [selected, setSelected] = useState([galleryId]), [saved, setSaved] = useState<ListingDraft | null>(null), [continuation, setContinuation] = useState<PreviewContinuation | null>(null);
  const current = { ...seed, expectedRevision: revision, ...(revision === 3 ? { title: 'Nguồn phiên bản mới · TEST' } : {}),
    ...(query.has('folder') ? { folderBinding: { batchId: '77777777-7777-4777-8777-777777777777', revision: 1, groupKey: 'TEST/Bộ riêng' } } : {}) };
  const [previewDraft, setPreviewDraft] = useState(() => draftFromPayload(current, revision));
  const [connectedCount, setConnectedCount] = useState(0);
  return <main style={{ padding: 'clamp(12px, 3vw, 40px)', maxWidth: 1240, margin: '0 auto', minWidth: 0 }}>
    <p className="caption">Phiên thử component riêng · không kết nối Shopee</p>
    {component === 'editor' && <Editor key={revision} seed={current} imports={query.has('emptyImports') ? [] : imports} variantSummaries={variants}
      sourceImportIds={scope} onSaved={setSaved} onCancel={() => {}} onOpenLatest={draft => setContinuation({ productKey: draft.productKey, revision: draft.revision, shopConnectionId: null })} />}
    {component === 'images' && <ImagePicker title="Ảnh sản phẩm" images={imports} selectedIds={selected} editable sourceImportIds={scope} onChange={setSelected} />}
    {component === 'preview' && <Preview draft={previewDraft} shops={query.has('missingShop') ? [] : shops} selectedShopConnectionId={query.get('selectedShop')}
      onEdit={() => {}} onPlan={() => {}} onProduction={setContinuation} onMappingConfirmed={setPreviewDraft} />}
    {component === 'preview' && query.has('switchPreview') && <button type="button" onClick={() => setPreviewDraft(draftFromPayload(current, revision + 1))}>Chuyển bản nguồn thử mới</button>}
    {component === 'preparation' && <ProductionPreparation targetScope={{ environment: 'production', partnerId: 'FIXTURE-PARTNER', shopId: 'FIXTURE-SHOP' }}
      targetShopName="Shop thử giao diện" initialProductKey={seed.productKey} initialSourceRevision={revision} onSource={() => {}} onFolders={() => {}} onRegistered={() => {}} />}
    {component === 'authorization' && <ProductionConnectionForm initialScope={{ partnerId: query.get('partnerId') ?? '', shopId: query.get('connectShop') ?? '' }}
      onConnected={() => setConnectedCount(count => count + 1)} />}
    {component === 'authorization' && <output data-testid="authorization-connected-count">{connectedCount}</output>}
    {saved && <div role="status">Đã nhận đúng bản nguồn {saved.revision} trong ứng dụng.<output data-testid="saved-result">{JSON.stringify(saved)}</output></div>}
    {continuation && <output data-testid="continuation-result">{JSON.stringify(continuation)}</output>}
    {component === 'images' && <output data-testid="image-selection">{JSON.stringify(selected)}</output>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
