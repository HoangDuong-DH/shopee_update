import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbookImport } from '@shopee/domain';
import { api, money, type ImportRecord } from './api.js';
import type { EditorSeed } from './Editor.js';
import { resolveListingInput } from './listing-input.js';

export function ListingImport({
  imports,
  onContinue,
  onCancel,
  onSources,
  onDirty,
}: {
  imports: ImportRecord[];
  onContinue: (seed: EditorSeed) => void;
  onCancel: () => void;
  onSources: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [productKey, setProductKey] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sheet, setSheet] = useState('');
  const [profileChoice, setProfileChoice] = useState('');
  const [catalog, setCatalog] = useState<WorkbookImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tierCount, setTierCount] = useState<'' | 0 | 1 | 2>('');
  const [tierNames, setTierNames] = useState<string[]>(['', '']);
  const [membership, setMembership] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const readySources = imports.filter((item) => item.kind === 'xlsx' && item.status === 'ready');
  const readySource = readySources.find((item) => item.id === sourceId);
  const dirty = !!(
    productKey ||
    sourceId ||
    sheet ||
    profileChoice ||
    membership ||
    tierNames.some(Boolean) ||
    tierCount !== ''
  );
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);

  function invalidateReview() {
    setReviewed(false);
    setConfirmed(false);
  }
  function changeSource(id: string) {
    request.current?.abort();
    generation.current += 1;
    setSourceId(id);
    setSheet('');
    setProfileChoice('');
    setCatalog(null);
    setError('');
    setLoading(!!id);
    invalidateReview();
  }
  useEffect(() => {
    if (!sourceId) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    setLoading(true);
    void api<ImportRecord>('/v1/imports/' + encodeURIComponent(sourceId), {
      signal: controller.signal,
    })
      .then((record) => {
        if (controller.signal.aborted || current !== generation.current) return;
        const body = record.body as WorkbookImport | undefined;
        if (
          record.id !== sourceId ||
          record.kind !== 'xlsx' ||
          record.status !== 'ready' ||
          !body ||
          !Array.isArray(body.rows) ||
          !Array.isArray(body.sheets)
        )
          throw new Error('Bảng giá này chưa sẵn sàng để đọc. Vào Tệp nguồn để kiểm tra.');
        setCatalog(body);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || current !== generation.current) return;
        setCatalog(null);
        setError(cause instanceof Error ? cause.message : 'Chưa đọc được bảng giá.');
      })
      .finally(() => {
        if (!controller.signal.aborted && current === generation.current) setLoading(false);
      });
    return () => controller.abort();
  }, [sourceId]);

  const profiles = useMemo(
    () =>
      Array.from(
        new Set(
          (catalog?.rows ?? [])
            .filter((row) => row.sheet === sheet)
            .map((row) => row.priceProfile ?? null),
        ),
      ),
    [catalog, sheet],
  );
  const profile = profiles.find((value) => JSON.stringify(value) === profileChoice);
  const structureChosen = tierCount !== '';
  const result = useMemo(
    () =>
      resolveListingInput(
        {
          productKey,
          importId: readySource && catalog ? sourceId : '',
          sheet,
          priceProfile: profileChoice ? profile : undefined,
          tierCount: tierCount === '' ? 0 : tierCount,
          tierNames: tierCount === '' ? [] : tierNames.slice(0, tierCount),
          membership,
        },
        catalog?.rows ?? [],
      ),
    [
      productKey,
      sourceId,
      readySource,
      catalog,
      sheet,
      profileChoice,
      profile,
      tierCount,
      tierNames,
      membership,
    ],
  );
  const canContinue = reviewed && confirmed && structureChosen && !!result.seed && !loading;
  const selectedSheet = catalog?.sheets.find((item) => item.name === sheet);

  return (
    <div className="listing-import">
      <div className="page-heading">
        <div>
          <p className="eyebrow">BƯỚC 1 / 2 · TIẾP NHẬN BỘ ĐÃ CHUẨN BỊ</p>
          <h1>Nhập listing có sẵn</h1>
          <p>Đưa vào đúng danh sách SKU và phân loại của một listing bên bạn đã chuẩn bị.</p>
        </div>
        <button onClick={onCancel}>Về danh sách listing</button>
      </div>

      <div className="note listing-import-intro">
        <strong>Mỗi lần nhập là một bộ listing hoàn chỉnh</strong>
        <p>
          Bảng giá dùng để đối chiếu SKU và giá. Danh sách SKU thuộc listing và tên phân loại lấy từ
          bộ listing của bạn. Bước này chỉ chuẩn bị bản nháp trong ứng dụng.
        </p>
      </div>

      <section className="panel listing-import-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">01 · NHẬN DIỆN & NGUỒN GIÁ</p>
            <h2>Bộ listing nào cần nhập?</h2>
          </div>
        </div>
        <label>
          Mã bộ listing nội bộ
          <input
            value={productKey}
            onChange={(event) => {
              setProductKey(event.target.value);
              invalidateReview();
            }}
            placeholder="Mã đang dùng để quản lý bộ listing này"
            autoComplete="off"
          />
        </label>
        <p className="caption">
          Dùng một mã cố định cho bộ này để tránh nhập thành hai bản. Đây là mã quản lý nội bộ; link
          Shopee được đối chiếu ở bước thực thi.
        </p>
        {!readySources.length ? (
          <div className="empty">
            <p>Chưa có bảng giá đã đọc xong.</p>
            <button onClick={onSources}>Thêm file bảng giá</button>
          </div>
        ) : (
          <div className="listing-import-source-fields">
            <label>
              File bảng giá
              <select value={sourceId} onChange={(event) => changeSource(event.target.value)}>
                <option value="">Chọn file đã nhập</option>
                {readySources.map((source) => (
                  <option value={source.id} key={source.id}>
                    {source.filename} · {source.sha256.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sheet chứa giá
              <select
                value={sheet}
                disabled={!catalog || loading}
                onChange={(event) => {
                  setSheet(event.target.value);
                  setProfileChoice('');
                  invalidateReview();
                }}
              >
                <option value="">Chọn sheet</option>
                {catalog?.sheets.map((item) => (
                  <option value={item.name} key={item.name}>
                    {item.name}
                    {!item.importedRows ? ' · chưa có dòng đã đọc' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bộ giá áp dụng
              <select
                value={profileChoice}
                disabled={!sheet || !profiles.length || loading}
                onChange={(event) => {
                  setProfileChoice(event.target.value);
                  invalidateReview();
                }}
              >
                <option value="">Chọn rõ bộ giá</option>
                {profiles.map((value) => (
                  <option value={JSON.stringify(value)} key={JSON.stringify(value)}>
                    {value ?? 'Theo bảng nguồn (không tách bộ giá)'}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {loading && <p role="status">Đang đọc bảng giá đã chọn…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {selectedSheet && !selectedSheet.importedRows && (
          <p className="error">
            Sheet này chưa có dữ liệu được ánh xạ. Cần kiểm tra nguồn trước khi nhập listing.
          </p>
        )}
        <p className="caption">
          GIÁ GỐC là giá dùng khi đăng mới. GIÁ BÁN được giữ để xử lý khuyến mại riêng.
        </p>
      </section>

      <section className="panel listing-import-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 · CẤU TRÚC ĐÚNG THEO NGUỒN</p>
            <h2>Dán bảng phân loại của listing</h2>
          </div>
        </div>
        <label>
          Cấu trúc listing đã chuẩn bị
          <select
            value={tierCount}
            onChange={(event) => {
              setTierCount(
                event.target.value === '' ? '' : (Number(event.target.value) as 0 | 1 | 2),
              );
              invalidateReview();
            }}
          >
            <option value="">Chọn cấu trúc trong bộ nguồn</option>
            <option value="0">Không có phân loại · một SKU</option>
            <option value="1">Một nhóm phân loại</option>
            <option value="2">Hai nhóm phân loại</option>
          </select>
        </label>
        {structureChosen && tierCount > 0 && (
          <div className="listing-import-tier-fields">
            {Array.from({ length: tierCount }, (_, index) => (
              <label key={index}>
                Tên nhóm phân loại {index + 1}
                <input
                  value={tierNames[index]}
                  placeholder="Tên nguyên văn trong listing đã chuẩn bị"
                  onChange={(event) => {
                    setTierNames((values) =>
                      values.map((value, i) => (i === index ? event.target.value : value)),
                    );
                    invalidateReview();
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <div className="listing-import-paste-guide">
          <strong>
            {tierCount === 0
              ? 'Mỗi dòng: SKU'
              : tierCount === 1
                ? 'Mỗi dòng: SKU → Nhãn phân loại'
                : tierCount === 2
                  ? 'Mỗi dòng: SKU → Nhãn nhóm 1 → Nhãn nhóm 2'
                  : 'Chọn cấu trúc để xem số cột cần dán'}
          </strong>
          <p>
            Sao chép các ô từ bảng listing đã chuẩn bị rồi dán một lần, bỏ hàng tiêu đề. Các cột
            cách nhau bằng Tab; mỗi SKU một dòng. Giữ đúng thứ tự, tên và khoảng trắng của nguồn.
          </p>
        </div>
        <label>
          Bảng SKU và phân loại đã chuẩn bị
          <textarea
            aria-label="Bảng SKU và phân loại đã chuẩn bị"
            className="listing-import-membership"
            rows={7}
            spellCheck={false}
            value={membership}
            onChange={(event) => {
              setMembership(event.target.value);
              invalidateReview();
            }}
            placeholder="Dán các dòng từ bộ listing tại đây"
          />
        </label>
        <button
          className="primary"
          disabled={loading || !catalog}
          onClick={() => {
            setReviewed(true);
            setConfirmed(false);
          }}
        >
          Đối chiếu với bảng giá
        </button>
      </section>

      {reviewed && (
        <section
          className="panel listing-import-review"
          aria-labelledby="listing-import-review-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 · KIỂM TRA BỘ VỪA NHẬP</p>
              <h2 id="listing-import-review-title">Kết quả đối chiếu</h2>
            </div>
            <span className="tag">{result.rows.length} SKU tìm thấy</span>
          </div>
          {(!structureChosen || result.issues.length > 0) && (
            <div className="listing-import-errors" role="alert">
              <strong>Cần làm rõ trước khi tiếp tục</strong>
              <ul>
                {!structureChosen && <li>Chọn cấu trúc listing trong bộ nguồn.</li>}
                {result.issues.map((issue, index) => (
                  <li key={index}>
                    {issue.line ? `Dòng ${issue.line}: ` : ''}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!result.rows.length && (
            <div className="table-panel">
              <table>
                <thead>
                  <tr>
                    <th>SKU trong bộ listing</th>
                    <th>Phân loại đã cung cấp</th>
                    <th>GIÁ GỐC</th>
                    <th>GIÁ BÁN</th>
                    <th>Dòng nguồn</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map(({ row, optionLabels, line, sku }) => (
                    <tr key={line}>
                      <td>
                        <strong className="listing-import-literal">{sku}</strong>
                        <small>{row.name.value}</small>
                      </td>
                      <td>
                        {optionLabels.length
                          ? optionLabels.map((label, index) => (
                              <div className="listing-import-literal" key={index}>
                                {label}
                              </div>
                            ))
                          : 'Không có phân loại'}
                      </td>
                      <td>
                        {row.originalPrice && /^[0-9]+$/.test(row.originalPrice.value)
                          ? money(row.originalPrice.value)
                          : 'Chưa có giá hợp lệ'}
                      </td>
                      <td>
                        {row.promotionTarget && /^[0-9]+$/.test(row.promotionTarget.value)
                          ? money(row.promotionTarget.value)
                          : 'Chưa có'}
                      </td>
                      <td>
                        {row.sheet} · dòng {row.row}
                        <small>{row.priceProfile ?? 'Theo bảng nguồn'}</small>
                        {row.originalPrice?.sources.map((source) => (
                          <small key={source.locator}>{source.locator}</small>
                        ))}
                        {row.issues.map((issue, index) => (
                          <small className={issue.severity === 'block' ? 'error' : ''} key={index}>
                            {issue.message}
                          </small>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {structureChosen && result.seed && (
            <label className="inline listing-import-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              Tôi đã đối chiếu: đây là toàn bộ SKU, đúng tên và thứ tự phân loại của một listing đã
              chuẩn bị.
            </label>
          )}
          <div className="actions listing-import-actions">
            <button onClick={onCancel}>Quay lại danh sách</button>
            <button
              className="primary"
              disabled={!canContinue}
              onClick={() => {
                if (canContinue && result.seed) onContinue(result.seed);
              }}
            >
              Tiếp tục: nội dung & ảnh
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
