import { z } from 'zod';

export const INTAKE_STORAGE_KEY = 'shopee:prepared-intake:v1';
const MAX_ROWS = 2000;
const MAX_RECOVERY_BYTES = 2_000_000;
export type IntakeRow = { id: string; sku: string; labels: [string, string] };
export type IntakeDraft = {
  version: 1;
  productKey: string;
  sourceId: string;
  sheet: string;
  profileChoice: string;
  tierCount: '' | 0 | 1 | 2;
  tierNames: [string, string];
  rows: IntakeRow[];
  pasteText: string;
  step: 1 | 2 | 3;
};

const field = z.string().max(2000);
const recoverySchema = z
  .object({
    version: z.literal(1),
    productKey: z.string().min(1).max(200),
    sourceId: field,
    sheet: field,
    profileChoice: field,
    tierCount: z.union([z.literal(''), z.literal(0), z.literal(1), z.literal(2)]),
    tierNames: z.tuple([field, field]),
    rows: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            sku: field,
            labels: z.tuple([field, field]),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROWS),
    pasteText: z.string().max(1_000_000),
    step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();

export function newIntakeRow(id = crypto.randomUUID()): IntakeRow {
  return { id, sku: '', labels: ['', ''] };
}

export function newIntakeDraft(): IntakeDraft {
  return {
    version: 1,
    productKey: 'listing-' + crypto.randomUUID(),
    sourceId: '',
    sheet: '',
    profileChoice: '',
    tierCount: '',
    tierNames: ['', ''],
    rows: [newIntakeRow()],
    pasteText: '',
    step: 1,
  };
}

export function hasIntakeInput(draft: IntakeDraft): boolean {
  return !!(
    draft.sourceId ||
    draft.sheet ||
    draft.profileChoice ||
    draft.tierCount !== '' ||
    draft.pasteText ||
    draft.tierNames.some(Boolean) ||
    draft.rows.some((row) => row.sku || row.labels.some(Boolean))
  );
}

export function decodeIntakeRecovery(raw: string | null): IntakeDraft | undefined {
  if (!raw || raw.length > MAX_RECOVERY_BYTES) return undefined;
  try {
    const parsed = recoverySchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !hasIntakeInput(parsed.data)) return undefined;
    if (new Set(parsed.data.rows.map((row) => row.id)).size !== parsed.data.rows.length)
      return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

export function clearIntakeRecovery(productKey?: string): void {
  try {
    if (productKey) {
      const draft = decodeIntakeRecovery(sessionStorage.getItem(INTAKE_STORAGE_KEY));
      if (draft?.productKey !== productKey) return;
    }
    sessionStorage.removeItem(INTAKE_STORAGE_KEY);
  } catch {
    // A disabled browser store must not prevent saving a prepared listing.
  }
}

export function rowsToMembership(
  rows: IntakeRow[],
  tierCount: 0 | 1 | 2,
): {
  membership: string;
  issues: string[];
} {
  const issues: string[] = [];
  if (rows.length > MAX_ROWS) issues.push('Bảng vượt 2.000 dòng mà ứng dụng hiện tiếp nhận.');
  for (const [index, row] of rows.entries()) {
    if ([row.sku, ...row.labels].some((value) => /[\t\r\n]/.test(value)))
      issues.push(
        `Dòng ${index + 1}: mỗi ô chỉ nhận một giá trị. Dùng mục Dán từ Excel để nhập nhiều ô.`,
      );
    if (row.labels.slice(tierCount).some((value) => value !== ''))
      issues.push(
        `Dòng ${index + 1}: còn nhãn ngoài số nhóm vừa chọn. Kiểm tra lại cấu trúc hoặc xóa rõ ô thừa.`,
      );
    if (tierCount === 0 && row.sku === '')
      issues.push(`Dòng ${index + 1}: điền mã SKU trong bộ đã chuẩn bị.`);
  }
  return {
    membership: rows
      .map((row) => [row.sku, ...row.labels.slice(0, tierCount)].join('\t'))
      .join('\n'),
    issues,
  };
}

export function pastedMembershipToRows(
  text: string,
  tierCount: 0 | 1 | 2,
  makeId: () => string = () => crypto.randomUUID(),
): { rows?: IntakeRow[]; issues: string[] } {
  const lines = text.split(/\r\n|\n|\r/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length)
    return { issues: ['Dán các ô SKU và phân loại từ bảng đã chuẩn bị, bỏ hàng tiêu đề.'] };
  if (lines.length > MAX_ROWS)
    return { issues: ['Bảng vượt 2.000 dòng mà ứng dụng hiện tiếp nhận.'] };
  const issues: string[] = [];
  const rows = lines.map((line, index): IntakeRow => {
    const [sku, ...labels] = line.split('\t');
    if (labels.length !== tierCount)
      issues.push(
        `Dòng ${index + 1}: cần ${tierCount + 1} cột gồm SKU${tierCount ? ' và ' + tierCount + ' nhãn phân loại' : ''}.`,
      );
    return { id: makeId(), sku, labels: [labels[0] ?? '', labels[1] ?? ''] };
  });
  return issues.length ? { issues } : { rows, issues };
}
