import type { ReactNode } from 'react';
import type { PatchOperation, PatchPreview } from '@shopee/domain';

export function ImportPatchTable({
  operations,
  targets,
  selected,
  readOnly,
  disabled,
  labels,
  onToggle,
  renderValue,
}: {
  operations: PatchOperation[];
  targets: PatchPreview['targets'];
  selected: string[];
  readOnly: boolean;
  disabled: boolean;
  labels: Record<PatchOperation['field'], string>;
  onToggle: (id: string, checked: boolean) => void;
  renderValue: (op: PatchOperation, value: unknown) => ReactNode;
}) {
  if (!operations.length) return null;
  return (
    <div className="patch-table-scroll">
      <table className="patch-table" aria-label="Thay đổi giá, tồn và tiêu đề">
        <thead>
          <tr>
            <th scope="col">Chọn</th>
            <th scope="col">Listing / shop</th>
            <th scope="col">Trường / SKU</th>
            <th scope="col">Bản nguồn đã lưu</th>
            <th scope="col">Theo tệp mới</th>
            <th scope="col">Nguồn / kiểm tra</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((operation) => {
            const target = targets.find((item) => item.workOrderId === operation.workOrderId),
              label = labels[operation.field] + (operation.sku ? ' · ' + operation.sku : '');
            return (
              <tr key={operation.id} data-testid="patch-operation">
                <td data-label="Chọn">
                  {readOnly ? (
                    <span>Đã chọn</span>
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Chọn thay đổi ${label}`}
                      disabled={
                        disabled ||
                        operation.state !== 'changed' ||
                        operation.issues.some((issue) => issue.severity === 'block')
                      }
                      checked={selected.includes(operation.id)}
                      onChange={(event) => onToggle(operation.id, event.target.checked)}
                    />
                  )}
                </td>
                <td data-label="Listing / shop">
                  <strong>{target?.title}</strong>
                  <small>
                    {target?.shopName} · Link {target?.itemId}
                  </small>
                  <small>
                    {target?.environment === 'production' ? 'SHOP THẬT / CHỈ ĐỌC' : 'SANDBOX'}
                  </small>
                </td>
                <td data-label="Trường / SKU">
                  <strong>{label}</strong>
                  {operation.state !== 'changed' && (
                    <small>{operation.state === 'blocked' ? 'Cần xử lý' : 'Giữ nguyên'}</small>
                  )}
                </td>
                <td data-label="Bản nguồn đã lưu">{renderValue(operation, operation.before)}</td>
                <td data-label="Theo tệp mới">
                  <div data-testid="patch-after">{renderValue(operation, operation.after)}</div>
                </td>
                <td data-label="Nguồn / kiểm tra">
                  <details>
                    <summary>{operation.issues.length ? 'Cần kiểm tra' : 'Ô nguồn'}</summary>
                    {operation.sources.map((source, index) => (
                      <p key={index}>
                        {source.filename} · {source.locator}
                      </p>
                    ))}
                    {operation.issues.map((issue, index) => (
                      <p
                        className={issue.severity === 'block' ? 'error' : ''}
                        key={'issue-' + index}
                      >
                        {issue.message}
                      </p>
                    ))}
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
