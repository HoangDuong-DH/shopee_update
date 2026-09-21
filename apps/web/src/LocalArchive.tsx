import { useRef, useState } from 'react';
import { Archive, ArchiveRestore } from 'lucide-react';
import { api } from './api.js';
import './local-archive.css';

export type LocalArchiveKind = 'catalog_listing' | 'input_batch' | 'product' | 'pricebook';
export type Lifecycle = 'active' | 'archived';
export type ArchiveFlags = { archived?: boolean; archivedAt?: string | null };

export function LifecycleFilter({ value, onChange, disabled = false }: {
  value: Lifecycle; onChange: (value: Lifecycle) => void; disabled?: boolean;
}) {
  return <label className="local-lifecycle-filter">Hiển thị
    <select aria-label="Trạng thái lưu trữ" value={value} disabled={disabled}
      onChange={(event) => onChange(event.target.value as Lifecycle)}>
      <option value="active">Đang sử dụng</option>
      <option value="archived">Đã lưu trữ</option>
    </select>
  </label>;
}

export function ArchiveAction({ kind, resourceId, name, archived = false, disabled = false, onChanged }: {
  kind: LocalArchiveKind; resourceId: string; name: string; archived?: boolean;
  disabled?: boolean; onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = archived ? 'Khôi phục' : 'Lưu trữ';
  async function save() {
    if (sending.current || disabled) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await api('/v1/local-archives', { method: 'POST', body: JSON.stringify({ kind, resourceId, archived: !archived }) });
      setConfirming(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa lưu được lựa chọn. Thử lại.');
    } finally { sending.current = false; setBusy(false); }
  }
  return <div className="local-archive-action">
    <button type="button" ref={trigger} disabled={disabled || busy}
      aria-label={`${label}: ${name}`} aria-expanded={confirming}
      onClick={() => { setError(''); setConfirming(true); }}>
      {archived ? <ArchiveRestore size={16} /> : <Archive size={16} />} {label}
    </button>
    {confirming && <div className="local-archive-confirm" role="group" aria-label={`${label} ${name}`}>
      <strong>{name}</strong>
      <p>{archived
        ? 'Đưa mục này trở lại danh sách đang sử dụng.'
        : 'Ẩn mục này khỏi danh sách đang sử dụng. Bạn có thể khôi phục ở mục Đã lưu trữ.'}</p>
      <p className="caption">Chỉ áp dụng trong ứng dụng. Giữ nguyên tệp nguồn, lịch sử và sản phẩm trên Shopee.</p>
      {error && <p role="alert" className="local-archive-error">{error}</p>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => { setConfirming(false); trigger.current?.focus(); }}>Hủy</button>
        <button type="button" disabled={busy || disabled} onClick={() => void save()}>{busy ? 'Đang lưu…' : `Xác nhận ${label.toLocaleLowerCase('vi')}`}</button>
      </div>
    </div>}
  </div>;
}
