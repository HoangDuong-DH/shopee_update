import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import type {
  CatalogRow,
  CatalogSourceField,
  Fact,
  Issue,
  SourceRef,
  WorkbookImport,
} from '../contracts.js';
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
type Field = CatalogSourceField;
type HeaderBlock = {
  fields: Map<Field, number>;
  sourceHeaders: Partial<Record<Field, Fact<string>>>;
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
  if (key === 'GIA GOC' || key === 'GIA GOC DAC BIET') return 'originalPrice';
  if (key === 'GIA BAN' || key === 'GIA BAN DAC BIET') return 'promotionTarget';
  if (key === 'DON VI TINH THEO VAT') return 'unitOfMeasure';
  if (key === 'CAN NANG THUC G') return 'physicalWeightGrams';
  if (key === 'CAN NANG KHAI BAO G') return 'declaredWeightGrams';
  if (key === 'LINK ANH') return 'imageUrl';
  return undefined;
}
function specialPriceHeader(label: string): boolean {
  const key = headerKey(label);
  return key === 'GIA GOC DAC BIET' || key === 'GIA BAN DAC BIET';
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
      visibility: sheet.state,
      hiddenColumns: (sheet.columns ?? [])
        .filter((column) => column.hidden)
        .map((column) => column.letter)
        .filter((letter): letter is string => !!letter),
    };
    const visibilityIssue: Issue | undefined =
      sheet.state !== 'visible'
        ? {
            code: 'HIDDEN_SOURCE_SHEET',
            severity: 'block',
            field: 'workbook',
            message: `Sheet ${sheet.name} đang ẩn trong tệp nguồn; cần xác nhận trước khi dùng dữ liệu.`,
            sources: [{ ...source, locator: sheet.name }],
          }
        : undefined;
    if (visibilityIssue) result.issues.push(visibilityIssue);
    sheet.eachRow((row, rowNumber) => {
      const entries: { field: Field; column: number; label: string; special: boolean }[] = [];
      row.eachCell((cell, column) => {
        // Vertical merges carry a header into the next row; horizontal slaves are the same column label.
        if (cell.isMerged && Number(cell.master.col) !== column) return;
        const label = asText(valueOf(cell));
        const field = fieldOf(label);
        if (field) entries.push({ field, column, label, special: specialPriceHeader(label) });
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
          const profiles = originals.map((e) => {
            const parent =
              rowNumber > 1 ? asText(valueOf(sheet.getCell(rowNumber - 1, e.column))) : '';
            const parentName = parent && !fieldOf(parent) ? parent : undefined;
            return {
              start: e.column,
              name: e.special
                ? [parentName, 'GIÁ ĐẶC BIỆT'].filter(Boolean).join(' · ')
                : parentName,
            };
          });
          const distinctParents =
            profiles.length > 1 &&
            profiles.every((p) => p.name) &&
            new Set(profiles.map((p) => p.name)).size === profiles.length;
          for (const profile of distinctParents
            ? profiles
            : [
                {
                  start: 0,
                  name:
                    originals.length === 1 && originals[0].special ? profiles[0].name : undefined,
                },
              ]) {
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
              issues: Issue[] = [],
              sourceHeaders: Partial<Record<Field, Fact<string>>> = {};
            for (const e of selected) {
              if (fields.has(e.field)) duplicates.add(e.field);
              fields.set(e.field, e.column);
              sourceHeaders[e.field] = {
                value: e.label,
                confirmed: true,
                sources: [
                  { ...source, locator: `${sheet.name}!${row.getCell(e.column).master.address}` },
                ],
              };
            }
            for (const field of duplicates) {
              fields.delete(field);
              delete sourceHeaders[field];
              issues.push({
                code: 'AMBIGUOUS_HEADER',
                severity: 'block',
                field,
                message: `Cần chọn cột ${field} trong ${sheet.name}, dòng ${rowNumber}.`,
                sources: [{ ...source, locator: `${sheet.name}!${rowNumber}` }],
              });
            }
            const original = selected.filter((e) => e.field === 'originalPrice');
            const target = selected.filter((e) => e.field === 'promotionTarget');
            if (
              original.length === 1 &&
              target.length === 1 &&
              original[0].special !== target[0].special
            ) {
              fields.delete('promotionTarget');
              issues.push({
                code: 'PRICE_PROFILE_MISMATCH',
                severity: 'block',
                field: 'promotionTarget',
                message: 'GIÁ GỐC và GIÁ BÁN thuộc hai loại giá khác nhau; cần xác nhận cặp cột.',
                sources: sourceHeaders.promotionTarget!.sources,
              });
            }
            blocks.push({
              fields,
              sourceHeaders,
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
        const issues: Issue[] = [...block.issues, ...(visibilityIssue ? [visibilityIssue] : [])];
        const hiddenPriceColumns = [...fields]
          .filter(
            ([field, column]) =>
              (field === 'originalPrice' || field === 'promotionTarget') &&
              sheet.getColumn(column).hidden,
          )
          .map(([, column]) => sheet.getColumn(column).letter);
        if (hiddenPriceColumns.length)
          issues.push({
            code: 'HIDDEN_PRICE_COLUMNS',
            severity: 'warn',
            field: 'priceProfile',
            message: `Cột giá ${hiddenPriceColumns.join(', ')} đang ẩn trong tệp nguồn; dữ liệu vẫn được giữ theo đúng bộ giá.`,
            sources: hiddenPriceColumns.map((column) => ({
              ...source,
              locator: `${sheet.name}!${column}${rowNumber}`,
            })),
          });
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
          sheetVisibility: sheet.state,
          hiddenPriceColumns,
          sourceHeaders: block.sourceHeaders,
          sku,
          name,
          issues,
        };
        for (const field of [
          'brand',
          'category',
          'unitOfMeasure',
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
