import { useEffect, useRef, useState } from 'react';
import type { WorkbookImport } from '@shopee/domain';
import { api, date, money, type ImportRecord } from './api.js';
import { Issues } from './Preview.js';

export function Resources({
  imports,
  refresh,
  onUploading,
  initialTab = 'files',
}: {
  imports: ImportRecord[];
  refresh: () => Promise<void>;
  onUploading?: (busy: boolean) => void;
  initialTab?: 'files' | 'prices';
}) {
  const [tab, setTab] = useState(initialTab),
    [uploading, setUploading] = useState(''),
    [error, setError] = useState(''),
    [sourceId, setSourceId] = useState(''),
    [catalog, setCatalog] = useState<WorkbookImport | null>(null),
    [sheet, setSheet] = useState(''),
    [search, setSearch] = useState(''),
    [reading, setReading] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function load(id: string) {
    const generation = ++request.current;
    setSourceId(id);
    setCatalog(null);
    setSheet('');
    setSearch('');
    setError('');
    setReading(!!id);
    if (!id) return;
    try {
      const result = await api<ImportRecord>('/v1/imports/' + encodeURIComponent(id));
      if (generation === request.current) setCatalog(result.body as WorkbookImport);
    } catch (e) {
      if (generation === request.current) setError((e as Error).message);
    } finally {
      if (generation === request.current) setReading(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    const chosen = Array.from(files);
    let completed = 0;
    onUploading?.(true);
    setError('');
    try {
      for (const [i, file] of chosen.entries()) {
        setUploading(`${i + 1}/${chosen.length} · ${file.name}`);
        await api('/v1/imports', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        });
        completed++;
      }
    } catch (e) {
      setError(
        `Đã lưu ${completed}/${chosen.length} tệp. Dừng tại ${chosen[completed]?.name ?? 'tệp đang tải'}: ${(e as Error).message}. Chọn lại ${chosen.length - completed} tệp còn lại để tiếp tục.`,
      );
    } finally {
      setUploading('');
      onUploading?.(false);
      await refresh();
    }
  }
  const visible = (catalog?.rows ?? []).filter(
    (r) =>
      (!sheet || r.sheet === sheet) &&
      `${r.sku.value} ${r.name.value} ${r.priceProfile ?? ''}`
        .toLocaleLowerCase('vi')
        .includes(search.toLocaleLowerCase('vi')),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Tệp nguồn</h1>
          <p>Excel là nguồn đối chiếu giá. Word và ảnh là nội dung bên bạn đã chuẩn bị.</p>
        </div>
        <label className="button primary upload">
          {uploading ? 'Đang nhập…' : 'Thêm tệp'}
          <input
            aria-label="Thêm tệp nguồn"
            type="file"
            multiple
            accept=".xlsx,.docx,.png,.jpg,.jpeg,.webp"
            disabled={!!uploading}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <div className="tabbar" aria-label="Xem nguồn">
        <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
          Tệp đã nhập
        </button>
        <button aria-pressed={tab === 'prices'} onClick={() => setTab('prices')}>
          Tra bảng giá
        </button>
      </div>
      {uploading && <p role="status">Đang lưu {uploading}</p>}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {tab === 'files' ? (
        <>
          <p className="caption">
            Tệp được giữ nguyên. Nhập tệp tại đây chưa tạo listing hoặc gửi lên Shopee.
          </p>
          <div className="panel table-panel">
            <table>
              <thead>
                <tr>
                  <th>Tệp</th>
                  <th>Trạng thái đọc</th>
                  <th>Ngày nhập</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.filename}</strong>
                      <small>
                        {i.kind === 'image'
                          ? 'Ảnh'
                          : i.kind === 'docx'
                            ? 'Nội dung Word'
                            : 'Bảng Excel'}{' '}
                        · {(i.bytes / 1024 / 1024).toFixed(2)} MB
                      </small>
                      {i.message && <small className="error">{i.message}</small>}
                    </td>
                    <td>
                      <span
                        className={
                          'tag ' +
                          (i.status === 'ready'
                            ? 'success'
                            : i.status === 'failed'
                              ? 'danger'
                              : 'neutral')
                        }
                      >
                        {(
                          {
                            ready: 'Đã đọc tệp',
                            queued: 'Chờ đọc',
                            running: 'Đang đọc',
                            failed: 'Cần kiểm tra',
                          } as Record<string, string>
                        )[i.status] ?? 'Chưa xác định'}
                      </span>
                    </td>
                    <td>{date(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!imports.length && (
              <div className="empty">
                <h2>Thêm bộ tài liệu đầu tiên</h2>
                <p>Bạn có thể chọn nhiều ảnh, file Word và bảng giá cùng lúc.</p>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="context-note">
            <strong>Bảng giá chỉ để tra cứu</strong>
            <p>
              Mỗi dòng bên dưới là một dòng giá, không phải một listing. Danh sách SKU của từng
              listing được xác định riêng khi nhập bộ đã chuẩn bị.
            </p>
          </div>
          <div className="filters">
            <select
              aria-label="File bảng giá"
              value={sourceId}
              onChange={(e) => void load(e.target.value)}
            >
              <option value="">Chọn file Excel</option>
              {imports
                .filter((i) => i.kind === 'xlsx' && i.status === 'ready')
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.filename}
                  </option>
                ))}
            </select>
            <select aria-label="Sheet" value={sheet} onChange={(e) => setSheet(e.target.value)}>
              <option value="">Tất cả sheet</option>
              {catalog?.sheets.map((s) => (
                <option key={s.name}>{s.name}</option>
              ))}
            </select>
            <input
              aria-label="Tìm SKU"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm SKU, tên hoặc bộ giá"
            />
          </div>
          {reading && <p role="status">Đang đọc bảng giá…</p>}
          {catalog && (
            <>
              <Issues issues={catalog.issues} />
              <p className="caption">
                {visible.length} dòng giá khớp · Giữ riêng từng sheet và bộ giá
              </p>
              <div className="panel table-panel catalog-table">
                <table>
                  <thead>
                    <tr>
                      <th>SKU / Tên nguồn</th>
                      <th>Sheet / Bộ giá</th>
                      <th>GIÁ GỐC</th>
                      <th>GIÁ BÁN</th>
                      <th>Đối chiếu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.slice(0, 250).map((r) => (
                      <tr key={r.key}>
                        <td>
                          <strong>{r.sku.value}</strong>
                          <small>{r.name.value}</small>
                        </td>
                        <td>
                          {r.sheet}
                          <small>
                            {r.priceProfile ?? 'Theo bảng nguồn'} · dòng {r.row}
                          </small>
                        </td>
                        <td title={r.originalPrice?.sources[0]?.locator}>
                          {money(r.originalPrice?.value)}
                        </td>
                        <td>{money(r.promotionTarget?.value)}</td>
                        <td>
                          {r.issues.length ? (
                            <details>
                              <summary>{r.issues.length} điểm cần xem</summary>
                              {r.issues.map((issue, n) => (
                                <p key={n}>{issue.message}</p>
                              ))}
                            </details>
                          ) : (
                            <span className="tag neutral">Đã đọc</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visible.length && (
                  <p className="empty">Không có dòng khớp. Thử đổi sheet hoặc từ khóa.</p>
                )}
              </div>
              {visible.length > 250 && (
                <p className="caption">
                  Hiển thị 250 dòng đầu. Dùng bộ lọc để tìm các dòng còn lại.
                </p>
              )}
            </>
          )}
          {!catalog && !reading && (
            <div className="empty">Chọn một bảng giá đã nhập để xem dữ liệu.</div>
          )}
        </>
      )}
    </>
  );
}
