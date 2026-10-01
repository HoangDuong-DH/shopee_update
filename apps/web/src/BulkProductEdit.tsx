import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ListingDraft } from '@shopee/domain';
import type { BulkProductEditService } from '../../api/src/bulk-product-edit-service.js';
import type { BulkProductEditInput } from '../../../packages/domain/src/bulk-product-edit.js';
import { api, RequestError } from './api.js';

type Preview = Awaited<ReturnType<BulkProductEditService['preview']>>;
type Apply = { input: BulkProductEditInput; expectedDigest: string };
const recoveryKey = 'local-bulk-product-edit-v1';
const workingKey = 'local-bulk-product-edit-working-v1';
const workingSchema = z.object({
  version: z.literal(1),
  selected: z
    .array(z.object({ productKey: z.string(), revision: z.number().int().positive() }))
    .max(80),
  volumeText: z.string().max(2000),
  sort: z.boolean(),
  search: z.string().max(500),
  removed: z.record(z.string(), z.array(z.string()).max(2000)),
});
function restoreWorking(products: ListingDraft[]) {
  const empty = {
    selected: [] as string[],
    removed: {} as Record<string, string[]>,
    volumeText: '',
    sort: true,
    search: '',
    notice: '',
  };
  try {
    const raw = sessionStorage.getItem(workingKey);
    if (!raw) return empty;
    const parsed = workingSchema.parse(JSON.parse(raw));
    const selected = parsed.selected.filter((entry) =>
      products.some((product) => product.productKey === entry.productKey),
    );
    const sameRevision = selected.filter((entry) =>
      products.some(
        (product) => product.productKey === entry.productKey && product.revision === entry.revision,
      ),
    );
    const removed = Object.fromEntries(
      sameRevision.map((entry) => [entry.productKey, parsed.removed[entry.productKey] ?? []]),
    );
    const changedCount = selected.length - sameRevision.length,
      missingCount = parsed.selected.length - selected.length;
    return {
      ...parsed,
      selected: selected.map((entry) => entry.productKey),
      removed,
      notice: `Đã khôi phục lựa chọn chỉnh phân loại. Xem trước lại theo nguồn hiện tại trước khi lưu.${changedCount ? ` ${changedCount} bộ đã đổi phiên bản nên cần chọn lại các phân loại bỏ riêng.` : ''}${missingCount ? ` ${missingCount} bộ không còn trong danh sách đang dùng.` : ''}`,
    };
  } catch {
    return {
      ...empty,
      notice:
        'Không đọc được lựa chọn tạm. Các bộ nguồn đã lưu vẫn còn trong kho; chọn lại để tiếp tục.',
    };
  }
}
const errorText = (error: unknown) =>
  error instanceof RequestError && error.code === 'PRODUCT_REVISION_CONFLICT'
    ? 'Có bộ nguồn vừa được người khác sửa. Lựa chọn của bạn vẫn giữ ở đây; đọc lại nguồn và xem trước lần nữa trước khi lưu.'
    : error instanceof Error
      ? error.message
      : 'Chưa xác nhận được việc lưu. Đọc lại kết quả trước khi làm tiếp.';

/** Edits saved local drafts only. Stock and shop logistics remain preparation decisions. */
export function BulkProductEdit({
  products,
  onSaved,
  onPrepare,
  onBusy,
}: {
  products: ListingDraft[];
  onSaved: () => void;
  onPrepare?: () => void;
  onBusy?: (value: boolean) => void;
}) {
  const [restored] = useState(() => restoreWorking(products));
  const [selected, setSelected] = useState<string[]>(restored.selected),
    [volumeText, setVolumeText] = useState(restored.volumeText),
    [sort, setSort] = useState(restored.sort),
    [removed, setRemoved] = useState<Record<string, string[]>>(restored.removed),
    [search, setSearch] = useState(restored.search),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(restored.notice),
    [recovery, setRecovery] = useState<Apply | null>(() => {
      try {
        const value = JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null');
        return value?.input?.operationId && value?.expectedDigest ? value : null;
      } catch {
        return null;
      }
    });
  const lock = useRef(false);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => {
    onBusyRef.current?.(busy);
    return () => onBusyRef.current?.(false);
  }, [busy]);
  const knownRevisions = useRef(
    new Map(products.map((product) => [product.productKey, product.revision])),
  );
  useEffect(() => {
    const changedKeys = selected.filter((key) => {
      const revision = products.find((product) => product.productKey === key)?.revision;
      return (
        revision !== undefined &&
        knownRevisions.current.has(key) &&
        knownRevisions.current.get(key) !== revision
      );
    });
    knownRevisions.current = new Map(
      products.map((product) => [product.productKey, product.revision]),
    );
    if (!changedKeys.length || recovery) return;
    if (preview || changedKeys.some((key) => removed[key]?.length)) {
      setPreview(null);
      setRemoved((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !changedKeys.includes(key))),
      );
      setNotice(
        `${changedKeys.length} bộ đã có phiên bản mới. Chọn lại các phân loại bỏ riêng và xem trước lại; tiêu chí dung tích vẫn giữ.`,
      );
    }
  }, [products]);
  useEffect(() => {
    if (recovery) return;
    try {
      if (!selected.length && !volumeText && !search) {
        sessionStorage.removeItem(workingKey);
        return;
      }
      const state = workingSchema.parse({
        version: 1,
        selected: selected.flatMap((productKey) => {
          const product = products.find((value) => value.productKey === productKey);
          return product ? [{ productKey, revision: product.revision }] : [];
        }),
        volumeText,
        sort,
        removed,
        search,
      });
      sessionStorage.setItem(workingKey, JSON.stringify(state));
    } catch {
      setNotice('Chưa giữ được lựa chọn tạm trong trình duyệt. Giữ trang này mở đến khi lưu xong.');
    }
  }, [selected, volumeText, sort, removed, search, products, recovery]);
  const visible = products.filter((product) =>
    [product.title.value, ...product.variants.map((variant) => variant.sku.value)].some((text) =>
      text.toLocaleLowerCase('vi-VN').includes(search.toLocaleLowerCase('vi-VN')),
    ),
  );
  const hiddenSelected = selected.filter(
    (key) => !visible.some((product) => product.productKey === key),
  ).length;
  function changed() {
    setPreview(null);
    setNotice('');
    setError('');
  }
  async function inspect() {
    if (lock.current || recovery) return;
    const volumes = volumeText.trim()
      ? volumeText.split(/[;\s]+/).map((value) => Number(value.replace(',', '.')))
      : [];
    if (volumes.some((value) => !Number.isFinite(value) || value <= 0)) {
      setError('Nhập dung tích theo ml, ngăn cách bằng dấu chấm phẩy. Ví dụ: 50; 280.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const input: BulkProductEditInput = {
        operationId: crypto.randomUUID(),
        removeVolumesMl: [...new Set(volumes)],
        sortVolumeDescending: sort,
        entries: selected.map((productKey) => {
          const product = products.find((value) => value.productKey === productKey);
          if (!product)
            throw Error(
              'Một bộ đã chọn không còn trong kho hiện tại. Đọc lại nguồn rồi chọn lại; các lựa chọn khác vẫn được giữ.',
            );
          return {
            productKey,
            expectedRevision: product.revision,
            removeVariantKeys: removed[productKey] ?? [],
          };
        }),
      };
      setPreview(
        await api<Preview>('/v1/products/bulk-edit/preview', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function apply(request: Apply) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      // Persist the exact operation before sending; replay recovers its local receipt atomically.
      sessionStorage.setItem(recoveryKey, JSON.stringify(request));
      setRecovery(request);
      const result = await api<Preview & { recovered: boolean }>('/v1/products/bulk-edit/apply', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      sessionStorage.removeItem(recoveryKey);
      setRecovery(null);
      setPreview(null);
      setRemoved({});
      setNotice(
        `${result.recovered ? 'Đã đọc lại lần lưu trước' : 'Đã lưu'}: ${result.changedCount} bộ nguồn có phiên bản mới. Chưa gửi thay đổi lên Shopee. Chuẩn bị lại lô từ nguồn mới khi cần đăng.`,
      );
      onSaved();
    } catch (reason) {
      if (
        reason instanceof RequestError &&
        ['PRODUCT_REVISION_CONFLICT', 'BULK_EDIT_BLOCKED', 'BULK_EDIT_PREVIEW_CHANGED'].includes(
          reason.code,
        )
      ) {
        sessionStorage.removeItem(recoveryKey);
        setRecovery(null);
        setPreview(null);
      }
      setError(errorText(reason));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Chỉnh phân loại hàng loạt">
      <h2>Chỉnh phân loại hàng loạt</h2>
      <p>
        Sửa bản nguồn đã lưu trong ứng dụng. SKU, giá và ảnh của các phân loại giữ lại vẫn lấy từ
        đúng nguồn; các link trên Shopee chưa bị thay đổi.
      </p>
      <p>
        Tồn kho và vận chuyển áp dụng tại “Điền một lần cho cả lô” trong Chuẩn bị lô mới, theo đúng
        shop đã chọn.{' '}
        {onPrepare && (
          <button type="button" disabled={busy || !!recovery} onClick={onPrepare}>
            Mở Chuẩn bị lô mới
          </button>
        )}
      </p>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {recovery && (
        <p role="status" className="notice warning">
          Có lần lưu chưa xác nhận kết quả.{' '}
          <button type="button" disabled={busy} onClick={() => void apply(recovery)}>
            Khôi phục kết quả lần lưu
          </button>
        </p>
      )}
      <fieldset disabled={busy || !!recovery}>
        <legend>Chọn nguồn và thao tác</legend>
        <label>
          Tìm bộ nguồn để chỉnh phân loại
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tên sản phẩm hoặc SKU"
          />
        </label>
        <p>
          {selected.length}/80 bộ đã chọn · {visible.length} bộ trong kết quả
          {hiddenSelected ? ` · ${hiddenSelected} bộ đã chọn đang ngoài bộ lọc` : ''}. Thay đổi bộ
          lọc không bỏ lựa chọn.
        </p>
        <button
          type="button"
          disabled={
            !visible.some((product) => !selected.includes(product.productKey)) ||
            selected.length >= 80
          }
          onClick={() => {
            changed();
            setSelected((previous) =>
              [...new Set([...previous, ...visible.map((product) => product.productKey)])].slice(
                0,
                80,
              ),
            );
          }}
        >
          Chọn các bộ trong kết quả (tối đa 80)
        </button>
        <button
          type="button"
          disabled={!selected.length}
          onClick={() => {
            changed();
            setSelected([]);
            setRemoved({});
          }}
        >
          Bỏ chọn tất cả bộ nguồn
        </button>
        <label>
          Dung tích cần bỏ (ml, cách nhau bằng dấu ;){' '}
          <input
            value={volumeText}
            placeholder="50; 280"
            onChange={(event) => {
              changed();
              setVolumeText(event.target.value);
            }}
          />
        </label>
        <p>
          Bộ combo có ghi dung tích đã chọn cũng sẽ được đề xuất bỏ; kiểm tra từng SKU trong bản xem
          trước.
        </p>
        <label>
          <input
            type="checkbox"
            checked={sort}
            onChange={(event) => {
              changed();
              setSort(event.target.checked);
            }}
          />
          Sắp xếp dung tích giảm dần; cùng dung tích thì chai lẻ trước combo
        </label>
        <ul>
          {visible.map((product) => (
            <li key={product.productKey}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(product.productKey)}
                  disabled={!selected.includes(product.productKey) && selected.length >= 80}
                  onChange={(event) => {
                    changed();
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, product.productKey]
                        : previous.filter((key) => key !== product.productKey),
                    );
                  }}
                />
                {product.title.value} · bản {product.revision} · {product.variants.length} phân loại
              </label>
              {selected.includes(product.productKey) && (
                <details>
                  <summary>Chọn từng phân loại cần bỏ</summary>
                  {product.variants.map((variant) => (
                    <label key={variant.key} style={{ display: 'block' }}>
                      <input
                        type="checkbox"
                        checked={(removed[product.productKey] ?? []).includes(variant.key)}
                        onChange={(event) => {
                          changed();
                          setRemoved((previous) => ({
                            ...previous,
                            [product.productKey]: event.target.checked
                              ? [...(previous[product.productKey] ?? []), variant.key]
                              : (previous[product.productKey] ?? []).filter(
                                  (key) => key !== variant.key,
                                ),
                          }));
                        }}
                      />
                      {variant.optionLabels.join(' / ') || 'Sản phẩm lẻ'} · SKU {variant.sku.value}{' '}
                      · {variant.originalPrice.value} đ
                    </label>
                  ))}
                </details>
              )}
            </li>
          ))}
        </ul>
        <button type="button" disabled={!selected.length} onClick={() => void inspect()}>
          Xem trước {selected.length} bộ đã chọn
        </button>
      </fieldset>
      {preview && (
        <section aria-label="Phạm vi thay đổi phân loại">
          <p>
            <strong>
              {preview.changedCount} bộ có thay đổi · {preview.blockedCount} bộ cần xử lý trước
            </strong>
            . Chưa lưu và chưa đăng lên Shopee.
          </p>
          {preview.entries.map((entry) => (
            <details key={entry.productKey} open={entry.issues.length > 0}>
              <summary>
                {entry.title} · bản {entry.expectedRevision} → {entry.nextRevision} ·{' '}
                {entry.beforeCount} → {entry.afterCount} phân loại
              </summary>
              {entry.issues.map((issue) => (
                <p key={issue.code} role="alert">
                  {issue.message}
                </p>
              ))}
              {entry.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <p>
                Bỏ:{' '}
                {entry.removed.length
                  ? entry.removed
                      .map((variant) => `${variant.labels.join(' / ')} (${variant.sku})`)
                      .join('; ')
                  : 'Không bỏ phân loại'}
              </p>
              <ol>
                {entry.models.map((model) => (
                  <li key={model.key}>
                    {model.labels.join(' / ') || 'Sản phẩm lẻ'} · {model.sku} · {model.price} đ
                    <small>
                      {' '}
                      ·{' '}
                      {model.priceSources
                        .map((source) => `${source.filename ?? 'Nguồn giá'}: ${source.locator}`)
                        .join('; ')}
                    </small>
                  </li>
                ))}
              </ol>
            </details>
          ))}
          {preview.blockedCount > 0 && (
            <button
              type="button"
              disabled={busy || !!recovery}
              onClick={() => {
                setSelected(
                  preview.entries
                    .filter((entry) => !entry.issues.length)
                    .map((entry) => entry.productKey),
                );
                changed();
              }}
            >
              Chỉ giữ các bộ sửa được để xem trước lại
            </button>
          )}
          <button
            type="button"
            disabled={busy || !!recovery || preview.blockedCount > 0 || preview.changedCount === 0}
            onClick={() => void apply({ input: preview.input, expectedDigest: preview.digest })}
          >
            Lưu {preview.changedCount} bộ nguồn đã xem trước
          </button>
        </section>
      )}
    </section>
  );
}
