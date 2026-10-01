import type {
  ContentRow,
  ContentSelection,
} from '../../../packages/domain/src/content-workbook.js';
import { sourceSequence } from './listing-zip.js';
/** Exact STT suggestions only, never select ambiguous rows or silently overwrite a saved choice. */
export function matchContentRows(groups: { key: string; name: string }[], rows: ContentRow[]) {
  const selections: Record<string, ContentSelection> = {},
    issues: string[] = [];
  for (const group of groups) {
    const stt = sourceSequence(group.name);
    const candidates = rows.filter(
      (r) => stt !== null && /^\d+$/.test(r.binding.stt) && String(Number(r.binding.stt)) === stt,
    );
    if (
      !stt ||
      groups.filter((g) => sourceSequence(g.name) === stt).length !== 1 ||
      candidates.length !== 1 ||
      candidates[0]!.issues.length
    ) {
      issues.push(
        `${group.name}: ${!stt ? 'thiếu STT đầu tên' : candidates.length > 1 ? 'nhiều dòng Excel cùng STT' : candidates.length === 0 ? 'không có dòng Excel cùng STT' : candidates[0]!.issues.length ? candidates[0]!.issues.join('; ') : 'nhiều bộ cùng STT'}; cần chọn dòng rõ ràng.`,
      );
      continue;
    }
    const { issues: _, ...selected } = candidates[0]!;
    selections[group.key] = selected;
  }
  return { selections, issues };
}
