import type { CatalogRow } from '@shopee/domain';
import type { EditorSeed } from './Editor.js';

export type ListingInput = {
  productKey: string;
  importId: string;
  sheet: string;
  priceProfile: string | null | undefined;
  tierCount: 0 | 1 | 2;
  tierNames: string[];
  membership: string;
};
export type ListingInputIssue = { code: string; message: string; line?: number };
export type ResolvedListingRow = {
  line: number;
  sku: string;
  optionLabels: string[];
  row: CatalogRow;
};
export type ListingInputResult = {
  rows: ResolvedListingRow[];
  issues: ListingInputIssue[];
  seed?: EditorSeed;
};

export function resolveListingInput(
  input: ListingInput,
  catalogRows: CatalogRow[],
): ListingInputResult {
  const result: ListingInputResult = { rows: [], issues: [] };
  const add = (code: string, message: string, line?: number) =>
    result.issues.push({ code, message, ...(line === undefined ? {} : { line }) });
  if (!input.productKey.trim())
    add('PRODUCT_KEY_REQUIRED', 'Điền mã bộ listing đã chuẩn bị để phân biệt với các bộ khác.');
  if (!input.importId) add('SOURCE_REQUIRED', 'Chọn file bảng giá đã nhập.');
  if (!input.sheet) add('SHEET_REQUIRED', 'Chọn sheet chứa giá của listing này.');
  if (input.priceProfile === undefined)
    add('PROFILE_REQUIRED', 'Chọn rõ bộ giá áp dụng cho listing này.');
  if (![0, 1, 2].includes(input.tierCount) || input.tierNames.length !== input.tierCount)
    add('TIER_COUNT_INVALID', 'Số tên nhóm phân loại phải khớp với cấu trúc đã chọn.');
  if (input.tierNames.some((name) => !name.trim()))
    add('TIER_NAME_REQUIRED', 'Điền nguyên văn tên từng nhóm phân loại trong listing đã chuẩn bị.');
  if (input.tierNames.some((name) => name.length > 200))
    add(
      'TIER_NAME_TOO_LONG',
      'Tên nhóm vượt mức 200 ký tự mà ứng dụng hiện tiếp nhận; cần kiểm tra nguồn, không tự cắt tên.',
    );
  if (new Set(input.tierNames).size !== input.tierNames.length)
    add(
      'DUPLICATE_TIER_NAME',
      'Hai nhóm phân loại đang trùng tên. Kiểm tra lại đúng cấu trúc nguồn.',
    );

  const lines = input.membership
    .split(/\r\n|\n|\r/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text !== '');
  if (!lines.length)
    add(
      'MEMBERSHIP_REQUIRED',
      'Dán đầy đủ bảng SKU và nhãn phân loại của một listing đã chuẩn bị.',
    );
  if (lines.length > 2000) {
    add(
      'MEMBERSHIP_TOO_LARGE',
      'Bộ nhập vượt mức 2.000 dòng mà ứng dụng hiện tiếp nhận. Chưa thể tiếp tục với bộ này.',
    );
    return result;
  }
  if (input.tierCount === 0 && lines.length > 1)
    add(
      'UNTIERED_SINGLE_SKU',
      'Listing không có phân loại chỉ nhận một SKU. Kiểm tra lại cấu trúc nguồn; ứng dụng không tự gộp các SKU.',
    );
  const scopedRows = catalogRows.filter(
    (row) => row.sheet === input.sheet && (row.priceProfile ?? null) === input.priceProfile,
  );
  const skus = new Set<string>(),
    options = new Set<string>();
  for (const { text, line } of lines) {
    const [sku, ...optionLabels] = text.split('\t');
    if (optionLabels.length !== input.tierCount) {
      add(
        'LABEL_COUNT_INVALID',
        `Cần đúng ${input.tierCount + 1} cột: SKU${input.tierCount ? ' và ' + input.tierCount + ' nhãn phân loại' : ''}. Các cột cách nhau bằng phím Tab.`,
        line,
      );
      continue;
    }
    if (!sku.trim()) {
      add('SKU_REQUIRED', 'Cột SKU đang trống.', line);
      continue;
    }
    if (skus.has(sku))
      add('DUPLICATE_SKU', `SKU “${sku}” xuất hiện nhiều lần trong bộ nhập.`, line);
    skus.add(sku);
    if (optionLabels.some((label) => !label.trim()))
      add('LABEL_REQUIRED', `SKU “${sku}” chưa có đủ nhãn phân loại.`, line);
    if (optionLabels.some((label) => label.length > 200))
      add(
        'LABEL_TOO_LONG',
        `Nhãn của SKU “${sku}” vượt mức 200 ký tự mà ứng dụng hiện tiếp nhận; chưa cắt hoặc đổi tên.`,
        line,
      );
    const identity = JSON.stringify(optionLabels);
    if (options.has(identity) && input.tierCount > 0)
      add('DUPLICATE_OPTIONS', `SKU “${sku}” trùng tổ hợp phân loại với một SKU phía trên.`, line);
    options.add(identity);
    if (!input.importId || !input.sheet || input.priceProfile === undefined) continue;
    const matches = scopedRows.filter((row) => row.sku.value === sku);
    if (!matches.length) {
      add(
        'SKU_NOT_FOUND',
        `Không tìm thấy chính xác SKU “${sku}” trong sheet và bộ giá đã chọn. Kiểm tra cả khoảng trắng và chữ hoa/thường.`,
        line,
      );
      continue;
    }
    if (matches.length > 1) {
      add(
        'AMBIGUOUS_SKU',
        `SKU “${sku}” có ${matches.length} dòng nguồn phù hợp. Cần làm rõ dòng nguồn; chưa tự chọn dòng đầu.`,
        line,
      );
      continue;
    }
    const row = matches[0];
    result.rows.push({ line, sku, optionLabels: [...optionLabels], row });
    if (
      !row.originalPrice ||
      !/^[1-9][0-9]*$/.test(row.originalPrice.value) ||
      BigInt(row.originalPrice.value) <= 0n
    )
      add('PRICE_REQUIRED', `GIÁ GỐC của SKU “${sku}” chưa có giá trị hợp lệ.`, line);
    for (const issue of row.issues.filter((issue) => issue.severity === 'block'))
      add('SOURCE_BLOCKED', `SKU “${sku}”: ${issue.message}`, line);
  }
  if (!result.issues.length)
    result.seed = {
      productKey: input.productKey,
      expectedRevision: 0,
      title: '',
      headline: '',
      body: '',
      galleryIds: [],
      descriptionImageIds: [],
      tierNames: [...input.tierNames],
      variants: result.rows.map(({ row, optionLabels }) => ({
        importId: input.importId,
        rowKey: row.key,
        optionLabels: [...optionLabels],
      })),
    };
  return result;
}
