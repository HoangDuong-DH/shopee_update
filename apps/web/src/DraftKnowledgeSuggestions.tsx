import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

type Suggestion = {
  attributeId: number;
  name: string;
  values: { valueId: number; displayName: string; valueUnit?: string }[];
  canPrefill: boolean;
  sourceClass: string;
  reasons: string[];
  evidenceIds: string[];
};
type Result = {
  target: {
    productKey: string;
    expectedRevision: number;
    connectionId: string;
    categoryId: number;
    brandId: number;
  };
  fingerprint: string;
  metadata: { observedAt: string; expiresAt: string };
  recommendations: { suggestions: Suggestion[]; issues: { detail: string }[] };
  sourceFacts: { attributeId: number; sourceLocator: string }[];
};
export type DraftKnowledgeAcceptance = {
  id: string;
  target: Result['target'];
  attributeList: any[];
  metadata: { expiresAt: string };
};
const reasons: Record<string, string> = {
  CONFLICTING_EVIDENCE: 'Các nguồn chưa thống nhất.',
  CANDIDATE_COVERAGE_INCOMPLETE: 'Chưa kiểm hết nguồn lịch sử.',
  SENSITIVE_ATTRIBUTE_REQUIRES_PRODUCT_SOURCE: 'Cần thông tin đã xác nhận của chính sản phẩm.',
  PARTIAL_SKU_COVERAGE: 'Nguồn tham khảo chưa bao phủ đủ SKU.',
};

/** Reading suggestions and accepting them are separate actions; neither changes a saved draft. */
export function DraftKnowledgeSuggestions({
  productKey,
  expectedRevision,
  shopId,
  partnerId,
  categoryId,
  brandId,
  acceptedId,
  onAccepted,
}: {
  productKey: string;
  expectedRevision: number;
  shopId: string;
  partnerId?: string;
  categoryId?: string;
  brandId?: string;
  acceptedId?: string;
  onAccepted: (receipt: DraftKnowledgeAcceptance) => void;
}) {
  const [result, setResult] = useState<Result | null>(null),
    [selected, setSelected] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [evidence, setEvidence] = useState<any>(null);
  const alive = useRef(true),
    pending = useRef<any>(null),
    locked = useRef(false),
    generation = useRef(0),
    evidenceRequest = useRef<AbortController | null>(null),
    targetKey = `${productKey}:${expectedRevision}:${shopId}:${partnerId}:${categoryId}:${brandId}`,
    currentKey = useRef(targetKey);
  if (currentKey.current !== targetKey) {
    currentKey.current = targetKey;
    generation.current++;
  }
  useEffect(() => {
    alive.current = true;
    locked.current = false;
    setBusy(false);
    setResult(null);
    setSelected([]);
    setEvidence(null);
    evidenceRequest.current?.abort();
    evidenceRequest.current = null;
    setError('');
    pending.current = null;
    return () => {
      alive.current = false;
      generation.current++;
      evidenceRequest.current?.abort();
      evidenceRequest.current = null;
    };
  }, [targetKey]);
  const eligibleTarget = !!categoryId && brandId !== undefined && brandId !== '';
  async function read() {
    if (!eligibleTarget || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    evidenceRequest.current?.abort();
    evidenceRequest.current = null;
    setEvidence(null);
    const key = targetKey,
      version = generation.current;
    try {
      const { shops } = await api<{
        shops: {
          id: string;
          state: string;
          scope: { environment: string; partnerId: string; shopId: string };
        }[];
      }>('/v1/seller-knowledge/shops');
      const matching = shops.filter(
        (shop) =>
          shop.state === 'connected' &&
          shop.scope.environment === 'production' &&
          shop.scope.shopId === shopId &&
          (!partnerId || shop.scope.partnerId === partnerId),
      );
      if (matching.length !== 1)
        throw Error(
          'Cần xác định đúng một kết nối đang hoạt động cho shop này. Kiểm tra mục Kết nối shop.',
        );
      const value = await api<Result>('/v1/seller-knowledge/draft-recommendations', {
        method: 'POST',
        body: JSON.stringify({
          productKey,
          expectedRevision,
          connectionId: matching[0]!.id,
          categoryId: Number(categoryId),
          brandId: Number(brandId),
        }),
      });
      if (alive.current && currentKey.current === key && generation.current === version) {
        setResult(value);
        setSelected([]);
        pending.current = null;
      }
    } catch (error) {
      if (alive.current && currentKey.current === key && generation.current === version)
        setError(error instanceof Error ? error.message : 'Chưa đọc được gợi ý.');
    } finally {
      if (alive.current && currentKey.current === key && generation.current === version) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  async function accept() {
    if (!result || !selected.length || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const key = targetKey,
      version = generation.current;
    pending.current ??= {
      ...result.target,
      requestId: crypto.randomUUID(),
      recommendationFingerprint: result.fingerprint,
      attributeIds: selected,
    };
    // The API target also contains diagnostic bindings; send only its public request fields.
    const {
      productKey,
      expectedRevision,
      connectionId,
      categoryId,
      brandId,
      requestId,
      recommendationFingerprint,
      attributeIds,
    } = pending.current;
    try {
      const receipt = await api<DraftKnowledgeAcceptance>(
        '/v1/seller-knowledge/draft-acceptances',
        {
          method: 'POST',
          body: JSON.stringify({
            productKey,
            expectedRevision,
            connectionId,
            categoryId,
            brandId,
            requestId,
            recommendationFingerprint,
            attributeIds,
          }),
        },
      );
      if (alive.current && currentKey.current === key && generation.current === version) {
        if (
          receipt.target.productKey !== productKey ||
          receipt.target.expectedRevision !== expectedRevision ||
          receipt.target.connectionId !== connectionId ||
          receipt.target.categoryId !== categoryId ||
          receipt.target.brandId !== brandId
        )
          throw Error('Phiếu lựa chọn không khớp bản nháp hiện tại. Đọc lại gợi ý.');
        if (
          !Number.isFinite(Date.parse(receipt.metadata.expiresAt)) ||
          Date.parse(receipt.metadata.expiresAt) <= Date.now()
        )
          throw Error('Phiếu lựa chọn đã hết hạn đối chiếu. Đọc lại gợi ý.');
        onAccepted(receipt);
        pending.current = null;
      }
    } catch (error) {
      if (alive.current && currentKey.current === key && generation.current === version)
        setError(
          error instanceof Error
            ? error.message
            : 'Chưa nhận được phiếu lựa chọn. Thử lại cùng lựa chọn để lấy kết quả.',
        );
    } finally {
      if (alive.current && currentKey.current === key && generation.current === version) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  async function showEvidence(id: string, label: string) {
    const key = targetKey,
      version = generation.current,
      request = new AbortController();
    evidenceRequest.current?.abort();
    evidenceRequest.current = request;
    setError('');
    setEvidence({ label, loading: true });
    const isCurrent = () =>
      alive.current &&
      currentKey.current === key &&
      generation.current === version &&
      evidenceRequest.current === request &&
      !request.signal.aborted;
    try {
      const value = await api<any>('/v1/seller-knowledge/evidence/' + encodeURIComponent(id), {
        signal: request.signal,
      });
      if (isCurrent()) setEvidence({ ...value, label });
    } catch (error) {
      if (isCurrent()) {
        setEvidence(null);
        setError(error instanceof Error ? error.message : 'Chưa đọc được nguồn.');
      }
    }
  }
  return (
    <section className="preparation-knowledge" aria-label="Gợi ý thuộc tính cho bản nháp">
      <h4>Gợi ý có nguồn</h4>
      <p>
        Thông tin sản phẩm đã xác nhận có thể chọn cho bản xem trước. Dữ liệu listing khác chỉ để
        tham khảo.
      </p>
      {!eligibleTarget && <p>Chọn ngành và thương hiệu trước khi đọc gợi ý.</p>}
      <button
        type="button"
        className="secondary"
        disabled={busy || !eligibleTarget}
        onClick={() => void read()}
      >
        {busy ? 'Đang đối chiếu…' : 'Đọc gợi ý có nguồn'}
      </button>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {acceptedId && (
        <p role="status">Đã lưu lựa chọn cho bản xem trước. Bộ nguồn gốc được giữ nguyên.</p>
      )}
      {result && (
        <>
          <p>
            Thông tin ngành đọc lúc{' '}
            {new Date(result.metadata.observedAt).toLocaleTimeString('vi-VN')} · Hạn đối chiếu{' '}
            {new Date(result.metadata.expiresAt).toLocaleTimeString('vi-VN')}.
          </p>
          {result.recommendations.issues.map((issue, i) => (
            <p className="notice warning" key={i}>
              {issue.detail}
            </p>
          ))}
          {!result.recommendations.suggestions.length && (
            <p>Chưa có gợi ý đủ nguồn cho bản nháp này.</p>
          )}
          {result.recommendations.suggestions.map((suggestion) => (
            <div key={suggestion.attributeId}>
              <label>
                <input
                  type="checkbox"
                  aria-label={'Chọn ' + suggestion.name}
                  disabled={
                    busy || !suggestion.canPrefill || suggestion.sourceClass !== 'product_source'
                  }
                  checked={selected.includes(suggestion.attributeId)}
                  onChange={(event) => {
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, suggestion.attributeId]
                        : current.filter((id) => id !== suggestion.attributeId),
                    );
                    pending.current = null;
                  }}
                />
                {suggestion.name}:{' '}
                {suggestion.values
                  .map((value) => [value.displayName, value.valueUnit].filter(Boolean).join(' '))
                  .join(', ') || 'Cần đối chiếu thêm'}
              </label>
              <p>
                {suggestion.canPrefill
                  ? 'Đã xác nhận từ nguồn sản phẩm; cần bạn chọn để dùng.'
                  : 'Tham khảo; chưa tự điền vào sản phẩm.'}
              </p>
              {result.sourceFacts
                .filter((fact) => fact.attributeId === suggestion.attributeId)
                .map((fact, i) => (
                  <p key={i}>{fact.sourceLocator}</p>
                ))}
              {suggestion.reasons
                .filter((reason) => reasons[reason])
                .map((reason) => (
                  <p key={reason}>{reasons[reason]}</p>
                ))}
              {(suggestion.sourceClass === 'product_source' ? [] : suggestion.evidenceIds)
                .filter((id) => /^[a-f0-9-]{36}$/.test(id))
                .map((id, i) => (
                  <button
                    type="button"
                    className="secondary"
                    key={id}
                    onClick={() =>
                      void showEvidence(id, 'Nguồn tham khảo ' + (i + 1) + ' · ' + suggestion.name)
                    }
                  >
                    Xem nguồn tham khảo {i + 1}
                  </button>
                ))}
            </div>
          ))}
          {selected.length > 0 && (
            <p>Thông tin đã chọn sẽ thay thế đúng các thuộc tính tương ứng trong bản xem trước.</p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={
              busy || !selected.length || Date.parse(result.metadata.expiresAt) <= Date.now()
            }
            onClick={() => void accept()}
          >
            Dùng thông tin đã chọn trong bản xem trước
          </button>
        </>
      )}
      {evidence && (
        <details open>
          <summary>{evidence.label ?? 'Nguồn listing đã lưu'}</summary>
          {evidence.loading ? (
            <p role="status">Đang đọc nguồn đã chọn…</p>
          ) : (
            <>
              <p>
                {evidence.body?.title} · Đọc lúc{' '}
                {new Date(evidence.observedAt).toLocaleString('vi-VN')}
              </p>
              <pre>{JSON.stringify(evidence.body?.attributes, null, 2)}</pre>
            </>
          )}
        </details>
      )}
    </section>
  );
}
