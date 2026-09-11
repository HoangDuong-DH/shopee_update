import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, Plus, Trash2, Upload } from 'lucide-react';
import type { WorkbookImport } from '@shopee/domain';
import { api, money, type ImportRecord } from './api.js';
import type { EditorSeed } from './Editor.js';
import { resolveListingInput } from './listing-input.js';
import {
  clearIntakeRecovery,
  decodeIntakeRecovery,
  hasIntakeInput,
  INTAKE_STORAGE_KEY,
  newIntakeDraft,
  newIntakeRow,
  pastedMembershipToRows,
  rowsToMembership,
  type IntakeDraft,
} from './intake-state.js';

const steps = ['Nguồn giá', 'Phân loại đã chuẩn bị', 'Kiểm tra'];

function readRecovery(): { draft?: IntakeDraft; unavailable: boolean } {
  try {
    return {
      draft: decodeIntakeRecovery(sessionStorage.getItem(INTAKE_STORAGE_KEY)),
      unavailable: false,
    };
  } catch {
    return { unavailable: true };
  }
}

export function ListingImport({
  imports,
  onContinue,
  onCancel,
  onSources,
  onDirty,
  onUploadFiles,
  externalBusy = false,
}: {
  imports: ImportRecord[];
  onContinue: (
    seed: EditorSeed,
    variantSummaries?: { sku: string; originalPrice?: string }[],
  ) => void;
  onCancel: () => void;
  onSources: () => void;
  onDirty?: (dirty: boolean) => void;
  onUploadFiles?: (files: FileList | null) => Promise<void>;
  externalBusy?: boolean;
}) {
  const [recovery, setRecovery] = useState(readRecovery);
  const [draft, setDraft] = useState(newIntakeDraft);
  const [catalog, setCatalog] = useState<WorkbookImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const controlsBusy = uploading || externalBusy;
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pasteIssues, setPasteIssues] = useState<string[]>([]);
  const [replacePaste, setReplacePaste] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(recovery.unavailable);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const uploadGuard = useRef(false);
  const mounted = useRef(true);
  const title = useRef<HTMLHeadingElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const { sourceId, sheet, profileChoice, productKey, tierCount, tierNames, rows, step } = draft;
  const readySources = imports.filter((item) => item.kind === 'xlsx' && item.status === 'ready');
  const readySource = readySources.find((item) => item.id === sourceId);
  const dirty = !recovery.draft && hasIntakeInput(draft);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (recovery.draft) return;
    if (!dirty) {
      clearIntakeRecovery(draft.productKey);
      return;
    }
    try {
      const serialized = JSON.stringify(draft);
      if (!decodeIntakeRecovery(serialized)) {
        setStorageUnavailable(true);
        return;
      }
      sessionStorage.setItem(INTAKE_STORAGE_KEY, serialized);
      setStorageUnavailable(false);
    } catch {
      setStorageUnavailable(true);
    }
  }, [draft, dirty, recovery.draft]);
  useEffect(() => {
    if (!recovery.draft) title.current?.focus();
  }, [step, recovery.draft]);

  function update(changes: Partial<IntakeDraft>) {
    if (controlsBusy) return;
    setDraft((value) => ({ ...value, ...changes }));
    setAttempted(false);
    setConfirmed(false);
    setReplacePaste(false);
    setPasteIssues([]);
  }
  function changeSource(id: string) {
    if (controlsBusy) return;
    request.current?.abort();
    generation.current += 1;
    setCatalog(null);
    setError('');
    setLoading(!!id);
    update({ sourceId: id, sheet: '', profileChoice: '' });
  }
  useEffect(() => {
    if (!sourceId || recovery.draft) return;
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
          throw new Error('Bảng giá chưa đọc xong. Mở Tệp nguồn để xem phần cần xử lý.');
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
  }, [sourceId, recovery.draft]);

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
  const selectedSheet = catalog?.sheets.find((item) => item.name === sheet);
  const sourceIssues = [
    ...(!readySource ? ['Chọn file bảng giá đã đọc xong.'] : []),
    ...(!catalog && !loading && readySource
      ? ['Chưa đọc được nội dung bảng giá. Chọn lại file để thử.']
      : []),
    ...(!sheet ? ['Chọn trang tính có giá của bộ này.'] : []),
    ...(sheet && !selectedSheet?.importedRows
      ? ['Trang tính này chưa có dòng đã đọc. Chọn trang khác hoặc kiểm tra tệp nguồn.']
      : []),
    ...(profile === undefined ? ['Chọn bộ giá cần áp dụng.'] : []),
  ];
  const table = useMemo(
    () => rowsToMembership(rows, tierCount === '' ? 0 : tierCount),
    [rows, tierCount],
  );
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
          membership: table.membership,
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
      table.membership,
    ],
  );
  const membershipIssues =
    tierCount === ''
      ? ['Chọn số nhóm phân loại đúng theo bộ đã chuẩn bị.']
      : [
          ...(draft.pasteText
            ? [
                'Có dữ liệu vừa dán chưa đưa vào bảng. Bấm “Đưa dữ liệu vào bảng”, hoặc xóa phần dán nếu không dùng.',
              ]
            : []),
          ...table.issues,
          ...result.issues.map(
            (issue) => `${issue.line ? 'Dòng ' + issue.line + ': ' : ''}${issue.message}`,
          ),
        ];
  const visibleLabelCount = Math.max(
    tierCount || 0,
    rows.some((row) => row.labels[1] !== '') ? 2 : rows.some((row) => row.labels[0] !== '') ? 1 : 0,
  );
  const canContinue =
    step === 3 &&
    confirmed &&
    !sourceIssues.length &&
    !membershipIssues.length &&
    !!result.seed &&
    !loading &&
    !controlsBusy;

  function next() {
    setAttempted(true);
    if (loading || controlsBusy) return;
    if (step === 1 && !sourceIssues.length) update({ step: 2 });
    if (step === 2 && !sourceIssues.length && !membershipIssues.length && result.seed)
      update({ step: 3 });
  }
  function applyPaste() {
    if (tierCount === '' || controlsBusy) return;
    const parsed = pastedMembershipToRows(draft.pasteText, tierCount);
    setPasteIssues(parsed.issues);
    if (!parsed.rows) return;
    const hasRows = rows.some((row) => row.sku || row.labels.some(Boolean));
    if (hasRows && !replacePaste) {
      setReplacePaste(true);
      return;
    }
    update({ rows: parsed.rows, pasteText: '' });
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !onUploadFiles || uploadGuard.current || controlsBusy) return;
    uploadGuard.current = true;
    setUploading(true);
    setError('');
    try {
      await onUploadFiles(files);
    } catch (cause: unknown) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : 'Chưa tải được file. Thử lại hoặc mở Tệp nguồn.',
        );
    } finally {
      uploadGuard.current = false;
      if (mounted.current) {
        setUploading(false);
        if (uploadInput.current) uploadInput.current.value = '';
      }
    }
  }

  return (
    <div className="listing-import intake-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NHẬP BỘ ĐÃ CHUẨN BỊ</p>
          <h1>Nhập listing có sẵn</h1>
          <p>Mỗi lần nhập là một bộ listing. Làm lần lượt, có thể quay lại mà không mất dữ liệu.</p>
        </div>
        <button onClick={onCancel} disabled={controlsBusy}>
          <ArrowLeft size={16} aria-hidden="true" /> Về danh sách
        </button>
      </div>

      {recovery.draft ? (
        <section className="panel intake-recovery" aria-labelledby="intake-recovery-title">
          <h2 id="intake-recovery-title">Bạn có một bộ đang nhập dở</h2>
          <p>Tiếp tục từ phần đã nhập trong tab này, hoặc bắt đầu bộ khác.</p>
          <p className="caption">
            {recovery.draft.rows.filter((row) => row.sku).length} dòng SKU đã điền
            {recovery.draft.sheet ? ' · Trang tính ' + recovery.draft.sheet : ''}. Chưa gửi lên
            Shopee.
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={controlsBusy}
              onClick={() => {
                if (controlsBusy) return;
                const saved = recovery.draft!;
                setDraft({ ...saved, step: saved.step === 3 ? 2 : saved.step });
                setRecovery({ unavailable: false });
                setAttempted(false);
                setConfirmed(false);
              }}
            >
              Tiếp tục phần đang nhập
            </button>
            <button
              disabled={controlsBusy}
              onClick={() => {
                if (controlsBusy) return;
                clearIntakeRecovery();
                setDraft(newIntakeDraft());
                setRecovery({ unavailable: false });
              }}
            >
              Nhập bộ khác
            </button>
          </div>
        </section>
      ) : (
        <>
          <ol className="intake-steps" aria-label="Các bước nhập listing">
            {steps.map((label, index) => (
              <li
                key={label}
                className={step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}
                aria-current={step === index + 1 ? 'step' : undefined}
              >
                <span className="intake-step-number" aria-hidden="true">
                  {step > index + 1 ? <Check size={16} /> : index + 1}
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
          {storageUnavailable && (
            <p className="note" role="status">
              Trình duyệt chưa lưu được phần nhập dở. Giữ tab này mở cho đến khi lưu bộ listing.
            </p>
          )}

          <section
            className="panel listing-import-section intake-step"
            aria-labelledby="intake-step-title"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">BƯỚC {step} / 3</p>
                <h2 id="intake-step-title" ref={title} tabIndex={-1}>
                  {step === 1
                    ? 'Chọn bảng giá của bộ listing'
                    : step === 2
                      ? 'Nhập đúng các phân loại đã chuẩn bị'
                      : 'Kiểm tra trước khi thêm nội dung và ảnh'}
                </h2>
                <p>
                  {step === 1
                    ? 'Ứng dụng lấy SKU và giá từ file này để đối chiếu.'
                    : step === 2
                      ? 'Mỗi dòng là một SKU thuộc bộ listing này. Giữ nguyên tên và thứ tự trong nguồn của bạn.'
                      : 'Đọc lại các SKU, tên phân loại và giá vừa tìm được trong bảng nguồn.'}
                </p>
              </div>
            </div>

            {step === 1 && (
              <>
                {!readySources.length && (
                  <div className="empty">
                    <FileSpreadsheet size={32} aria-hidden="true" />
                    <h3>Thêm bảng giá để bắt đầu</h3>
                    <p>Dùng file Excel đang quản lý SKU và giá của công ty.</p>
                  </div>
                )}
                <div className="listing-import-source-fields">
                  <label>
                    File bảng giá
                    <select
                      value={sourceId}
                      onChange={(event) => changeSource(event.target.value)}
                      disabled={controlsBusy}
                    >
                      <option value="">Chọn file đã nhập</option>
                      {readySources.map((source) => (
                        <option value={source.id} key={source.id}>
                          {source.filename}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Trang tính chứa giá
                    <select
                      value={sheet}
                      disabled={!catalog || loading || controlsBusy}
                      onChange={(event) => update({ sheet: event.target.value, profileChoice: '' })}
                    >
                      <option value="">Chọn trang tính</option>
                      {catalog?.sheets.map((item) => (
                        <option value={item.name} key={item.name}>
                          {item.name}
                          {!item.importedRows ? ' · chưa đọc được dữ liệu' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Bộ giá áp dụng
                    <select
                      value={profileChoice}
                      disabled={!sheet || !profiles.length || loading || controlsBusy}
                      onChange={(event) => update({ profileChoice: event.target.value })}
                    >
                      <option value="">Chọn bộ giá</option>
                      {profiles.map((value) => (
                        <option value={JSON.stringify(value)} key={JSON.stringify(value)}>
                          {value ?? 'Giá trong bảng đã chọn'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="actions intake-source-actions">
                  {onUploadFiles ? (
                    <>
                      <input
                        ref={uploadInput}
                        type="file"
                        accept=".xlsx"
                        hidden
                        disabled={controlsBusy}
                        onChange={(event) => {
                          void upload(event.target.files);
                        }}
                      />
                      <button onClick={() => uploadInput.current?.click()} disabled={controlsBusy}>
                        <Upload size={16} aria-hidden="true" />{' '}
                        {uploading ? 'Đang thêm file…' : 'Thêm file Excel'}
                      </button>
                    </>
                  ) : (
                    <button onClick={onSources} disabled={controlsBusy}>
                      <Upload size={16} aria-hidden="true" /> Thêm file Excel
                    </button>
                  )}
                  <button className="text-button" onClick={onSources} disabled={controlsBusy}>
                    Xem các tệp đã nhập
                  </button>
                </div>
                {loading && <p role="status">Đang đọc bảng giá…</p>}
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                {selectedSheet && !selectedSheet.importedRows && (
                  <p className="error">Trang tính này cần kiểm tra nguồn trước khi dùng.</p>
                )}
                <div className="note intake-price-note">
                  <strong>Giá đăng mới lấy từ GIÁ GỐC.</strong>
                  <p>GIÁ BÁN được giữ riêng để đối chiếu khi làm khuyến mại.</p>
                </div>
                {attempted && <IntakeIssues issues={sourceIssues} />}
              </>
            )}

            {step === 2 && (
              <>
                <fieldset className="intake-structure" disabled={controlsBusy}>
                  <legend>Khách mua chọn phân loại như thế nào?</legend>
                  <div className="intake-structure-options">
                    {(
                      [
                        {
                          value: 0,
                          label: 'Không có phân loại',
                          example: 'Một SKU, khách không cần chọn thêm',
                        },
                        {
                          value: 1,
                          label: 'Một nhóm',
                          example: 'Ví dụ: chọn Trắng 100 cái hoặc Đen 100 cái',
                        },
                        {
                          value: 2,
                          label: 'Hai nhóm',
                          example: 'Ví dụ: chọn Màu sắc, rồi chọn Quy cách',
                        },
                      ] as const
                    ).map((option) => (
                      <label
                        key={option.value}
                        className={tierCount === option.value ? 'selected' : ''}
                      >
                        <input
                          type="radio"
                          name="prepared-tier-count"
                          checked={tierCount === option.value}
                          onChange={() => update({ tierCount: option.value })}
                        />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.example}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {tierCount !== '' && (
                  <>
                    {tierCount > 0 && (
                      <div className="listing-import-tier-fields">
                        {Array.from({ length: tierCount }, (_, index) => (
                          <label key={index}>
                            Tên nhóm phân loại {index + 1}
                            <input
                              value={tierNames[index]}
                              disabled={controlsBusy}
                              autoComplete="off"
                              placeholder={
                                index === 0
                                  ? 'Tên đang dùng trong bộ của bạn'
                                  : 'Tên nhóm thứ hai trong bộ của bạn'
                              }
                              onChange={(event) => {
                                const names: [string, string] = [...tierNames];
                                names[index] = event.target.value;
                                update({ tierNames: names });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="section-heading intake-table-heading">
                      <h3>Danh sách SKU trong bộ này</h3>
                      <span className="tag neutral">{rows.length} dòng</span>
                    </div>
                    <p className="caption">
                      SKU là mã hàng trong bảng giá. Nhãn phân loại là tên khách mua nhìn thấy.
                    </p>
                    <div className="table-panel intake-membership-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Dòng</th>
                            <th>Mã SKU</th>
                            {Array.from({ length: visibleLabelCount }, (_, index) => (
                              <th key={index}>
                                {index < tierCount
                                  ? tierNames[index] || `Nhãn nhóm ${index + 1}`
                                  : `Nhãn ngoài cấu trúc · nhóm ${index + 1}`}
                              </th>
                            ))}
                            <th>
                              <span className="sr-only">Thao tác</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, index) => (
                            <tr key={row.id}>
                              <td>{index + 1}</td>
                              <td>
                                <input
                                  aria-label={`SKU dòng ${index + 1}`}
                                  disabled={controlsBusy}
                                  value={row.sku}
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder="Mã trong bảng giá"
                                  onChange={(event) =>
                                    update({
                                      rows: rows.map((item) =>
                                        item.id === row.id
                                          ? { ...item, sku: event.target.value }
                                          : item,
                                      ),
                                    })
                                  }
                                />
                              </td>
                              {Array.from({ length: visibleLabelCount }, (_, labelIndex) => (
                                <td key={labelIndex}>
                                  <input
                                    aria-label={`Nhãn nhóm ${labelIndex + 1} dòng ${index + 1}`}
                                    disabled={controlsBusy}
                                    value={row.labels[labelIndex]}
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="Tên nguyên văn đã chuẩn bị"
                                    onChange={(event) =>
                                      update({
                                        rows: rows.map((item) => {
                                          if (item.id !== row.id) return item;
                                          const labels: [string, string] = [...item.labels];
                                          labels[labelIndex] = event.target.value;
                                          return { ...item, labels };
                                        }),
                                      })
                                    }
                                  />
                                </td>
                              ))}
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`Xóa dòng ${index + 1}`}
                                  title={`Xóa dòng ${index + 1}`}
                                  disabled={rows.length === 1 || controlsBusy}
                                  onClick={() =>
                                    update({ rows: rows.filter((item) => item.id !== row.id) })
                                  }
                                >
                                  <Trash2 size={16} aria-hidden="true" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button
                      disabled={rows.length >= 2000 || tierCount === 0 || controlsBusy}
                      onClick={() => update({ rows: [...rows, newIntakeRow()] })}
                    >
                      <Plus size={16} aria-hidden="true" /> Thêm dòng SKU
                    </button>
                    <details className="intake-bulk-paste">
                      <summary>Đã có bảng phân loại trong Excel? Dán nhiều dòng</summary>
                      <p>
                        Sao chép {tierCount + 1} cột: SKU
                        {tierCount > 0 ? ' và tên phân loại của từng nhóm' : ''}, bỏ hàng tiêu đề.
                        Dữ liệu đã dán sẽ thay bảng phía trên khi bạn xác nhận.
                      </p>
                      <label>
                        Bảng SKU và phân loại đã chuẩn bị
                        <textarea
                          rows={5}
                          disabled={controlsBusy}
                          spellCheck={false}
                          value={draft.pasteText}
                          placeholder="Dán các ô đã sao chép từ Excel"
                          onChange={(event) => update({ pasteText: event.target.value })}
                        />
                      </label>
                      <IntakeIssues issues={pasteIssues} />
                      {replacePaste && (
                        <p className="note">
                          Bảng đang có dữ liệu. Bấm “Thay bảng bằng dữ liệu đã dán” để thay toàn bộ
                          các dòng; nội dung gốc trong Excel vẫn được giữ.
                        </p>
                      )}
                      <button onClick={applyPaste} disabled={controlsBusy}>
                        {replacePaste ? 'Thay bảng bằng dữ liệu đã dán' : 'Đưa dữ liệu vào bảng'}
                      </button>
                      {replacePaste && (
                        <button onClick={() => setReplacePaste(false)} disabled={controlsBusy}>
                          Giữ bảng hiện tại
                        </button>
                      )}
                    </details>
                  </>
                )}
                {attempted && <IntakeIssues issues={membershipIssues} />}
                {attempted && sourceIssues.length > 0 && (
                  <p className="error" role="alert">
                    Nguồn giá cần kiểm tra lại. Bấm Quay lại để chọn đúng file và bộ giá.
                  </p>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <div className="intake-review-summary">
                  <FileSpreadsheet size={20} aria-hidden="true" />
                  <div>
                    <strong>{readySource?.filename ?? 'Nguồn chưa sẵn sàng'}</strong>
                    <p className="caption">
                      {sheet} · {profile ?? 'Giá trong bảng đã chọn'} · {result.rows.length} SKU
                    </p>
                  </div>
                </div>
                <IntakeIssues issues={[...sourceIssues, ...membershipIssues]} />
                <div className="table-panel listing-import-review">
                  <table>
                    <thead>
                      <tr>
                        <th>SKU & phân loại</th>
                        <th>Giá đăng mới</th>
                        <th>Giá bán mục tiêu</th>
                        <th>Nguồn giá</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map(({ row, optionLabels, line, sku }) => (
                        <tr key={line}>
                          <td>
                            <strong className="listing-import-literal">{sku}</strong>
                            {optionLabels.length ? (
                              optionLabels.map((label, index) => (
                                <div className="listing-import-literal" key={index}>
                                  {label}
                                </div>
                              ))
                            ) : (
                              <small>Không có phân loại</small>
                            )}
                            <small>{row.name.value}</small>
                          </td>
                          <td>
                            {row.originalPrice && /^[0-9]+$/.test(row.originalPrice.value)
                              ? money(row.originalPrice.value)
                              : 'Cần kiểm tra'}
                            <small>GIÁ GỐC</small>
                          </td>
                          <td>
                            {row.promotionTarget && /^[0-9]+$/.test(row.promotionTarget.value)
                              ? money(row.promotionTarget.value)
                              : 'Chưa có'}
                            <small>Chưa tạo khuyến mại</small>
                          </td>
                          <td>
                            {row.sheet} · dòng {row.row}
                            <details>
                              <summary>Xem ô nguồn</summary>
                              {row.originalPrice?.sources.map((source) => (
                                <small key={source.locator}>{source.locator}</small>
                              ))}
                            </details>
                            {row.issues.map((issue, index) => (
                              <small
                                key={index}
                                className={issue.severity === 'block' ? 'error' : ''}
                              >
                                {issue.message}
                              </small>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label className="inline listing-import-confirmation">
                  <input
                    type="checkbox"
                    disabled={controlsBusy}
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.
                </label>
                <p className="caption">
                  Bước tiếp theo: chọn nội dung và ảnh đã chuẩn bị. Chưa đăng lên Shopee.
                </p>
              </>
            )}

            <div className="actions intake-footer">
              {step > 1 ? (
                <button
                  onClick={() => update({ step: (step - 1) as 1 | 2 })}
                  disabled={controlsBusy}
                >
                  <ArrowLeft size={16} aria-hidden="true" /> Quay lại
                </button>
              ) : (
                <span />
              )}
              {step < 3 ? (
                <button className="primary" disabled={loading || controlsBusy} onClick={next}>
                  Tiếp tục{step === 1 ? ': phân loại' : ': kiểm tra'}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!canContinue}
                  onClick={() => {
                    if (canContinue && result.seed)
                      onContinue(
                        result.seed,
                        result.rows.map(({ sku, row }) => ({
                          sku,
                          originalPrice: row.originalPrice?.value,
                        })),
                      );
                  }}
                >
                  Tiếp tục: nội dung & ảnh
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </section>
          <details className="intake-tracking">
            <summary>Mã theo dõi trong ứng dụng</summary>
            <p className="caption">
              Ứng dụng tự tạo mã này để giữ đúng phần đang nhập. Đây không phải SKU hoặc mã sản phẩm
              Shopee.
            </p>
            <code>{productKey}</code>
          </details>
        </>
      )}
    </div>
  );
}

function IntakeIssues({ issues }: { issues: string[] }) {
  return issues.length ? (
    <div className="listing-import-errors" role="alert">
      <strong>Cần kiểm tra trước khi tiếp tục</strong>
      <ul>
        {issues.map((issue, index) => (
          <li key={index}>{issue}</li>
        ))}
      </ul>
    </div>
  ) : null;
}
