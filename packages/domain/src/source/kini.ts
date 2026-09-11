import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import type { CatalogRow, Fact, Issue, SourceRef, WorkbookImport } from '../contracts.js';
import { checkOfficeArchive } from './archive.js';
import { headerKey, parseVnd } from './normalize.js';

function valueOf(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return 'result' in v ? v.result : undefined;
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return undefined;
  }
  return v;
}
function asText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}
type Field =
  | 'sku'
  | 'name'
  | 'brand'
  | 'category'
  | 'originalPrice'
  | 'promotionTarget'
  | 'physicalWeightGrams'
  | 'declaredWeightGrams'
  | 'imageUrl';
type HeaderBlock = {
  fields: Map<Field, number>;
  issues: Issue[];
  key: string;
  priceProfile?: string;
};
function fieldOf(label: string): Field | undefined {
  const key = headerKey(label);
  if (key === 'SKU' || key === 'MA SKU') return 'sku';
  if (key === 'TEN SAN PHAM') return 'name';
  if (key === 'BRAND' || key === 'THUONG HIEU') return 'brand';
  if (key === 'NGANH HANG') return 'category';
  if (key === 'GIA GOC') return 'originalPrice';
  if (key === 'GIA BAN') return 'promotionTarget';
  if (key === 'CAN NANG THUC G') return 'physicalWeightGrams';
  if (key === 'CAN NANG KHAI BAO G') return 'declaredWeightGrams';
  if (key === 'LINK ANH') return 'imageUrl';
  return undefined;
}
export async function readKini(
  bytes: Uint8Array,
  filename = 'workbook.xlsx',
): Promise<WorkbookImport> {
  checkOfficeArchive(bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const source: SourceRef = {
    kind: 'product_file',
    fileSha256: sha,
    filename,
    locator: filename,
    observedAt: new Date().toISOString(),
  };
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  const result: WorkbookImport = { source, rows: [], issues: [], sheets: [] };
  for (const sheet of book.worksheets) {
    let blocks: HeaderBlock[] = [];
    let headerRow = 0;
    const summary = {
      name: sheet.name,
      rowCount: sheet.rowCount,
      importedRows: 0,
      headerRows: [] as number[],
    };
    sheet.eachRow((row, rowNumber) => {
      const entries: { field: Field; column: number }[] = [];
      row.eachCell((cell, column) => {
        // Vertical merges carry a header into the next row; horizontal slaves are the same column label.
        if (cell.isMerged && Number(cell.master.col) !== column) return;
        const field = fieldOf(asText(valueOf(cell)));
        if (field) entries.push({ field, column });
      });
      if (entries.some((e) => e.field === 'sku') && entries.some((e) => e.field === 'name')) {
        headerRow = rowNumber;
        summary.headerRows.push(rowNumber);
        blocks = [];
        const firstIdentity = entries.find((e) => e.field === 'name' || e.field === 'sku')!.field;
        const anchorColumns = entries.filter((e) => e.field === firstIdentity).map((e) => e.column);
        const starts = anchorColumns.length > 1 ? [1, ...anchorColumns.slice(1)] : [1];
        for (let i = 0; i < starts.length; i++) {
          const part = entries.filter(
            (e) => e.column >= starts[i] && e.column < (starts[i + 1] ?? Infinity),
          );
          const originals = part.filter((e) => e.field === 'originalPrice');
          const profiles =
            originals.length > 1
              ? originals.map((e) => {
                  const parent =
                    rowNumber > 1 ? asText(valueOf(sheet.getCell(rowNumber - 1, e.column))) : '';
                  return { start: e.column, name: parent && !fieldOf(parent) ? parent : undefined };
                })
              : [];
          const distinctParents =
            profiles.length > 1 &&
            profiles.every((p) => p.name) &&
            new Set(profiles.map((p) => p.name)).size === profiles.length;
          for (const profile of distinctParents ? profiles : [{ start: 0, name: undefined }]) {
            const selected = distinctParents
              ? part.filter(
                  (e) =>
                    !['originalPrice', 'promotionTarget'].includes(e.field) ||
                    (e.column >= profile.start &&
                      e.column <
                        (profiles.find((p) => p.start > profile.start)?.start ?? Infinity)),
                )
              : part;
            const fields = new Map<Field, number>(),
              duplicates = new Set<Field>(),
              issues: Issue[] = [];
            for (const e of selected) {
              if (fields.has(e.field)) duplicates.add(e.field);
              fields.set(e.field, e.column);
            }
            for (const field of duplicates) {
              fields.delete(field);
              issues.push({
                code: 'AMBIGUOUS_HEADER',
                severity: 'block',
                field,
                message: `Cần chọn cột ${field} trong ${sheet.name}, dòng ${rowNumber}.`,
                sources: [{ ...source, locator: `${sheet.name}!${rowNumber}` }],
              });
            }
            blocks.push({
              fields,
              issues,
              key: `${starts[i]}:${profile.start}`,
              priceProfile: profile.name,
            });
          }
        }
        return;
      }
      if (!headerRow) return;
      for (const block of blocks) {
        const fields = block.fields;
        if (!fields.has('sku')) continue;
        const skuCell = row.getCell(fields.get('sku')!);
        const skuValue = valueOf(skuCell);
        if (
          skuValue === null ||
          skuValue === undefined ||
          skuValue === '' ||
          (skuCell.isMerged && Number(skuCell.master.col) !== Number(skuCell.col))
        )
          continue;
        const issues: Issue[] = [...block.issues];
        function fact(field: Field): Fact<string> | undefined {
          const column = fields.get(field);
          if (!column) return;
          const cell = row.getCell(column);
          const v = valueOf(cell);
          if (v === null || v === undefined || v === '') return;
          const text = asText(v);
          if (!text) return;
          return {
            value: text,
            confirmed: true,
            sources: [{ ...source, locator: `${sheet.name}!${cell.master.address}` }],
          };
        }
        const sku = fact('sku');
        if (!sku) continue;
        const name = fact('name') ?? {
          value: '',
          confirmed: false,
          sources: [{ ...source, locator: `${sheet.name}!${rowNumber}` }],
        };
        if (typeof skuValue !== 'string')
          issues.push({
            code: 'SKU_NOT_TEXT',
            severity: 'block',
            field: 'sku',
            message: 'SKU ở dạng số; cần xác nhận mã hiển thị để tránh mất số 0 đầu.',
            sources: sku.sources,
          });
        if (!name.value)
          issues.push({
            code: 'MISSING_NAME',
            severity: 'block',
            field: 'name',
            message: 'Thiếu tên sản phẩm ở nguồn.',
            sources: name.sources,
          });
        const item: CatalogRow = {
          key: `${sha}:${sheet.id}:${headerRow}:${block.key}:${rowNumber}`,
          sheet: sheet.name,
          row: rowNumber,
          headerRow,
          block: block.key,
          priceProfile: block.priceProfile,
          sku,
          name,
          issues,
        };
        for (const field of [
          'brand',
          'category',
          'physicalWeightGrams',
          'declaredWeightGrams',
          'imageUrl',
        ] as const) {
          const f = fact(field);
          if (f) item[field] = f;
        }
        for (const field of ['originalPrice', 'promotionTarget'] as const) {
          const f = fact(field);
          if (!f) {
            if (field === 'originalPrice')
              issues.push({
                code: 'MISSING_ORIGINAL_PRICE',
                severity: 'block',
                field,
                message: 'Thiếu GIÁ GỐC hoặc công thức chưa có kết quả lưu.',
                sources: sku.sources,
              });
            continue;
          }
          try {
            const raw = valueOf(row.getCell(fields.get(field)!));
            if (typeof raw === 'number' && !Number.isSafeInteger(raw))
              throw new Error('MONEY_FORMAT_REQUIRED');
            item[field] = { ...f, value: parseVnd(f.value) };
          } catch {
            issues.push({
              code: 'MONEY_FORMAT_REQUIRED',
              severity: 'block',
              field,
              message: 'Giá không phải số nguyên VND rõ ràng; cần xác nhận định dạng.',
              sources: f.sources,
            });
          }
        }
        result.rows.push(item);
        summary.importedRows++;
      }
    });
    if (!summary.headerRows.length)
      result.issues.push({
        code: 'SHEET_MAPPING_REQUIRED',
        severity: 'warn',
        field: 'workbook',
        message: `Sheet ${sheet.name} chưa có mapping SKU / TÊN SẢN PHẨM; chưa nhập sheet này.`,
        sources: [{ ...source, locator: sheet.name }],
      });
    result.sheets.push(summary);
  }
  const bySku = new Map<string, CatalogRow[]>();
  for (const row of result.rows)
    bySku.set(row.sku.value, [...(bySku.get(row.sku.value) ?? []), row]);
  for (const rows of bySku.values())
    if (rows.length > 1)
      for (const row of rows)
        row.issues.push({
          code: 'DUPLICATE_SKU',
          severity: 'warn',
          field: 'sku',
          message: 'SKU xuất hiện ở nhiều dòng/bộ giá. Chọn đúng nguồn trước khi ghép listing.',
          sources: rows.flatMap((r) => r.sku.sources),
        });
  if (!result.rows.length)
    result.issues.push({
      code: 'NO_CATALOG_BLOCK',
      severity: 'block',
      field: 'workbook',
      message: 'Không tìm thấy khối có cột SKU và TÊN SẢN PHẨM.',
      sources: [source],
    });
  return result;
}
