import type { Fact, Issue, SourceRef } from '../contracts.js';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { checkOfficeArchive } from './archive.js';
import { headerKey, parseVnd } from './normalize.js';
export type PatchColumn = 'price' | 'stock' | 'promotionTarget';
export type PatchWorkbookBlock = {
  key: string;
  sheet: string;
  headerRow: number;
  priceProfile: string | null;
  fields: PatchColumn[];
  issues: Issue[];
};
export type PatchWorkbookRow = {
  key: string;
  blockKey: string;
  sheet: string;
  row: number;
  sku: string;
  values: Partial<{ price: Fact<string>; stock: Fact<number>; promotionTarget: Fact<string> }>;
  issues: Issue[];
  source: SourceRef;
};
export type PatchWorkbook = {
  source: SourceRef;
  blocks: PatchWorkbookBlock[];
  rows: PatchWorkbookRow[];
  issues: Issue[];
};
function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value && typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      // ExcelJS omits a cached numeric zero from cell.value, but exposes it via cell.result.
      const cached = cell.result;
      if (cached === undefined || cached === null || cached === '')
        throw new Error('PATCH_FORMULA_CACHE_REQUIRED');
      if (typeof cached === 'object') throw new Error('PATCH_CELL_ERROR');
      return cached;
    }
    if ('error' in value) throw new Error('PATCH_CELL_ERROR');
    if ('richText' in value) return value.richText.map((item) => item.text).join('');
    if ('text' in value) return value.text;
    throw new Error('PATCH_CELL_UNSUPPORTED');
  }
  return value;
}
const labels = new Map<string, 'sku' | PatchColumn>([
  ['SKU', 'sku'],
  ['MA SKU', 'sku'],
  ['GIA GOC', 'price'],
  ['GIA BAN', 'promotionTarget'],
  ['TON DANG BAN', 'stock'],
]);
const blank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && !value.trim());
export async function readPatchWorkbook(
  bytes: Uint8Array,
  filename = 'update.xlsx',
  observedAt = new Date().toISOString(),
): Promise<PatchWorkbook> {
  checkOfficeArchive(bytes);
  const source: SourceRef = {
    kind: 'product_file',
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    filename,
    locator: filename,
    observedAt,
  };
  const result: PatchWorkbook = { source, blocks: [], rows: [], issues: [] };
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  const issue = (
    code: string,
    field: string,
    locator: string,
    severity: 'block' | 'warn' = 'block',
  ): Issue => ({
    code,
    field,
    severity,
    message:
      (
        {
          PATCH_UNSUPPORTED_COLUMN:
            'Cột này chưa được ánh xạ cho bộ cập nhật; dữ liệu chưa được áp dụng.',
          PATCH_AMBIGUOUS_COLUMN: 'Có nhiều cột cùng nghĩa; cần chọn rõ bộ giá hoặc cột.',
          PATCH_DUPLICATE_SKU:
            'SKU xuất hiện nhiều lần trong cùng khối; cần đối chiếu trước khi áp dụng.',
          PATCH_FORMULA_CACHE_REQUIRED:
            'Công thức chưa có kết quả lưu rõ ràng. Mở Excel tính lại rồi lưu.',
          PATCH_CELL_ERROR: 'Ô Excel có lỗi, không được hiểu là ô trống.',
          PATCH_SKU_NOT_TEXT: 'SKU phải ở dạng chữ để giữ nguyên mã và số 0 đầu.',
          PATCH_INVALID_PRICE: 'Giá phải là số nguyên VND dương rõ ràng.',
          PATCH_INVALID_STOCK: 'Tồn đăng bán phải là số nguyên từ 0.',
          PATCH_HEADER_REQUIRED: 'Chưa tìm thấy cột SKU cùng cột cập nhật.',
        } as Record<string, string>
      )[code] ?? 'Ô nguồn chưa thể đọc chính xác.',
    sources: [{ ...source, locator }],
  });
  for (const sheet of book.worksheets) {
    let active: { block: PatchWorkbookBlock; columns: Map<'sku' | PatchColumn, number> }[] = [];
    sheet.eachRow((row, rowNumber) => {
      const headers: { column: number; label: string; field?: 'sku' | PatchColumn }[] = [];
      row.eachCell((cell, column) => {
        if (cell.isMerged && Number(cell.master.col) !== column) return;
        try {
          const value = cellValue(cell);
          if (typeof value === 'string')
            headers.push({ column, label: value, field: labels.get(headerKey(value)) });
        } catch {
          /* Report errors when processing data cells below. */
        }
      });
      const anchors = headers.filter((entry) => entry.field === 'sku');
      if (
        anchors.length &&
        (headers.some((entry) => entry.field && entry.field !== 'sku') ||
          (!active.length && headers.length > 1))
      ) {
        active = [];
        // Two SKU columns are ambiguous unless each starts its own complete value block.
        const separate =
          anchors.length > 1 &&
          anchors.every((anchor, index) =>
            headers.some(
              (entry) =>
                entry.column > anchor.column &&
                entry.column < (anchors[index + 1]?.column ?? Infinity) &&
                entry.field &&
                entry.field !== 'sku',
            ),
          );
        const segments = separate
          ? anchors.map((anchor, index) =>
              headers.filter(
                (entry) =>
                  entry.column >= anchor.column &&
                  entry.column < (anchors[index + 1]?.column ?? Infinity),
              ),
            )
          : [headers];
        for (const entries of segments) {
          const originals = entries.filter((entry) => entry.field === 'price');
          const profiles = originals.map((entry) => {
            let parent: unknown;
            try {
              parent = rowNumber > 1 ? cellValue(sheet.getCell(rowNumber - 1, entry.column)) : null;
            } catch {}
            return {
              start: entry.column,
              name:
                typeof parent === 'string' && parent.trim() && !labels.has(headerKey(parent))
                  ? parent
                  : null,
            };
          });
          const distinct =
            profiles.length > 1 &&
            profiles.every((profile) => profile.name) &&
            new Set(profiles.map((profile) => profile.name)).size === profiles.length;
          for (const profile of distinct ? profiles : [{ start: 0, name: null }]) {
            const columns = new Map<'sku' | PatchColumn, number>();
            const repeated = new Set<'sku' | PatchColumn>();
            const block: PatchWorkbookBlock = {
              key: `${sheet.id}:${rowNumber}:${entries[0]?.column ?? 1}:${profile.start}`,
              sheet: sheet.name,
              headerRow: rowNumber,
              priceProfile: profile.name,
              fields: [],
              issues: [],
            };
            for (const entry of entries) {
              if (!entry.field) {
                result.issues.push(
                  issue(
                    'PATCH_UNSUPPORTED_COLUMN',
                    entry.label,
                    `${sheet.name}!${row.getCell(entry.column).address}`,
                    'warn',
                  ),
                );
                continue;
              }
              if (distinct && entry.field === 'stock') {
                let parent: unknown;
                try {
                  parent = cellValue(sheet.getCell(rowNumber - 1, entry.column));
                } catch {}
                if (parent !== profile.name) {
                  if (!profiles.some((item) => item.name === parent))
                    result.issues.push({
                      ...issue(
                        'PATCH_COLUMN_SCOPE_REQUIRED',
                        'stock',
                        `${sheet.name}!${row.getCell(entry.column).address}`,
                      ),
                      message:
                        'Cột tồn chưa thuộc rõ bộ giá/shop nào. Không tự sao chép tồn sang các shop.',
                    });
                  continue;
                }
              }
              if (
                distinct &&
                entry.field !== 'sku' &&
                !(
                  entry.column >= profile.start &&
                  entry.column < (profiles.find((p) => p.start > profile.start)?.start ?? Infinity)
                )
              ) {
                if (entry.field === 'stock')
                  result.issues.push({
                    ...issue(
                      'PATCH_COLUMN_SCOPE_REQUIRED',
                      'stock',
                      `${sheet.name}!${row.getCell(entry.column).address}`,
                    ),
                    message:
                      'Cột tồn chưa thuộc rõ bộ giá/shop nào. Không tự sao chép tồn sang các shop.',
                  });
                continue;
              }
              if (columns.has(entry.field)) repeated.add(entry.field);
              columns.set(entry.field, entry.column);
            }
            for (const field of repeated) {
              columns.delete(field);
              block.issues.push(
                issue('PATCH_AMBIGUOUS_COLUMN', field, `${sheet.name}!${rowNumber}`),
              );
            }
            block.fields = [...columns.keys()].filter(
              (field): field is PatchColumn => field !== 'sku',
            );
            result.blocks.push(block);
            active.push({ block, columns });
          }
        }
        return;
      }
      for (const { block, columns } of active) {
        const skuColumn = columns.get('sku');
        if (!skuColumn) continue;
        const skuCell = row.getCell(skuColumn);
        let skuValue: unknown;
        try {
          skuValue = cellValue(skuCell);
        } catch (error) {
          result.issues.push(
            issue((error as Error).message, 'sku', `${sheet.name}!${skuCell.address}`),
          );
          continue;
        }
        if (blank(skuValue)) {
          if (
            [...columns].some(([field, column]) => {
              if (field === 'sku') return false;
              try {
                return !blank(cellValue(row.getCell(column)));
              } catch {
                return true;
              }
            })
          )
            result.issues.push({
              ...issue('PATCH_SKU_REQUIRED', 'sku', `${sheet.name}!${skuCell.address}`),
              message: 'Dòng có giá hoặc tồn nhưng thiếu SKU; chưa xác định được đích cập nhật.',
            });
          continue;
        }
        const parsed: PatchWorkbookRow = {
          key: `${block.key}:${rowNumber}`,
          blockKey: block.key,
          sheet: sheet.name,
          row: rowNumber,
          sku: String(skuValue),
          values: {},
          issues: [...block.issues],
          source: { ...source, locator: `${sheet.name}!${skuCell.address}` },
        };
        if (typeof skuValue !== 'string')
          parsed.issues.push(issue('PATCH_SKU_NOT_TEXT', 'sku', parsed.source.locator));
        for (const [field, column] of columns) {
          if (field === 'sku') continue;
          const cell = row.getCell(column),
            locator = `${sheet.name}!${cell.address}`;
          try {
            const value = cellValue(cell);
            if (blank(value)) continue;
            if (field === 'stock') {
              if (
                !(typeof value === 'number' || typeof value === 'string') ||
                !/^(0|[1-9][0-9]*)$/.test(String(value)) ||
                !Number.isSafeInteger(Number(value)) ||
                Number(value) > 2147483647
              )
                throw new Error('PATCH_INVALID_STOCK');
              parsed.values.stock = {
                value: Number(value),
                confirmed: true,
                sources: [{ ...source, locator }],
              };
            } else {
              let money: string;
              try {
                if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error();
                money = parseVnd(String(value));
                if (BigInt(money) <= 0n || BigInt(money) > BigInt(Number.MAX_SAFE_INTEGER))
                  throw new Error();
              } catch {
                throw new Error('PATCH_INVALID_PRICE');
              }
              parsed.values[field] = {
                value: money,
                confirmed: true,
                sources: [{ ...source, locator }],
              };
            }
          } catch (error) {
            parsed.issues.push(issue((error as Error).message, field, locator));
          }
        }
        result.rows.push(parsed);
      }
    });
    if (!result.blocks.some((block) => block.sheet === sheet.name))
      result.issues.push(issue('PATCH_HEADER_REQUIRED', 'sheet', sheet.name, 'warn'));
  }
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const key = JSON.stringify([row.blockKey, row.sku]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of result.rows)
    if (counts.get(JSON.stringify([row.blockKey, row.sku]))! > 1)
      row.issues.push(issue('PATCH_DUPLICATE_SKU', 'sku', row.source.locator));
  return result;
}
