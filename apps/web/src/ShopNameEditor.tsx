import { useEffect, useState } from 'react';
import type { ShopConnection } from '@shopee/domain';
import { api } from './api.js';

export function ShopNameEditor({
  shop,
  onSaved,
}: {
  shop: ShopConnection;
  onSaved: () => void | Promise<void>;
}) {
  const [editor, setEditor] = useState({
    value: shop.displayName ?? '',
    saved: shop.displayName ?? '',
    revision: shop.nameRevision ?? 0,
  });
  const value = editor.value;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setEditor((current) =>
      current.value.trim() === current.saved
        ? {
            value: shop.displayName ?? '',
            saved: shop.displayName ?? '',
            revision: shop.nameRevision ?? 0,
          }
        : current,
    );
  }, [shop.id, shop.nameRevision, shop.displayName]);
  const changed = value.trim() !== editor.saved;
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const saved = await api<ShopConnection>(
        `/v1/connections/${encodeURIComponent(shop.id)}/display-name`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            displayName: value.trim() || null,
            expectedNameRevision: editor.revision,
          }),
        },
      );
      setEditor({
        value: saved.displayName ?? '',
        saved: saved.displayName ?? '',
        revision: saved.nameRevision ?? 0,
      });
      setMessage(
        value.trim() ? 'Đã lưu tên gợi nhớ trong ứng dụng.' : 'Đã dùng lại tên shop trên Shopee.',
      );
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Chưa lưu được tên gợi nhớ.');
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      const latest = (await api<ShopConnection[]>('/v1/shops')).find(
        (entry) => entry.id === shop.id,
      );
      if (!latest) throw new Error('Không tìm thấy kết nối shop này.');
      setEditor({
        value: latest.displayName ?? '',
        saved: latest.displayName ?? '',
        revision: latest.nameRevision ?? 0,
      });
      setMessage('Đã tải tên gợi nhớ mới nhất.');
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Chưa tải lại được tên.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={`shop-name-${shop.id}`}>Tên gợi nhớ trong ứng dụng</label>
      <input
        id={`shop-name-${shop.id}`}
        value={value}
        maxLength={120}
        disabled={busy}
        placeholder={shop.officialName ?? shop.name}
        onChange={(event) => setEditor((current) => ({ ...current, value: event.target.value }))}
      />
      <p className="caption">
        Tên trên Shopee: {shop.officialName ?? shop.name}. Để trống để dùng tên này.
      </p>
      <div className="actions">
        <button type="submit" disabled={busy || !changed}>
          {busy ? 'Đang lưu tên…' : 'Lưu tên gợi nhớ'}
        </button>
        <button type="button" disabled={busy} onClick={() => void reload()}>
          Tải lại tên đã lưu
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
