import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Search } from 'lucide-react';
import type {
  CatalogEvidence,
  CatalogListingDetail,
  CatalogListingPage,
  CatalogText,
  SourceCatalogDetail,
  SourceCatalogSummary,
} from '@shopee/domain';
import { sourceListingIntent, currentCatalogIssues } from '../../../packages/domain/src/source-catalog.js';
import { api, date } from './api.js';
import { ArchiveAction, LifecycleFilter, type Lifecycle, type ArchiveFlags } from './LocalArchive.js';
import './source-catalog.css';

const filters = [
  ['all', 'Tất cả nội dung'],
  ['no_design', 'Chưa có gợi ý ảnh'],
  ['multiple_designs', 'Có nhiều gợi ý ảnh'],
  ['missing_item_id', 'Đăng mới · nguồn chưa có ID'],
  ['existing_item_id', 'Cập nhật link cũ · nguồn đã có ID'],
  ['source_review', 'Có ghi chú cần xác minh'],
] as const;
const count = (n: number) => n.toLocaleString('vi-VN');
function SourceAction({ itemId }: { itemId: string | null }) {
  const intent = sourceListingIntent(itemId);
  return <span className={'tag ' + (intent.kind === 'invalid' ? 'danger' : 'neutral')}>
    {intent.kind === 'create' ? 'Đăng mới' : intent.kind === 'update'
      ? `Cập nhật link ${intent.itemId}` : 'ID nguồn không hợp lệ · cần kiểm tra'}
  </span>;
}
function canvaLink(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      (url.hostname === 'canva.com' || url.hostname.endsWith('.canva.com'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function shopeeLink(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      (url.hostname === 'shopee.vn' || url.hostname.endsWith('.shopee.vn'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function Evidence({ value }: { value: CatalogEvidence }) {
  return (
    <small className="catalog-evidence">
      Nguồn: {value.sheet ? `${value.sheet} · ${value.cell ?? ''}` : value.label}
    </small>
  );
}
function TextSource({
  section,
  values,
  content = false,
}: {
  section: string;
  values: CatalogText[];
  content?: boolean;
}) {
  return (
    <section className="catalog-text-section">
      <h3>{section}</h3>
      {values.length ? (
        values.map((entry, index) => (
          <article key={index} className="catalog-original">
            <div className="catalog-original-label">
              <strong>{entry.label}</strong>
              <Evidence value={entry.evidence} />
            </div>
            <div
              className="catalog-source-text"
              data-testid={content ? `catalog-source-content-${index}` : undefined}
            >
              {entry.value}
            </div>
          </article>
        ))
      ) : (
        <p className="catalog-muted">Chưa có phần này trong nguồn đã nhận.</p>
      )}
    </section>
  );
}
function ReadError({ retry, message }: { retry: () => void; message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [message]);
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="catalog-load-error">
      <h2>Chưa tải được nguồn</h2>
      <p>{message}</p>
      <button onClick={retry}>Tải lại nguồn</button>
    </div>
  );
}

export function SourceCatalog({ onImport }: { onImport: () => void }) {
  const [catalogs, setCatalogs] = useState<SourceCatalogSummary[]>([]);
  const [catalogId, setCatalogId] = useState('');
  const [catalog, setCatalog] = useState<SourceCatalogDetail | null>(null);
  const [pageData, setPageData] = useState<CatalogListingPage | null>(null);
  const [filter, setFilter] = useState({ brand: '', q: '', issue: 'all', page: 1 });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogListingDetail | null>(null);
  const [detailPanel, setDetailPanel] = useState<'content' | 'variations' | 'designs' | 'notes'>(
    'content',
  );
  const [initialLoading, setInitialLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [reload, setReload] = useState(0);
  const [lifecycle, setLifecycle] = useState<Lifecycle>('active');
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = () => setReload((value) => value + 1);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(() => abort.abort(), 15000);
    setInitialLoading(true);
    setInitialError('');
    void api<SourceCatalogSummary[]>('/v1/source-catalogs', { signal: abort.signal })
      .then((rows) => {
        if (!active) return;
        setCatalogs(rows);
        setCatalogId((current) =>
          rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? ''),
        );
      })
      .catch(() => {
        if (active)
          setInitialError(
            'Chưa kết nối được với kho nguồn. Dữ liệu đã nhận vẫn được giữ; thử tải lại.',
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setInitialLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [reload]);
  useEffect(() => {
    if (!catalogId) {
      setCatalog(null);
      return;
    }
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(() => abort.abort(), 15000);
    setCatalog(null);
    void api<SourceCatalogDetail>('/v1/source-catalogs/' + encodeURIComponent(catalogId), {
      signal: abort.signal,
    })
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch(() => {
        if (active)
          setInitialError('Chưa đọc được thông tin của bộ nguồn. Thử tải lại để xem đầy đủ.');
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [catalogId, reload]);
  useEffect(() => {
    if (!catalogId) {
      setPageData(null);
      return;
    }
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(() => abort.abort(), 15000);
    const params = new URLSearchParams({
      brand: filter.brand,
      q: filter.q,
      issue: filter.issue,
      page: String(filter.page),
      pageSize: '30',
      lifecycle,
    });
    setListLoading(true);
    setListError('');
    setPageData(null);
    void api<CatalogListingPage>(
      '/v1/source-catalogs/' + encodeURIComponent(catalogId) + '/listings?' + params,
      { signal: abort.signal },
    )
      .then((value) => {
        if (active) setPageData(value);
      })
      .catch(() => {
        if (active) setListError('Chưa tải được danh sách này. Bộ lọc đang chọn vẫn được giữ.');
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [catalogId, filter, reload, lifecycle]);
  useEffect(() => {
    if (!catalogId || !selected) {
      setDetail(null);
      setDetailError('');
      return;
    }
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(() => abort.abort(), 15000);
    setDetailLoading(true);
    setDetail(null);
    setDetailError('');
    void api<CatalogListingDetail>(
      '/v1/source-catalogs/' +
        encodeURIComponent(catalogId) +
        '/listings/' +
        encodeURIComponent(selected),
      { signal: abort.signal },
    )
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch(() => {
        if (active)
          setDetailError('Chưa mở được nội dung gốc. Thử tải lại hoặc về danh sách nguồn.');
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [catalogId, selected, reload]);
  useEffect(() => {
    if (detail) {
      heading.current?.focus();
    }
  }, [detail]);
  const current = catalogs.find((value) => value.id === catalogId);
  const detailIssueCount = detail
    ? currentCatalogIssues(detail.issues).length +
      (detail.operationalReferences ?? []).reduce(
        (total, reference) => total + reference.concerns.length,
        0,
      )
    : 0;
  function openSource(id: string, panel: 'content' | 'notes' = 'content') {
    setDetailPanel(panel);
    setSelected(id);
  }
  function back() {
    setSelected(null);
    setDetail(null);
  }

  if (initialLoading && !catalogs.length)
    return (
      <section className="source-catalog" aria-busy="true">
        <p role="status">Đang đọc các bộ nguồn đã nhận…</p>
        <div className="catalog-loading-lines" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </section>
    );
  if (initialError) return <ReadError message={initialError} retry={retry} />;
  if (!catalogs.length)
    return (
      <section className="catalog-empty">
        <h2>Chưa có bộ nội dung được tiếp nhận</h2>
        <p>
          Nhập Word, ảnh hoặc bảng giá đã chuẩn bị. Nguồn được lưu để đối chiếu trước khi đăng hoặc
          cập nhật.
        </p>
        <button onClick={onImport}>Nhập Word, ảnh và bảng giá</button>
      </section>
    );

  return (
    <section className="source-catalog">
      {selected ? (
        <>
          <button className="catalog-back" onClick={back}>
            <ArrowLeft size={16} /> Về danh sách nguồn
          </button>
          {detailLoading && <p role="status">Đang mở nội dung gốc…</p>}
          {detailError && <ReadError message={detailError} retry={retry} />}
          {detail && (
            <article className="catalog-detail">
              <header className="catalog-detail-heading">
                <p className="catalog-muted">
                  {detail.brand} · {detail.sheet} · Dòng {detail.row}
                </p>
                <h2 ref={heading} tabIndex={-1}>
                  {detail.title}
                </h2>
                <Evidence value={detail.titleSource} />
              </header>
              <div className="catalog-detail-status">
                <span>Đã nhận nguồn · Chưa xác nhận để đăng</span>
                <ArchiveAction kind="catalog_listing" resourceId={`${catalogId}/${detail.id}`}
                  name={detail.title} archived={(detail as CatalogListingDetail & ArchiveFlags).archived ?? lifecycle === 'archived'}
                  onChanged={() => { back(); retry(); }} />
                <button onClick={() => setDetailPanel('notes')}>
                  {detailIssueCount
                    ? `Xem ${detailIssueCount} phần cần đối chiếu`
                    : 'Xem ghi chú & đối chiếu'}
                </button>
              </div>
              <nav className="catalog-detail-switcher" aria-label="Phần nội dung cần xem">
                {(
                  [
                    ['content', 'Nội dung'],
                    ['variations', 'Phân loại'],
                    ['designs', 'Ảnh Canva'],
                    ['notes', 'Ghi chú & đối chiếu'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    id={'catalog-panel-button-' + key}
                    aria-pressed={detailPanel === key}
                    onClick={() => setDetailPanel(key)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div
                className="catalog-detail-panels"
                role="region"
                aria-labelledby={'catalog-panel-button-' + detailPanel}
              >
                {detailPanel === 'notes' && currentCatalogIssues(detail.issues).length > 0 && (
                  <section className="catalog-issues">
                    <h3>Phần cần đối chiếu</h3>
                    <ul>
                      {currentCatalogIssues(detail.issues).map((issue, index) => (
                        <li key={index}>
                          <strong>{issue.message}</strong>
                          <span>{issue.action}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <div>
                  {detailPanel === 'content' && (
                    <TextSource section="Nội dung nguyên văn" values={detail.contents} content />
                  )}
                  {detailPanel === 'variations' && (
                    <TextSource
                      section="Phân loại được ghi trong nguồn"
                      values={detail.variations}
                    />
                  )}
                  {detailPanel === 'notes' && (
                    <TextSource section="Ghi chú rà soát từ file" values={detail.reviewNotes} />
                  )}
                  {detailPanel === 'notes' && !!detail.operationalReferences?.length && (
                    <details className="catalog-operational-references">
                      <summary>Đối chiếu với shop cũ</summary>
                      <p>
                        Đây là thông tin quan sát trên listing cũ, chưa xác minh qua API và chưa
                        được chấp thuận dùng lại. Nội dung nguồn bên trên vẫn được giữ nguyên.
                      </p>
                      {detail.operationalReferences.map((reference) => {
                        const href = shopeeLink(reference.sourceUrl);
                        return (
                          <article key={reference.shopHandle + ':' + reference.itemId}>
                            <h3>
                              {reference.shopHandle} · ID {reference.itemId}
                            </h3>
                            <p className="catalog-muted">
                              Đọc ngày {new Date(reference.observedAt).toLocaleDateString('vi-VN')}
                            </p>
                            <p>{reference.title}</p>
                            <dl>
                              <div>
                                <dt>Ngành đang hiển thị</dt>
                                <dd>{reference.categoryLabel}</dd>
                              </div>
                              {reference.attributes.map((attribute, index) => (
                                <div key={index}>
                                  <dt>{attribute.label}</dt>
                                  <dd>{attribute.value}</dd>
                                </div>
                              ))}
                            </dl>
                            {!!reference.concerns.length && (
                              <div className="catalog-reference-concerns">
                                <strong>Cần kiểm tra trước khi dùng lại</strong>
                                <ul>
                                  {reference.concerns.map((concern, index) => (
                                    <li key={index}>{concern}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {href && (
                              <a href={href} target="_blank" rel="noreferrer">
                                Mở listing đã quan sát <ExternalLink size={14} />
                                <span className="catalog-sr-only"> (mở tab mới)</span>
                              </a>
                            )}
                          </article>
                        );
                      })}
                    </details>
                  )}
                </div>
                {detailPanel === 'designs' && (
                  <aside className="catalog-designs">
                    <h3>Ảnh gợi ý · chưa xác nhận</h3>
                    <p>
                      Thông tin thiết kế đã được ghi nhận. Ảnh gốc chưa tải và chưa gán vai trò bìa,
                      nội dung hay phân loại.
                    </p>
                    {detail.designCandidates.length ? (
                      <ul>
                        {detail.designCandidates.map((design) => {
                          const href = canvaLink(design.url);
                          return (
                            <li key={design.id}>
                              <strong>{design.title}</strong>
                              <span>
                                {count(design.observedPageCount)} trang đã ghi nhận
                                {!design.complete ? ' · chưa xem đủ' : ''}
                              </span>
                              <p>{design.reason}</p>
                              {href && (
                                <a href={href} target="_blank" rel="noreferrer">
                                  Xem trên Canva <ExternalLink size={14} />
                                  <span className="catalog-sr-only"> (mở tab mới)</span>
                                </a>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="catalog-inline-empty">
                        Chưa tìm thấy thiết kế gợi ý cho dòng này. Nội dung nguồn vẫn được giữ.
                      </div>
                    )}
                    <dl className="catalog-missing-facts">
                      <div>
                        <dt>ID listing trong Excel</dt>
                        <dd><SourceAction itemId={detail.itemId} /></dd>
                      </div>
                      <div>
                        <dt>Shop đích</dt>
                        <dd>Chưa xác nhận</dd>
                      </div>
                      <div>
                        <dt>Giá và tồn đăng bán</dt>
                        <dd>Chưa có nguồn liên kết</dd>
                      </div>
                    </dl>
                  </aside>
                )}
              </div>
            </article>
          )}
        </>
      ) : (
        <>
          <header className="catalog-overview">
            <div>
              {catalogs.length > 1 ? (
                <select
                  aria-label="Chọn bộ nguồn"
                  value={catalogId}
                  onChange={(event) => {
                    setCatalogId(event.target.value);
                    setFilter({ brand: '', q: '', issue: 'all', page: 1 });
                    setQuery('');
                  }}
                >
                  {catalogs.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
              ) : (
                <h2>{current?.name}</h2>
              )}
              <p className="catalog-muted">
                Nhận lúc {current && date(current.receivedAt)} · Bản nguồn {current?.revision}
              </p>
            </div>
            <div className="catalog-totals">
              <strong>
                {count(pageData?.total ?? 0)} <span>{lifecycle === 'archived' ? 'dòng đã lưu trữ' : 'dòng đang hiển thị'}</span>
              </strong>
              <strong>
                {count(current?.counts.designs ?? 0)} <span>thiết kế trong nguồn gốc</span>
              </strong>
            </div>
          </header>
          <details className="catalog-intake-status">
            <summary>Đã nhận nguồn · Cần bổ sung để đăng</summary>
            <p>
              Excel này chứa nội dung và ghi chú rà soát, chưa phải bộ sẵn sàng đăng. Xem từng dòng
              để đối chiếu ảnh, phân loại, shop đích và thông tin còn thiếu.
            </p>
          <p className="catalog-muted">
            ID LISTING để trống: đăng mới. Có ID: cập nhật nội dung, ảnh và phân loại của link đó.
            Trước khi gửi, cần kiểm tra đúng shop và các lần đăng đã lưu; ID lỗi không chuyển sang đăng mới.
          </p>
          <p>Lưu trữ để bỏ khỏi danh sách đang sử dụng; có thể khôi phục. Sản phẩm trên Shopee và tệp gốc vẫn được giữ.</p>
          </details>
          <form
            className="catalog-filters"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setFilter((value) => ({ ...value, q: query, page: 1 }));
            }}
          >
            <label className="catalog-search">
              <span className="catalog-sr-only">Tìm nội dung</span>
              <input
                type="search"
                aria-label="Tìm trong nguồn đã nhận"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tên sản phẩm, ID listing hoặc nội dung…"
              />
            </label>
            <button type="submit">
              <Search size={16} /> Tìm kiếm
            </button>
            <label>
              <span className="catalog-sr-only">Nhãn trong Excel</span>
              <select
                aria-label="Lọc theo nhãn nguồn"
                value={filter.brand}
                onChange={(event) =>
                  setFilter((value) => ({ ...value, brand: event.target.value, page: 1 }))
                }
              >
                <option value="">Tất cả nhãn</option>
                {current?.brands.map((brand) => (
                  <option key={brand.name} value={brand.name}>
                    {brand.name} ({count(brand.count)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="catalog-sr-only">Phần cần xem</span>
              <select
                aria-label="Lọc phần cần đối chiếu"
                value={filter.issue}
                onChange={(event) =>
                  setFilter((value) => ({ ...value, issue: event.target.value, page: 1 }))
                }
              >
                {filters.map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </form>
          {listError ? (
            <ReadError message={listError} retry={retry} />
          ) : (
            <div aria-busy={listLoading}>
              <div className="catalog-list-summary" role="status">
                <span>
                {listLoading
                  ? 'Đang tìm trong nguồn…'
                  : `${count(pageData?.total ?? 0)} dòng${filter.q ? ` khớp “${filter.q}”` : ''} · Nhãn trong file không đồng nghĩa với shop`}
                </span>
                <LifecycleFilter value={lifecycle} onChange={(value) => {
                  setLifecycle(value); setFilter((current) => ({ ...current, page: 1 }));
                }} />
              </div>
              {listLoading ? (
                <div className="catalog-loading-lines" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              ) : pageData?.items.length ? (
                <table className="catalog-table">
                  <caption className="catalog-sr-only">
                    Nội dung đã nhận và phần cần đối chiếu
                  </caption>
                  <thead>
                    <tr>
                      <th>Nội dung listing từ nguồn</th>
                      <th>Tư liệu đã nhận</th>
                      <th>Cần đối chiếu</th>
                      <th>
                        <span className="catalog-sr-only">Mở chi tiết</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageData.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <button
                            className="catalog-title-button"
                            aria-label={'Xem nguồn: ' + item.title}
                            onClick={() => openSource(item.id)}
                          >
                            {item.title || 'Dòng chưa có tiêu đề'}
                          </button>
                          <div className="catalog-row-meta">
                            {item.brand} · {item.sheet} · Dòng {item.row}
                            {item.itemId ? ` · ID nguồn ${item.itemId}` : ''}
                          </div>
                          <SourceAction itemId={item.itemId} />
                        </td>
                        <td>
                          <span className="catalog-resource-label">
                            {item.contentAvailable ? 'Có nội dung' : 'Thiếu nội dung'}
                          </span>
                          <span className="catalog-resource-label">
                            {item.variationAvailable ? 'Có ghi phân loại' : 'Chưa ghi phân loại'}
                          </span>
                          <span className="catalog-resource-label">
                            {item.designCandidateCount
                              ? `${item.designCandidateCount} gợi ý ảnh`
                              : 'Chưa có gợi ý ảnh'}
                          </span>
                        </td>
                        <td>
                          {currentCatalogIssues(item.issues).length + (item.operationalConcernCount ?? 0) > 0 ? (
                            <details className="catalog-row-issues">
                              <summary>
                                {currentCatalogIssues(item.issues).length + (item.operationalConcernCount ?? 0)} mục cần
                                đối chiếu
                              </summary>
                              <ul>
                                {currentCatalogIssues(item.issues).map((issue, index) => (
                                  <li key={index}>
                                    {issue.message}
                                    <small>{issue.action}</small>
                                  </li>
                                ))}
                                {!!item.operationalConcernCount && (
                                  <li>
                                    <button
                                      className="catalog-reference-link"
                                      onClick={() => openSource(item.id, 'notes')}
                                    >
                                      Xem {item.operationalConcernCount} cảnh báo từ shop cũ
                                    </button>
                                  </li>
                                )}
                              </ul>
                            </details>
                          ) : (
                            <span className="catalog-muted">Chưa xác nhận bộ nguồn</span>
                          )}
                          <ArchiveAction kind="catalog_listing" resourceId={`${catalogId}/${item.id}`}
                            name={item.title} archived={lifecycle === 'archived'} onChanged={retry} />
                        </td>
                        <td>
                          <button
                            className="catalog-open"
                            aria-label={'Mở dòng ' + item.row + ' · ' + item.sheet}
                            onClick={() => openSource(item.id)}
                          >
                            <ArrowRight size={17} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="catalog-inline-empty">
                  <strong>Không tìm thấy dòng phù hợp</strong>
                  <p>Thử bỏ bớt bộ lọc hoặc tìm bằng một phần tên trong nguồn.</p>
                  <button
                    onClick={() => {
                      setFilter({ brand: '', q: '', issue: 'all', page: 1 });
                      setQuery('');
                    }}
                  >
                    Bỏ bộ lọc
                  </button>
                </div>
              )}
              <nav className="catalog-pagination" aria-label="Trang danh sách nguồn">
                <button
                  disabled={listLoading || filter.page <= 1}
                  onClick={() => setFilter((value) => ({ ...value, page: value.page - 1 }))}
                >
                  Trang trước
                </button>
                <span>
                  Trang {filter.page}
                  {pageData
                    ? ` / ${Math.max(1, Math.ceil(pageData.total / pageData.pageSize))}`
                    : ''}
                </span>
                <button
                  disabled={
                    listLoading || !pageData || pageData.page * pageData.pageSize >= pageData.total
                  }
                  onClick={() => setFilter((value) => ({ ...value, page: value.page + 1 }))}
                >
                  Trang sau
                </button>
              </nav>
            </div>
          )}
          {catalog && (
            <details className="catalog-provenance">
              <summary>Tệp đã nhận và thông tin còn thiếu</summary>
              <ul>
                {catalog.sources.map((source) => (
                  <li key={source.id}>
                    <strong>{source.name}</strong>
                    <span>{source.kind === 'workbook' ? 'Nguồn Excel' : 'Thư mục Canva'}</span>
                    {source.sha256 && <small>SHA-256: {source.sha256}</small>}
                  </li>
                ))}
              </ul>
              {catalog.notes.map((note, index) => (
                <p key={'n' + index}>{note}</p>
              ))}
              {catalog.missing.length > 0 && (
                <>
                  <h3>Cần bổ sung trước khi sử dụng để đăng</h3>
                  <ul>
                    {catalog.missing.map((missing, index) => (
                      <li key={index}>{missing}</li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
