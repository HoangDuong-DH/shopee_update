import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BlobStore, Repository } from '@shopee/persistence';
import { checkOfficeArchive } from '../../../packages/domain/src/source/archive.js';
import {
  contentMappingSchema,
  contentBindingSchema,
  type ContentMapping,
  type ContentBinding,
  type ContentRow,
  type ContentWorkbookInventory,
} from '../../../packages/domain/src/content-workbook.js';

const fail = (code: string): never => {
  throw Error(code);
};
function text(cell: ExcelJS.Cell): string {
  if (cell.isMerged && cell.master.address !== cell.address)
    return fail('CONTENT_MERGED_CELL_AMBIGUOUS');
  let value: any = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    if (!('result' in value) || value.result === undefined || value.result === null)
      return fail('CONTENT_FORMULA_WITHOUT_VALUE');
    value = value.result;
  }
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number')
    return String(value).replace(/\r\n?/g, '\n');
  if (value.richText) return value.richText.map((r: any) => r.text).join('');
  if (typeof value.text === 'string') return value.text;
  return fail('CONTENT_CELL_VALUE_INVALID');
}
export class ContentWorkbookService {
  constructor(
    readonly repo: Pick<Repository, 'getImport'>,
    readonly blobs: Pick<BlobStore, 'read'>,
  ) {}
  private async load(id: string) {
    z.string().uuid().parse(id);
    const record = await this.repo.getImport(id);
    if (!record || record.kind !== 'xlsx') return fail('CONTENT_WORKBOOK_NOT_FOUND');
    if (record.bytes > 16 * 1024 * 1024) return fail('CONTENT_WORKBOOK_TOO_LARGE');
    let bytes: Awaited<ReturnType<BlobStore['read']>>;
    try {bytes = await this.blobs.read(record.sha256);} catch {return fail('CONTENT_WORKBOOK_UNAVAILABLE');}
    if (
      bytes.length !== record.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== record.sha256
    )
      return fail('CONTENT_WORKBOOK_HASH_MISMATCH');
    checkOfficeArchive(bytes);
    const workbook = new ExcelJS.Workbook();
    try {await workbook.xlsx.load(bytes as any);} catch {return fail('CONTENT_WORKBOOK_INVALID');}
    if (
      workbook.worksheets.length > 30 ||
      workbook.worksheets.some((s) => s.rowCount > 10000 || s.columnCount > 128)
    )
      return fail('CONTENT_WORKBOOK_LIMIT');
    return { record, workbook };
  }
  async inspect(id: string, headerRow = 1): Promise<ContentWorkbookInventory> {
    z.number().int().min(1).max(100).parse(headerRow);
    const { record, workbook } = await this.load(id);
    return {
      importId: id,
      sha256: record.sha256,
      filename: record.filename,
      priceParserStatus: record.status,
      sheets: workbook.worksheets.map((sheet) => ({
        name: sheet.name,
        rows: sheet.rowCount,
        preview: Array.from(
          { length: Math.min(5, Math.max(0, sheet.rowCount - headerRow + 1)) },
          (_, i) => {
            const row = sheet.getRow(headerRow + i),
              cells: { column: string; text: string; issue?: string }[] = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
              try {
                cells.push({
                  column: cell.address.replace(/\d+$/, ''),
                  text: text(cell).slice(0, 500),
                });
              } catch (e) {
                cells.push({
                  column: cell.address.replace(/\d+$/, ''),
                  text: '',
                  issue: (e as Error).message,
                });
              }
            });
            return { row: row.number, cells };
          },
        ),
      })),
    };
  }
  private async parse(mapping: ContentMapping): Promise<ContentRow[]> {
    const { record, workbook } = await this.load(mapping.importId);
    if (record.sha256 !== mapping.sha256) return fail('CONTENT_WORKBOOK_HASH_MISMATCH');
    const sheet = workbook.getWorksheet(mapping.sheet);
    if (!sheet) return fail('CONTENT_SHEET_NOT_FOUND');
    for (const role of Object.keys(mapping.columns) as (keyof ContentMapping['columns'])[]) {
      const col = mapping.columns[role]!;
      if (text(sheet.getCell(col + mapping.headerRow)) !== mapping.headers[role])
        return fail('CONTENT_HEADER_CHANGED');
    }
    const rows: ContentRow[] = [];
    for (let n = mapping.headerRow + 1; n <= sheet.rowCount; n++) {
      const values: Record<string, string> = {},
        issues: string[] = [];
      for (const [role, col] of Object.entries(mapping.columns)) {
        try {
          values[role] = text(sheet.getCell(col + n));
        } catch (e) {
          values[role] = '';
          issues.push(`${col}${n}: ${(e as Error).message}`);
        }
      }
      if (!Object.values(values).some((v) => v.trim()) && !issues.length) continue;
      const stt = values.stt?.trim();
      if (!/^\d{1,8}$/.test(stt ?? '')) issues.push('STT phải là số nguyên trong cột đã chọn.');
      if (!values.title?.trim()) issues.push('Thiếu tiêu đề.');
      if (!values.body?.trim()) issues.push('Thiếu nội dung mô tả.');
      if (
        (values.title?.length ?? 0) > 10000 ||
        (values.headline?.length ?? 0) > 50000 ||
        (values.body?.length ?? 0) > 100000
      )
        issues.push('Nội dung vượt giới hạn.');
      rows.push({
        binding: { mapping, row: n, stt: stt ?? '' },
        title: values.title ?? '',
        headline: values.headline ?? '',
        body: values.body ?? '',
        issues,
        sources: Object.values(mapping.columns).map((col) => ({
          kind: 'product_file',
          fileSha256: record.sha256,
          filename: record.filename,
          locator: sheet.name + '!' + col + n,
          observedAt: record.createdAt,
        })),
      });
    }
    if (
      rows.reduce((n, r) => n + r.title.length + r.headline.length + r.body.length, 0) >
      8 * 1024 * 1024
    )
      return fail('CONTENT_RESPONSE_TOO_LARGE');
    return rows;
  }
  async rows(raw: unknown) {
    const mapping = contentMappingSchema.parse(raw);
    const rows = await this.parse(mapping);
    return { mapping, rows };
  }
  async resolveMany(raw: unknown[]) {
    if (raw.length > 500) return fail('CONTENT_SELECTION_LIMIT');
    const parsed = new Map<string, Promise<ContentRow[]>>();
    const result = [];
    for (const value of raw) {
      const binding = contentBindingSchema.parse(value),
        key = JSON.stringify(binding.mapping);
      if (!parsed.has(key)) parsed.set(key, this.parse(binding.mapping));
      const rows = await parsed.get(key)!,
        row = rows.find((r) => r.binding.row === binding.row);
      if (!row || row.binding.stt !== binding.stt || row.issues.length)
        return fail('CONTENT_ROW_INVALID');
      const { issues: _, ...selection } = row;
      result.push(selection);
    }
    return result;
  }
  async resolve(raw: unknown) {
    return (await this.resolveMany([raw]))[0]!;
  }
}
