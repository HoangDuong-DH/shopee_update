import type { CatalogRow, Issue, SourceRef } from '../contracts.js';
import { canonicalJson } from '../plans.js';
import { isMissingPendingSku } from '../pending-listing-mapping.js';

const sourceMatches = (a: SourceRef, b: SourceRef) =>
  a.kind === b.kind && a.fileSha256 === b.fileSha256 && a.locator === b.locator;
const cellSource = (sources: SourceRef[], row: CatalogRow) =>
  sources.length === 1 &&
  sources[0]!.kind === 'product_file' &&
  !!sources[0]!.fileSha256 &&
  sources[0]!.locator.startsWith(row.sheet + '!') &&
  /^[A-Z]+[1-9]\d*$/.test(sources[0]!.locator.slice(row.sheet.length + 1));

/** Resolution is a view of an exact selected row, never a change to the workbook's issues.
 * A repeated SKU inside the selected sheet/profile remains unresolved even with a row key. */
export function resolvedDuplicatePriceIssueKeys(
  rows: readonly CatalogRow[],
  rowKey: string,
): Set<string> {
  const selected = rows.filter((row) => row.key === rowKey);
  if (selected.length !== 1) return new Set();
  const row = selected[0]!,
    price = row.originalPrice;
  if (
    isMissingPendingSku(row.sku.value) ||
    row.sku.confirmed !== true ||
    !price ||
    price.confirmed !== true ||
    !/^[1-9]\d*$/.test(price.value) ||
    BigInt(price.value) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !cellSource(row.sku.sources, row) ||
    !cellSource(price.sources, row) ||
    row.sku.sources[0]!.fileSha256 !== price.sources[0]!.fileSha256 ||
    row.issues.some((issue) => issue.severity === 'block') ||
    rows.filter(
      (other) =>
        other.sheet === row.sheet &&
        (other.priceProfile ?? null) === (row.priceProfile ?? null) &&
        other.sku.value === row.sku.value,
    ).length !== 1
  )
    return new Set();
  return new Set(
    row.issues
      .filter(
        (issue) =>
          issue.code === 'DUPLICATE_SKU' &&
          issue.severity === 'warn' &&
          issue.field === 'sku' &&
          issue.sources.some((source) => sourceMatches(source, row.sku.sources[0]!)),
      )
      .map((issue) => canonicalJson(issue)),
  );
}

export function projectResolvedPriceIssues(
  issues: readonly Issue[],
  resolved: ReadonlySet<string>,
): Issue[] {
  return issues.filter((issue) => !resolved.has(canonicalJson(issue)));
}
