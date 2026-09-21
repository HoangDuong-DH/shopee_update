import { useEffect, useRef, useState } from 'react';
import type { ChangePlan, Issue, Scope } from '@shopee/domain';
import type { KnowledgeHit, KnowledgeSource, TraceEvent } from '@shopee/agent-runtime';
import { api, date, post } from './api.js';
import { Issues } from './Preview.js';
import { SellerKnowledgePanel } from './SellerKnowledgePanel.js';

type Review = {
  id: string;
  planId: string;
  planRevision: number;
  scope: Scope;
  query: string;
  state: string;
  code: string;
  createdAt: string;
  events: TraceEvent[];
  result: null | {
    inspection?: { issues: Issue[] };
    sources: KnowledgeSource[];
    hits?: KnowledgeHit[];
    issues?: string[];
    note: string;
  };
};
const stateLabel: Record<string, string> = {
  running: 'Đang kiểm tra',
  completed: 'Đã lưu kết quả kiểm tra',
  stopped: 'Chưa hoàn tất',
  interrupted: 'Bị gián đoạn — cần chạy lại',
};
const errors: Record<string, string> = {
  PLAN_CONTEXT_CHANGED:
    'Nguồn hoặc kết nối đã thay đổi. Hãy lưu kế hoạch mới từ bản xem trước rồi kiểm tra lại.',
  TOOL_FAILED: 'Không đọc được một nguồn hoặc dịch vụ. Kết quả chưa đầy đủ.',
  DEADLINE_EXCEEDED: 'Đã hết thời gian kiểm tra. Bạn có thể chạy lại với kế hoạch hiện tại.',
  CALL_BUDGET_EXCEEDED: 'Đã hết số lượt tra cứu cho lần kiểm tra này.',
};
Object.assign(errors, {
  KNOWLEDGE_OPEN_PLATFORM_UNAVAILABLE: 'Kho Open Platform chưa sẵn sàng tại máy chủ.',
  KNOWLEDGE_SELLER_VN_UNAVAILABLE: 'Kho Học viện Shopee VN chưa sẵn sàng tại máy chủ.',
  KNOWLEDGE_INTEGRITY_MISMATCH:
    'Tệp tài liệu đã đổi so với bản kê nguồn; cần đối chiếu lại bản chụp.',
  KNOWLEDGE_DOCUMENT_TOO_LARGE:
    'Tài liệu quá lớn để đọc đầy đủ trong công cụ; mở trang nguồn để kiểm tra.',
});
function SourceMeta({ source }: { source: KnowledgeSource }) {
  const showDate = (value: string | null) =>
    value
      ? Number.isNaN(Date.parse(value))
        ? value
        : new Date(value).toLocaleDateString('vi-VN')
      : 'Chưa ghi rõ';
  return (
    <p className="caption">
      {source.corpus === 'open-platform' ? 'Open Platform' : 'Học viện Shopee VN'} · Ngày nguồn:{' '}
      {showDate(source.sourceUpdatedAt)} · Chụp: {showDate(source.capturedAt)}
    </p>
  );
}
export function AssistantPanel({ plans }: { plans: ChangePlan[] }) {
  const [query, setQuery] = useState(''),
    [planId, setPlanId] = useState(''),
    [hits, setHits] = useState<KnowledgeHit[]>([]),
    [searched, setSearched] = useState(false),
    [warnings, setWarnings] = useState<string[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]),
    [active, setActive] = useState<Review | null>(null),
    [document, setDocument] = useState<{ source: KnowledgeSource; text: string } | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  async function refresh() {
    try {
      setReviews(await api<Review[]>('/v1/assistant/reviews'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (active) {
      const latest = reviews.find((r) => r.id === active.id);
      if (latest) setActive(latest);
    }
  }, [reviews]);
  async function search() {
    setBusy('search');
    setError('');
    setDocument(null);
    try {
      const result = await post<{ hits: KnowledgeHit[]; issues: string[] }>(
        '/v1/knowledge/search',
        { query },
      );
      setHits(result.hits);
      setWarnings(result.issues);
      setSearched(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function read(source: KnowledgeSource) {
    setBusy('read');
    setError('');
    setDocument(null);
    try {
      const result = await post<{ source: KnowledgeSource; text: string }>('/v1/knowledge/read', {
        documentId: source.id,
        ...(source.sha256 ? { expectedSha256: source.sha256 } : {}),
      });
      setDocument(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function review() {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    setBusy('review');
    setError('');
    try {
      const key = JSON.stringify([plan.id, plan.revision, plan.fingerprint, query]);
      if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
      const result = await post<Review>('/v1/assistant/reviews', {
        requestId: intent.current.requestId,
        planId: plan.id,
        revision: plan.revision,
        fingerprint: plan.fingerprint,
        query,
      });
      setActive(result);
      intent.current = null;
      await refresh();
    } catch (e) {
      const message = (e as Error).message;
      setError(errors[message] ?? message);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">NGUỒN & BẰNG CHỨNG</p>
          <h1>Tra cứu & kiểm tra</h1>
          <p>Đối chiếu kế hoạch và đọc tài liệu Shopee ngay trong workspace.</p>
        </div>
        <span className="tag neutral">Kiểm tra bằng chương trình</span>
      </div>
      <SellerKnowledgePanel />
      <div className="note">
        <strong>Giữ nguyên listing bạn đã chuẩn bị</strong>
        <p>
          Chức năng này đọc nguồn và lưu kết quả kiểm tra. Bộ kiểm tra ngành hàng đầy đủ và trợ lý
          AI còn đang triển khai. Kết quả ở đây chưa xác nhận đã đăng hoặc đã qua QC.
        </p>
      </div>
      {error && (
        <p role="alert" className="issue block">
          {error}
        </p>
      )}
      <section className="panel">
        <label htmlFor="knowledge-query">Từ khóa tài liệu</label>
        <div className="knowledge-search">
          <input
            id="knowledge-query"
            value={query}
            maxLength={300}
            placeholder="Ví dụ: get_attribute_tree, original_price, giá sản phẩm…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim() && !busy) void search();
            }}
          />
          <button disabled={!!busy || !query.trim()} onClick={() => void search()}>
            {busy === 'search' ? 'Đang tìm…' : 'Tìm tài liệu'}
          </button>
        </div>
        <p className="caption">
          Tìm theo từ khóa trong hai kho hiện có. Chưa có tự cập nhật tin mới hoặc trả lời bằng
          model AI.
        </p>
        <label htmlFor="review-plan">Kế hoạch cần kiểm tra</label>
        <div className="knowledge-search">
          <select
            id="review-plan"
            value={planId}
            onChange={(e) => {
              setPlanId(e.target.value);
              setActive(null);
            }}
          >
            <option value="">Chọn kế hoạch đã lưu</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.scope.environment === 'sandbox' ? 'TEST' : 'LIVE · chỉ đọc'} · {p.scope.shopId} ·{' '}
                {p.desired.title.value} · v{p.sourceRevision} · {date(p.createdAt)}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!!busy || !planId} onClick={() => void review()}>
            {busy === 'review' ? 'Đang đối chiếu…' : 'Kiểm tra kế hoạch'}
          </button>
        </div>
        <p className="caption">
          Có thể để trống từ khóa để chỉ kiểm tra dữ liệu nội bộ. Khi có từ khóa, hệ thống đọc đầy
          đủ tối đa ba tài liệu tìm được và lưu nguồn dẫn. Nguồn đã đổi cần lưu kế hoạch mới.
        </p>
      </section>
      {warnings.map((warning, index) => (
        <p key={index} className="issue warn">
          {errors[warning] ?? warning}
        </p>
      ))}
      {searched && (
        <section className="panel">
          <h2>Tài liệu tìm được</h2>
          {!hits.length && <p>Chưa tìm thấy tài liệu phù hợp. Thử tên API hoặc ít từ khóa hơn.</p>}
          {hits.map((hit) => (
            <article key={hit.id} data-testid="knowledge-hit" className="knowledge-hit">
              <a href={hit.url} target="_blank" rel="noreferrer">
                {hit.title}
              </a>
              <SourceMeta source={hit} />
              <p>{hit.excerpt}</p>
              <button disabled={!!busy} onClick={() => void read(hit)}>
                Đọc bản đầy đủ
              </button>
            </article>
          ))}
        </section>
      )}
      {document && (
        <section className="panel" aria-live="polite">
          <div className="section-heading">
            <h2>Bản tài liệu đầy đủ</h2>
            <button onClick={() => setDocument(null)}>Đóng tài liệu</button>
          </div>
          <a href={document.source.url} target="_blank" rel="noreferrer">
            {document.source.title} ↗
          </a>
          <SourceMeta source={document.source} />
          <p className="note">
            Bản chụp tham khảo; cần đối chiếu hiệu lực và phạm vi trước khi áp dụng.
          </p>
          <p className="caption">
            {document.source.integrity === 'manifest_verified'
              ? 'Tệp khớp với bản kê nguồn đã lưu.'
              : 'Đã đọc tệp; bản kê chưa có mã để xác minh tính toàn vẹn.'}
          </p>
          <pre className="knowledge-document" data-testid="knowledge-full-source">
            {document.text}
          </pre>
        </section>
      )}
      {active && (
        <section className="panel" aria-live="polite">
          <span className="tag neutral">{stateLabel[active.state] ?? active.state}</span>
          <h2>Kết quả đối chiếu</h2>
          <p>
            {active.scope.environment.toUpperCase()} · Shop {active.scope.shopId} ·{' '}
            {date(active.createdAt)}
          </p>
          <p>
            {active.result?.note ?? 'Lần kiểm tra chưa có kết quả cuối. Tiến độ đã lưu bên dưới.'}
          </p>
          {active.code && <p className="issue block">{errors[active.code] ?? active.code}</p>}
          {active.result?.inspection && <Issues issues={active.result.inspection.issues} />}
          <h3>Nguồn đã đọc đầy đủ</h3>
          {!active.result?.sources.length && (
            <p className="caption">Chưa có tài liệu đã đọc trong lần này.</p>
          )}
          {active.result?.sources.map((s) => (
            <article key={s.id} className="knowledge-hit">
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>
              <SourceMeta source={s} />
              <button disabled={!!busy} onClick={() => void read(s)}>
                Đọc lại bản nguồn
              </button>
            </article>
          ))}
          {active.result?.issues?.map((issue, index) => (
            <p key={index} className="issue warn">
              {issue}
            </p>
          ))}
          <details>
            <summary>Các bước đã thực hiện ({active.events.length})</summary>
            <ol>
              {active.events.map((event, index) => (
                <li key={index}>
                  {(
                    {
                      inspect_plan: 'Đọc kế hoạch',
                      search_knowledge: 'Tìm tài liệu',
                      read_source: 'Đọc toàn bài',
                    } as Record<string, string>
                  )[event.tool] ?? 'Công cụ không được phép'}{' '}
                  ·{' '}
                  {event.phase === 'started'
                    ? 'Bắt đầu'
                    : event.phase === 'completed'
                      ? 'Đã thực hiện'
                      : 'Đã dừng'}{' '}
                  · {(event.elapsedMs / 1000).toFixed(2)} giây {event.code ? `· ${event.code}` : ''}
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
      <section className="panel">
        <h2>Lịch sử kiểm tra</h2>
        <p className="caption">
          Lưu tại cơ sở dữ liệu, có thể xem lại sau khi tải lại trang. Kết quả là bằng chứng tại
          thời điểm kiểm tra.
        </p>
        {!reviews.length && <p>Chưa có lần kiểm tra kế hoạch nào.</p>}
        <div className="review-history">
          {reviews.map((r) => (
            <button key={r.id} onClick={() => setActive(r)}>
              <strong>{stateLabel[r.state] ?? r.state}</strong>
              <span>
                {r.scope.environment.toUpperCase()} · {r.scope.shopId} · {date(r.createdAt)}
              </span>
              <small>{r.query || 'Kiểm tra dữ liệu nội bộ'}</small>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
