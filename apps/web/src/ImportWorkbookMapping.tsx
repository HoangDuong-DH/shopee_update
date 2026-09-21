import type { PatchWorkbook, WorkOrderView } from '@shopee/domain';
export type WorkbookUse = { id: string; blockKey: string; workOrderIds: string[] };
export function ImportWorkbookMapping({
  name,
  workbook,
  uses,
  targets,
  busy,
  onChange,
}: {
  name: string;
  workbook: PatchWorkbook;
  uses: WorkbookUse[];
  targets: WorkOrderView[];
  busy: boolean;
  onChange: (uses: WorkbookUse[]) => void;
}) {
  const update = (id: string, value: Partial<WorkbookUse>) =>
    onChange(uses.map((use) => (use.id === id ? { ...use, ...value } : use)));
  const shops = [
    ...new Map(
      targets.filter((target) => target.shop).map((target) => [target.shop!.id, target.shop!]),
    ).values(),
  ];
  return (
    <div className="patch-workbook">
      <h3>{name}</h3>
      {uses.map((use, index) => {
        const block = workbook.blocks.find((block) => block.key === use.blockKey),
          scopeName = block?.priceProfile ?? block?.sheet ?? 'bộ dữ liệu';
        return (
          <div className="patch-workbook-use" key={use.id}>
            <label>
              Sheet và bộ giá
              <select
                aria-label={`Khối dữ liệu ${name}${index ? ' ' + (index + 1) : ''}`}
                value={use.blockKey}
                disabled={busy}
                onChange={(event) => update(use.id, { blockKey: event.target.value })}
              >
                <option value="">Chọn sheet / khối dữ liệu</option>
                {workbook.blocks.map((block) => (
                  <option key={block.key} value={block.key}>
                    {block.sheet} · {block.priceProfile ?? 'Bộ giá trong bảng'} · tiêu đề dòng{' '}
                    {block.headerRow}
                  </option>
                ))}
              </select>
            </label>
            <p className="caption">
              {block?.fields
                .map(
                  (field) =>
                    ({
                      price: 'Giá gốc',
                      stock: 'Tồn đăng bán',
                      promotionTarget: 'Mục tiêu khuyến mại — chưa áp dụng',
                    })[field],
                )
                .join(' · ') || 'Chọn khối dữ liệu rồi xác định công việc áp dụng bên dưới.'}
            </p>
            {block && (
              <fieldset className="patch-workbook-targets" disabled={busy}>
                <legend>Áp dụng {scopeName} cho</legend>
                {shops.map((shop) => (
                  <div key={shop.id}>
                    <div className="patch-shop-select">
                      <strong>{shop.name}</strong>
                      <button
                        type="button"
                        onClick={() =>
                          update(use.id, {
                            workOrderIds: [
                              ...new Set([
                                ...use.workOrderIds,
                                ...targets
                                  .filter((target) => target.shop?.id === shop.id)
                                  .map((target) => target.id),
                              ]),
                            ],
                          })
                        }
                      >
                        Chọn cả shop
                      </button>
                    </div>
                    {targets
                      .filter((target) => target.shop?.id === shop.id)
                      .map((target) => (
                        <label key={target.id} className="patch-image-pick">
                          <input
                            type="checkbox"
                            aria-label={`Áp dụng ${scopeName} cho ${target.source.title.value} · ${shop.name} · ${target.config.itemId}`}
                            checked={use.workOrderIds.includes(target.id)}
                            onChange={(event) =>
                              update(use.id, {
                                workOrderIds: event.target.checked
                                  ? [...use.workOrderIds, target.id]
                                  : use.workOrderIds.filter((id) => id !== target.id),
                              })
                            }
                          />
                          <span>
                            {target.source.title.value}
                            <small>
                              Link {target.config.itemId} · {target.source.variants.length} SKU
                            </small>
                          </span>
                        </label>
                      ))}
                  </div>
                ))}
                {!use.workOrderIds.length && (
                  <p className="caption">
                    Chưa chọn công việc cho bộ giá này. Ứng dụng không tự áp sang mọi shop.
                  </p>
                )}
              </fieldset>
            )}
            {uses.length > 1 && (
              <button
                disabled={busy}
                onClick={() => onChange(uses.filter((value) => value.id !== use.id))}
              >
                Bỏ ánh xạ này
              </button>
            )}
          </div>
        );
      })}
      <button
        disabled={busy}
        aria-label={`Thêm sheet hoặc bộ giá từ ${name}`}
        onClick={() =>
          onChange([
            ...uses,
            {
              id: crypto.randomUUID(),
              blockKey: '',
              workOrderIds: targets.length === 1 ? [targets[0].id] : [],
            },
          ])
        }
      >
        Thêm sheet / bộ giá
      </button>
      <p className="caption">
        Ô trống giữ nguyên; tồn 0 là yêu cầu đặt về 0. Một file có thể dùng nhiều bộ giá với đích
        riêng.
      </p>
      {workbook.issues.length > 0 && (
        <ul className="patch-issues">
          {workbook.issues.map((issue, index) => (
            <li key={index} className={issue.severity === 'block' ? 'error' : ''}>
              {issue.message}
              {issue.sources.map((source, i) => (
                <small key={i}>
                  {source.filename} · {source.locator}
                </small>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
