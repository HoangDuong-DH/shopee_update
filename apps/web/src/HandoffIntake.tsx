import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, Download, FileCheck2, FolderOpen, Upload } from 'lucide-react';
import type { HandoffDocument, HandoffMode, HandoffPreview, ListingDraft } from '@shopee/domain';
import { api, media, money, post, RequestError } from './api.js';
import './handoff-intake.css';

const messages: Record<string, string> = {
  HANDOFF_SELECTION_MISSING:
    'Bộ cũ chưa lưu đủ vị trí nguồn để xuất hồ sơ. Mở bộ này và lưu lựa chọn nguồn trước.',
  HANDOFF_SOURCE_MISMATCH:
    'Hồ sơ tham chiếu tệp chưa có hoặc khác bản gốc trên máy chủ này. Nhận đúng bộ nguồn trước khi thử lại.',
  HANDOFF_SCOPE_MISMATCH:
    'Một nguồn không thuộc đúng bộ listing. Chọn lại hồ sơ do ứng dụng xuất từ bộ cần dùng.',
  HANDOFF_PRICE_MISMATCH:
    'SKU, trang tính, bộ giá hoặc giá không còn khớp nguồn. Chưa có giá nào được tự sửa.',
  HANDOFF_TARGET_REQUIRED: 'Chọn rõ bộ mới hoặc bộ đã lưu cần cập nhật.',
  HANDOFF_PREVIEW_CHANGED:
    'Bản xem trước không còn khớp. Đối chiếu lại để thấy đúng thay đổi trước khi lưu.',
  HANDOFF_BLOCKED: 'Bộ này còn thông tin cần kiểm tra. Xử lý các mục được chỉ ra trước khi lưu.',
  PRODUCT_MEMBERSHIP_LOCKED:
    'Hồ sơ đã đổi SKU, tên hoặc thứ tự phân loại so với bộ đã lưu. Không thể áp như bản cập nhật của bộ này.',
  PRODUCT_REVISION_CONFLICT:
    'Bộ listing đã có phiên bản khác. Mở đúng bản mới nhất và đối chiếu lại.',
  INVALID_INPUT:
    'Tệp chưa đúng hồ sơ listing của ứng dụng. Dùng “Tải hồ sơ để dùng lại” từ một bộ đã lưu; không cần tự soạn tệp.',
};
const errorMessage = (cause: unknown) =>
  cause instanceof RequestError
    ? (messages[cause.code] ?? cause.message)
    : cause instanceof Error
      ? cause.message
      : 'Chưa đọc được hồ sơ. Giữ tệp và thử lại.';
const emptyValue = <span className="handoff-empty">Chưa có</span>;
function describeChange(field: string, value: unknown): ReactNode {
  if (value === null || value === undefined) return emptyValue;
  if (['Tiêu đề', 'Câu mở đầu', 'Nội dung'].includes(field))
    return <pre>{typeof value === 'string' ? value || 'Trống' : 'Nội dung của bản cũ'}</pre>;
  if (field === 'Ảnh bìa')
    return typeof value === 'string' && value ? (
      <img className="handoff-diff-image" src={media(value)} alt="Ảnh bìa" />
    ) : (
      emptyValue
    );
  if (field === 'Ảnh sản phẩm' || field === 'Ảnh mô tả')
    return Array.isArray(value) && value.length ? (
      <div className="handoff-image-strip">
        {value.map((item, index) => (
          <figure key={index}>
            <img
              src={media(typeof item === 'string' ? item : item.assetKey)}
              alt={`Ảnh ${index + 1}`}
            />
            <figcaption>{index + 1}</figcaption>
          </figure>
        ))}
      </div>
    ) : (
      emptyValue
    );
  if (field === 'SKU và phân loại') {
    const structure = value as {
      tierNames: string[];
      variants: { sku: string; optionLabels: string[] }[];
    };
    return (
      <div>
        <p>{structure.tierNames.length ? structure.tierNames.join(' / ') : 'Không có phân loại'}</p>
        {structure.variants.map((variant, index) => (
          <p key={index}>
            <strong>{variant.sku}</strong> · {variant.optionLabels.join(' / ') || 'Một SKU'}
          </p>
        ))}
      </div>
    );
  }
  if (field === 'Giá và nguồn giá')
    return (
      <div>
        {(value as { sku: string; originalPrice: string; promotionTarget: string | null }[]).map(
          (variant, index) => (
            <p key={index}>
              <strong>{variant.sku}</strong> · Giá đăng {money(variant.originalPrice)}
              {variant.promotionTarget ? (
                <small>Giá khuyến mại dự kiến {money(variant.promotionTarget)}</small>
              ) : null}
            </p>
          ),
        )}
      </div>
    );
  if (field === 'Ảnh phân loại')
    return (
      <div className="handoff-image-strip">
        {(value as { sku: string; imageId: string | null }[]).map((variant, index) => (
          <figure key={index}>
            {variant.imageId ? <img src={media(variant.imageId)} alt={variant.sku} /> : emptyValue}
            <figcaption>{variant.sku}</figcaption>
          </figure>
        ))}
      </div>
    );
  return <p>Có thay đổi cần đối chiếu.</p>;
}

export function HandoffIntake({
  products,
  onSaved,
  onFolder,
  onDirty,
  onBusy,
  externalBusy = false,
  initialProductKey,
}: {
  products: ListingDraft[];
  onSaved: (product: ListingDraft) => void;
  onFolder: () => void;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
  externalBusy?: boolean;
  initialProductKey?: string;
}) {
  const [document, setDocument] = useState<HandoffDocument | null>(null);
  const [filename, setFilename] = useState('');
  const [mode, setMode] = useState<HandoffMode>('create_new');
  const [targetKey, setTargetKey] = useState(initialProductKey ?? '');
  const [newKey, setNewKey] = useState('');
  const [exportKey, setExportKey] = useState(initialProductKey ?? '');
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0),
    active = useRef(true),
    working = useRef(false);
  const locked = busy || externalBusy;
  const target = products.find((product) => product.productKey === targetKey);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    onDirty?.(document !== null);
  }, [document, onDirty]);
  async function run(action: () => Promise<void>) {
    if (locked || working.current) return;
    working.current = true;
    setBusy(true);
    onBusy?.(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
      onBusy?.(false);
    }
  }
  function accept(value: HandoffDocument, name: string) {
    // This is only a display hint. The server strictly validates the full document before preview.
    if (
      value?.format !== 'shopee-listing-handoff' ||
      value.version !== 1 ||
      typeof value.product?.productKey !== 'string' ||
      typeof value.content?.title !== 'string' ||
      !Array.isArray(value.variants) ||
      !Array.isArray(value.sources)
    )
      throw new Error(messages.INVALID_INPUT);
    const match = products.find((product) => product.productKey === value.product.productKey);
    setDocument(value);
    setFilename(name);
    setPreview(null);
    setMode(match ? 'update_source' : 'create_new');
    setTargetKey(match?.productKey ?? initialProductKey ?? '');
    setNewKey(value.product.productKey);
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    await run(async () => {
      const request = ++generation.current;
      if (file.size > 2 * 1024 * 1024)
        throw new Error(
          'Hồ sơ vượt 2 MB. Tệp hồ sơ chỉ chứa vị trí nguồn; ảnh và Word được giữ trên máy chủ.',
        );
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true })
            .decode(await file.arrayBuffer())
            .replace(/^\uFEFF/, ''),
        );
      } catch {
        throw new Error(messages.INVALID_INPUT);
      }
      if (active.current && request === generation.current)
        accept(value as HandoffDocument, file.name);
    });
  }
  function changeMode(next: HandoffMode) {
    if (locked) return;
    setMode(next);
    setPreview(null);
    setError('');
    if (next === 'create_new' && products.some((product) => product.productKey === newKey))
      setNewKey(crypto.randomUUID());
  }
  async function exportSaved(useNow: boolean) {
    if (!exportKey) return;
    await run(async () => {
      const request = ++generation.current;
      const value = await api<HandoffDocument>(
        '/v1/handoffs/products/' + encodeURIComponent(exportKey),
      );
      if (!active.current || request !== generation.current) return;
      if (useNow) {
        accept(value, 'Hồ sơ của bộ đã lưu');
        return;
      }
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2) + '\n'], {
          type: 'application/json;charset=utf-8',
        }),
      );
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download =
        'listing-' +
        value.product.productKey.replace(/[^A-Za-z0-9._-]/g, '_') +
        '-r' +
        value.product.sourceRevision +
        '.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Đã tạo hồ sơ dùng lại từ đúng nội dung và nguồn của bộ đã lưu.');
    });
  }
  function requestBody() {
    if (!document) throw new Error('Chọn hồ sơ listing trước.');
    if (mode === 'update_source' && !target) throw new Error(messages.HANDOFF_TARGET_REQUIRED);
    return {
      document,
      mode,
      productKey: mode === 'create_new' ? newKey : target!.productKey,
      expectedRevision: mode === 'create_new' ? 0 : target!.revision,
    };
  }
  async function compare() {
    await run(async () => {
      const request = ++generation.current;
      setPreview(null);
      const value = await post<HandoffPreview>('/v1/handoffs/preview', requestBody());
      if (active.current && request === generation.current) setPreview(value);
    });
  }
  async function apply() {
    if (!preview?.canApply) return;
    await run(async () => {
      // Use the exact server-reviewed request. Keep it for retry if the response is lost.
      const result = await post<{ product: ListingDraft; replayed: boolean }>(
        '/v1/handoffs/apply',
        {
          document: preview.document,
          mode: preview.mode,
          productKey: preview.productKey,
          expectedRevision: preview.expectedRevision,
          previewFingerprint: preview.previewFingerprint,
        },
      );
      if (!active.current) return;
      setDocument(null);
      setPreview(null);
      onDirty?.(false);
      onSaved(result.product);
    });
  }
  return (
    <div className="handoff-page">
      <header className="page-heading">
        <p className="eyebrow">BỘ LISTING ĐÃ CHUẨN BỊ</p>
        <h1>Nhận hồ sơ, đối chiếu, hoàn tất</h1>
        <p>
          Nội dung, ảnh và phân loại được giữ đúng bộ đã xác nhận. Mỗi lần dùng lại không cần chọn
          từng trường.
        </p>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="handoff-notice" role="status">
          <CheckCircle2 size={18} />
          {notice}
        </p>
      )}
      {!document ? (
        <>
          <section className="panel handoff-receive">
            <FileCheck2 size={34} aria-hidden="true" />
            <h2>Đã có hồ sơ listing từ ứng dụng</h2>
            <p>
              Chọn tệp hồ sơ được tải ở lần trước. Ứng dụng sẽ kiểm tra lại các tệp và giá đã dùng.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void readFile(file);
              }}
            />
            <button
              className="primary"
              disabled={locked}
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={17} />
              {busy ? 'Đang đọc hồ sơ…' : 'Chọn hồ sơ listing'}
            </button>
          </section>
          <section className="panel handoff-export">
            <h2>Dùng lại bộ đang có trong ứng dụng</h2>
            <p>Hồ sơ được tạo sẵn từ nguồn đã lưu; bạn không cần tự soạn tệp.</p>
            <label>
              Bộ listing đã lưu
              <select
                value={exportKey}
                disabled={locked}
                onChange={(event) => setExportKey(event.target.value)}
              >
                <option value="">Chọn bộ listing</option>
                {products.map((product) => (
                  <option key={product.productKey} value={product.productKey}>
                    {product.title.value} · bản {product.revision}
                  </option>
                ))}
              </select>
            </label>
            <div className="handoff-actions">
              <button disabled={locked || !exportKey} onClick={() => void exportSaved(true)}>
                Mở hồ sơ của bộ này <ArrowRight size={16} />
              </button>
              <button disabled={locked || !exportKey} onClick={() => void exportSaved(false)}>
                <Download size={16} />
                Tải hồ sơ để dùng lại
              </button>
            </div>
          </section>
          <section className="handoff-alternative">
            <div>
              <h2>Lần đầu, chỉ có thư mục ảnh và Word</h2>
              <p>
                Nhận thư mục một lần, xác nhận những phần chưa rõ rồi lưu thành bộ listing để dùng
                lại.
              </p>
            </div>
            <button disabled={locked} onClick={onFolder}>
              <FolderOpen size={17} />
              Nhận thư mục chưa có hồ sơ
            </button>
          </section>
          <p className="caption">
            Hồ sơ dùng lại các tệp đã nhập trên máy chủ nội bộ này. Tệp hồ sơ không chứa ảnh, Word,
            khóa Shopee hoặc dữ liệu đăng nhập.
          </p>
        </>
      ) : (
        <>
          <section className="panel handoff-target">
            <div className="section-heading">
              <div>
                <p className="eyebrow">HỒ SƠ ĐÃ CHỌN</p>
                <h2>{document.content.title}</h2>
                <p>
                  {filename} · {document.variants.length} SKU · {document.sources.length} tệp nguồn
                </p>
              </div>
              <button
                disabled={locked}
                onClick={() => {
                  setDocument(null);
                  setPreview(null);
                }}
              >
                Chọn hồ sơ khác
              </button>
            </div>
            <fieldset disabled={locked}>
              <legend>Bạn muốn dùng hồ sơ này để làm gì?</legend>
              <label>
                <input
                  type="radio"
                  checked={mode === 'update_source'}
                  onChange={() => changeMode('update_source')}
                />
                Cập nhật nguồn của bộ đã lưu
              </label>
              <label>
                <input
                  type="radio"
                  checked={mode === 'create_new'}
                  onChange={() => changeMode('create_new')}
                />
                Nhận thành một bộ listing mới
              </label>
            </fieldset>
            {mode === 'update_source' ? (
              <label>
                Bộ sẽ được cập nhật
                <select
                  value={targetKey}
                  disabled={locked}
                  onChange={(event) => {
                    setTargetKey(event.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">Chọn đúng bộ đã lưu</option>
                  {products.map((product) => (
                    <option key={product.productKey} value={product.productKey}>
                      {product.title.value} · bản {product.revision}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="handoff-context">
                Bạn đã chọn tạo bộ riêng. Bộ cũ được giữ nguyên; ứng dụng chưa đăng hoặc tạo link
                Shopee.
              </p>
            )}
            {!preview && (
              <button
                className="primary"
                disabled={locked || (mode === 'update_source' && !target)}
                onClick={() => void compare()}
              >
                {busy ? 'Đang đối chiếu nguồn…' : 'Đối chiếu trước khi lưu'}{' '}
                <ArrowRight size={17} />
              </button>
            )}
          </section>
          {preview && (
            <section className="panel handoff-preview">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">BẢN SO SÁNH</p>
                  <h2>
                    {preview.changes.length
                      ? `${preview.changes.length} phần sẽ được ${preview.mode === 'create_new' ? 'tiếp nhận' : 'cập nhật'}`
                      : 'Bộ này đã có đúng nội dung trong hồ sơ'}
                  </h2>
                  <p>
                    {preview.mode === 'update_source'
                      ? `Bản ${preview.expectedRevision} → bản ${preview.expectedRevision + 1}. SKU và thứ tự phân loại được giữ nguyên.`
                      : 'Lưu một bộ mới trong ứng dụng nội bộ.'}
                  </p>
                </div>
                <span className="tag neutral">Chưa ghi Shopee</span>
              </div>
              {preview.issues.map((issue, index) => (
                <p key={index} className={issue.severity === 'block' ? 'error' : 'handoff-context'}>
                  {issue.message}
                </p>
              ))}
              <div className="handoff-change-list">
                {preview.changes.map((change) => (
                  <details
                    key={change.field}
                    open={['Tiêu đề', 'Giá và nguồn giá'].includes(change.field)}
                  >
                    <summary>{change.field}</summary>
                    <div className="handoff-comparison">
                      <div>
                        <h3>Đang lưu</h3>
                        {describeChange(change.field, change.before)}
                      </div>
                      <div>
                        <h3>{preview.mode === 'create_new' ? 'Sẽ tiếp nhận' : 'Sẽ cập nhật'}</h3>
                        {describeChange(change.field, change.after)}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
              <details className="handoff-source-list">
                <summary>Nguồn đã đối chiếu · {preview.document.sources.length} tệp</summary>
                {preview.document.sources.map((source) => (
                  <p key={source.importId}>{source.filename}</p>
                ))}
                <p className="caption">
                  Nội dung giữ nguyên từng dòng và khoảng trắng. GIÁ GỐC dùng để đăng; GIÁ BÁN chỉ
                  là mục tiêu khuyến mại riêng.
                </p>
              </details>
              <div className="handoff-actions">
                <button disabled={locked} onClick={() => void compare()}>
                  Đối chiếu lại
                </button>
                {preview.canApply ? (
                  <button className="primary" disabled={locked} onClick={() => void apply()}>
                    {busy
                      ? 'Đang lưu…'
                      : preview.mode === 'update_source'
                        ? 'Lưu phiên bản nguồn mới'
                        : 'Lưu bộ listing'}
                  </button>
                ) : !preview.changes.length && target ? (
                  <button
                    className="primary"
                    disabled={locked}
                    onClick={() => {
                      setDocument(null);
                      onDirty?.(false);
                      onSaved(target);
                    }}
                  >
                    Mở bộ đã lưu
                  </button>
                ) : null}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
