import { useEffect, useState } from 'react';
import { api, post } from './api.js';
import './image-quality.css';
type Case = {
  id: string;
  fingerprint: string;
  binding: {
    environment: string;
    shopId: string;
    itemId: string;
    role: string;
    position: number;
    [key: string]: unknown;
  };
  state: string;
  expired: boolean;
  sourceSha256: string;
  outputSha256: string;
  comparison: { state: string; reason: string };
  result: { verificationBasis?: string };
  review?: { reviewer?: string; note?: string };
};
const roles: Record<string, string> = {
  cover: 'Ảnh bìa',
  gallery: 'Ảnh sản phẩm',
  description: 'Ảnh mô tả',
  variation: 'Ảnh phân loại',
};
const status = (row: Case) =>
  row.expired
    ? 'Phiếu đã hết hạn'
    : row.state === 'review_required'
      ? 'Cần đối chiếu ảnh'
      : row.state === 'mismatch'
        ? 'Ảnh không khớp'
        : row.state === 'rejected'
          ? 'Đã từ chối'
          : row.state === 'verified'
            ? row.result?.verificationBasis === 'manual_review'
              ? 'Đạt qua đối chiếu'
              : 'Khớp dữ liệu ảnh'
            : 'Chưa xác định';
export function ImageQuality() {
  const [rows, setRows] = useState<Case[]>([]),
    [selected, setSelected] = useState<Case | null>(null),
    [reviewer, setReviewer] = useState(''),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    try {
      setRows(await api<Case[]>('/v1/image-qc'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function open(id: string) {
    setBusy(true);
    setError('');
    try {
      setSelected(await api<Case>('/v1/image-qc/' + id));
      setNote('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review(decision: 'accept_lossy_match' | 'reject') {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await post('/v1/image-qc/' + selected.id + '/review', {
        requestId: crypto.randomUUID(),
        expectedFingerprint: selected.fingerprint,
        binding: selected.binding,
        decision,
        reviewer: reviewer.trim(),
        note: note.trim(),
      });
      await open(selected.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="image-quality">
      <div className="page-heading">
        <div>
          <h1>Kiểm tra ảnh sau khi gửi</h1>
          <p>Đối chiếu ảnh gốc với ảnh Shopee trả về, đúng listing và vị trí.</p>
        </div>
        <button onClick={() => void load()} disabled={busy}>
          Tải lại danh sách
        </button>
      </div>
      <p className="image-qc-help">
        Khớp dữ liệu ảnh được kiểm tự động. Ảnh bị nén hoặc đổi kích thước cần xem rõ sản phẩm, chữ,
        số lượng và phần mép ảnh. Lưu nhận xét chỉ cập nhật phiếu kiểm tra trong ứng dụng.
      </p>
      {error && <p role="alert">{error}</p>}
      {!rows.length && (
        <p>Chưa có phiếu kiểm ảnh. Phiếu được tạo khi có đủ ảnh nguồn và ảnh đọc lại từ Shopee.</p>
      )}
      <div className="image-qc-layout">
        <div className="image-qc-list">
          {rows.map((row) => (
            <button
              key={row.id}
              aria-pressed={selected?.id === row.id}
              onClick={() => void open(row.id)}
              disabled={busy}
            >
              <strong>
                {roles[row.binding.role] ?? row.binding.role} · {row.binding.position + 1}
              </strong>
              <span>
                {row.binding.environment === 'sandbox' ? 'Shop thử nghiệm' : 'Shop'}{' '}
                {row.binding.shopId} · Listing {row.binding.itemId}
              </span>
              <span>{status(row)}</span>
            </button>
          ))}
        </div>
        {selected && (
          <article className="image-qc-detail">
            <h2>
              {roles[selected.binding.role]} · Listing {selected.binding.itemId}
            </h2>
            <p>{status(selected)}</p>
            <div className="image-qc-pair">
              {(['source', 'output'] as const).map((side) => (
                <figure key={side}>
                  <figcaption>
                    {side === 'source' ? 'Ảnh nguồn trước thay đổi' : 'Ảnh đọc lại từ Shopee'}
                  </figcaption>
                  <a
                    href={'/v1/image-qc/' + selected.id + '/image/' + side}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      src={'/v1/image-qc/' + selected.id + '/image/' + side}
                      alt={side === 'source' ? 'Ảnh nguồn để đối chiếu' : 'Ảnh kết quả trên Shopee'}
                    />
                  </a>
                  <small>Bấm ảnh để xem đầy đủ ở tab riêng.</small>
                </figure>
              ))}
            </div>
            {selected.state === 'review_required' && !selected.expired ? (
              <div className="image-qc-review">
                <label>
                  Người đối chiếu
                  <input
                    value={reviewer}
                    onChange={(e) => setReviewer(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <label>
                  Nhận xét cụ thể
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    placeholder="Đã kiểm tra sản phẩm, chữ/số lượng, bố cục và mép ảnh…"
                  />
                </label>
                <div>
                  <button
                    disabled={busy || !reviewer.trim() || !note.trim()}
                    onClick={() => void review('accept_lossy_match')}
                  >
                    Xác nhận ảnh đúng nội dung
                  </button>
                  <button
                    disabled={busy || !reviewer.trim() || !note.trim()}
                    onClick={() => void review('reject')}
                  >
                    Ảnh chưa đúng
                  </button>
                </div>
              </div>
            ) : (
              <p>Phiếu giữ kết quả kiểm và nhận xét đã lưu. Cặp ảnh mới sẽ cần phiếu riêng.</p>
            )}
            {selected.review && (
              <div>
                <p>Người đối chiếu: {selected.review.reviewer}</p>
                <p>Nhận xét đã lưu: {selected.review.note}</p>
              </div>
            )}
          </article>
        )}
      </div>
    </section>
  );
}
