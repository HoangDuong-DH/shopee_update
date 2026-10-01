import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, readKini, type CatalogRow, type ListingDraft, type WorkbookImport } from '@shopee/domain';
import { transaction, type BlobStore, type Repository } from '@shopee/persistence';
import { z } from 'zod';
import { verifyProductionPriceCells } from './production-batch-price-proof.js';
import type { ProductionDraftPriceProof } from './production-draft-source.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const issue = (code: string, message: string, slotKey?: string) => ({ code, message, ...(slotKey ? { slotKey } : {}) });
type MappingIssue = ReturnType<typeof issue>;
const parsedPriceCache = new Map<string, WorkbookImport>();
export type ListingPriceMappingRow = ProductionDraftPriceProof & {
  slotKey: string;
  optionLabels: string[];
  sourceName: string;
  sourceFilename: string;
  sourceImportedAt: string;
};
export type ListingPriceMappingReview = {
  productKey: string;
  revision: number;
  title: string;
  tierNames: string[];
  rows: ListingPriceMappingRow[];
  issues: MappingIssue[];
  fingerprint: string;
  confirmed: boolean;
};

export function listingPriceSlotKey(tierNames: readonly string[], optionLabels: readonly string[]) {
  return hash({ tierNames, optionLabels });
}

function exactCell(fact: { sources: { kind: string; fileSha256: string; locator: string }[] }, row: CatalogRow, fileSha256: string) {
  const prefix = `${row.sheet}!`;
  const cells = fact.sources.filter(source =>
    source.kind === 'product_file' && source.fileSha256 === fileSha256 &&
    source.locator.startsWith(prefix) && /^[A-Z]+[1-9]\d*$/.test(source.locator.slice(prefix.length)),
  );
  return cells.length === 1 ? cells[0]!.locator.slice(prefix.length) : null;
}

/** Read-only review. Every proposed link comes from the draft's explicit source selection. */
export async function reviewListingPriceMapping(repo: Repository, blobs: BlobStore, productKey: string): Promise<ListingPriceMappingReview> {
  const draft = await repo.getProduct(productKey);
  if (!draft) throw Error('SOURCE_MAPPING_PRODUCT_NOT_FOUND');
  const issues: MappingIssue[] = [];
  const rows: ListingPriceMappingRow[] = [];
  const selection = draft.sourceSelection;
  if (!selection || selection.variants.length !== draft.variants.length)
    issues.push(issue('MAPPING_SELECTION_MISSING', 'Listing chưa có lựa chọn dòng giá cho đầy đủ phân loại.'));
  if (new Set(draft.variants.map(v => v.sku.value)).size !== draft.variants.length)
    issues.push(issue('MAPPING_DUPLICATE_LISTING_SKU', 'Một SKU được dùng cho nhiều phân loại trong listing.'));
  const imports = new Map<string, Awaited<ReturnType<Repository['getImport']>>>();
  const freshBooks = new Map<string, WorkbookImport | null>();
  const bytesByImport = new Map<string, Uint8Array>();
  const scopes = new Set<string>();
  for (const [index, variant] of draft.variants.entries()) {
    const slotKey = listingPriceSlotKey(draft.tierNames, variant.optionLabels);
    const selected = selection?.variants[index];
    if (!selected || !same(selected.optionLabels, variant.optionLabels) || selected.rowKey !== variant.key) {
      issues.push(issue('MAPPING_SLOT_SOURCE_MISMATCH', 'Phân loại chưa gắn đúng lựa chọn nguồn đã lưu.', slotKey));
      continue;
    }
    if (!imports.has(selected.importId)) imports.set(selected.importId, await repo.getImport(selected.importId));
    const imported = imports.get(selected.importId);
    if (!imported || imported.kind !== 'xlsx' || imported.status !== 'ready' || !Array.isArray((imported.body as WorkbookImport)?.rows)) {
      issues.push(issue('MAPPING_PRICEBOOK_MISSING', 'Bảng giá gốc không còn sẵn sàng.', slotKey));
      continue;
    }
    if (!freshBooks.has(imported.id)) {
      try {
        const bytes = await blobs.read(imported.sha256);
        if (createHash('sha256').update(bytes).digest('hex') !== imported.sha256) throw Error('SOURCE_BYTES_CHANGED');
        bytesByImport.set(imported.id, bytes);
        let parsed = parsedPriceCache.get(imported.sha256);
        if (!parsed) {
          parsed = await readKini(bytes, imported.filename);
          if (parsedPriceCache.size >= 8) parsedPriceCache.delete(parsedPriceCache.keys().next().value!);
          parsedPriceCache.set(imported.sha256, parsed);
        }
        freshBooks.set(imported.id, parsed);
      } catch {
        freshBooks.set(imported.id, null);
      }
    }
    const fresh = freshBooks.get(imported.id);
    if (!fresh) {
      issues.push(issue('MAPPING_PRICEBOOK_BYTES_UNREADABLE', 'Không đọc lại được đúng phiên bản file giá gốc.', slotKey));
      continue;
    }
    const storedMatches = (imported.body as WorkbookImport).rows.filter(row => row.key === selected.rowKey);
    const freshMatches = fresh.rows.filter(row => row.key === selected.rowKey);
    if (storedMatches.length !== 1 || freshMatches.length !== 1) {
      issues.push(issue('MAPPING_PRICE_ROW_MISSING', 'Dòng giá đã chọn không tồn tại duy nhất trong file gốc.', slotKey));
      continue;
    }
    const row = storedMatches[0]!, actual = freshMatches[0]!;
    const profile = row.priceProfile ?? null;
    scopes.add(canonicalJson({ importId: imported.id, sheet: row.sheet, profile }));
    if (!row.sku.confirmed || !row.originalPrice?.confirmed ||
        !variant.sku.confirmed || !variant.originalPrice.confirmed ||
        row.sku.value !== variant.sku.value || row.originalPrice.value !== variant.originalPrice.value ||
        actual.sku.value !== row.sku.value || actual.originalPrice?.value !== row.originalPrice.value ||
        actual.sheet !== row.sheet || (actual.priceProfile ?? null) !== profile ||
        !same(variant.sku, row.sku) || !same(variant.originalPrice, row.originalPrice) ||
        !/^[1-9]\d*$/.test(row.originalPrice.value)) {
      issues.push(issue('MAPPING_PRICE_VALUE_MISMATCH', 'SKU hoặc giá không khớp chính xác giữa listing, dòng đã nhập và file gốc.', slotKey));
      continue;
    }
    const sameSkuRows = fresh.rows.filter(candidate => candidate.sheet === row.sheet &&
      (candidate.priceProfile ?? null) === profile && candidate.sku.value === row.sku.value);
    if (sameSkuRows.length !== 1) {
      issues.push(issue('MAPPING_DUPLICATE_PRICE_SKU', 'SKU xuất hiện ở nhiều dòng trong cùng bộ giá; cần sửa hoặc xác nhận lại nguồn trước khi dùng.', slotKey));
      continue;
    }
    const skuCell = exactCell(row.sku, row, imported.sha256);
    const priceCell = exactCell(row.originalPrice, row, imported.sha256);
    if (!skuCell || !priceCell || skuCell !== exactCell(actual.sku, actual, imported.sha256) ||
        priceCell !== exactCell(actual.originalPrice!, actual, imported.sha256)) {
      issues.push(issue('MAPPING_PRICE_CELL_MISSING', 'Chưa chứng minh được đúng ô SKU và ô giá trong file gốc.', slotKey));
      continue;
    }
    if (row.issues.some(i => i.severity === 'block') || actual.issues.some(i => i.severity === 'block')) {
      issues.push(issue('MAPPING_SOURCE_ROW_BLOCKED', 'Dòng giá có cảnh báo chặn từ nguồn.', slotKey));
      continue;
    }
    rows.push({ slotKey, optionLabels: [...variant.optionLabels], sourceName: row.name.value,
      sourceFilename: imported.filename, sourceImportedAt: imported.createdAt,
      sku: row.sku.value, importId: imported.id, rowKey: row.key, sheetName: row.sheet,
      priceProfile: profile, fileSha256: imported.sha256, skuCell, priceCell,
      originalPrice: row.originalPrice.value });
  }
  if (scopes.size > 1) issues.push(issue('MAPPING_PRICE_SCOPE_MIXED', 'Các phân loại dùng nhiều file, sheet hoặc bộ giá khác nhau.'));
  if (rows.length !== draft.variants.length) issues.push(issue('MAPPING_INCOMPLETE', 'Chưa đối chiếu đủ mọi phân loại của listing.'));
  if (new Set(rows.map(row => row.slotKey)).size !== rows.length)
    issues.push(issue('MAPPING_DUPLICATE_SLOT', 'Có tổ hợp phân loại trùng nhau.'));
  for (const [importId, bytes] of bytesByImport) {
    const proofs = rows.filter(row => row.importId === importId);
    if (!proofs.length) continue;
    try { await verifyProductionPriceCells(bytes, proofs); }
    catch { issues.push(issue('MAPPING_EXCEL_CELL_MISMATCH', 'Giá trị trực tiếp trong ô Excel không khớp SKU hoặc giá đã lưu.')); }
  }
  const basis = { productKey: draft.productKey, revision: draft.revision, tierNames: draft.tierNames,
    rows, issues };
  const fingerprint = hash(basis);
  const saved = await repo.pool.query(
    'SELECT id,review_fingerprint FROM listing_price_mapping_receipts WHERE product_key=$1 AND product_revision=$2',
    [draft.productKey, draft.revision],
  );
  return { ...basis, title: draft.title.value, fingerprint,
    confirmed: issues.length === 0 && saved.rows.length === 1 && saved.rows[0].review_fingerprint === fingerprint };
}

/** Explicit operator action. No SKU, price, or variant is written back to the draft. */
export async function confirmListingPriceMapping(repo: Repository, blobs: BlobStore, productKey: string, raw: unknown) {
  const input = z.object({ expectedRevision: z.number().int().positive(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
  const reviewed = await reviewListingPriceMapping(repo, blobs, productKey);
  if (reviewed.revision !== input.expectedRevision || reviewed.fingerprint !== input.expectedFingerprint)
    throw Error('SOURCE_MAPPING_REVIEW_CHANGED');
  if (reviewed.issues.length || !reviewed.rows.length) throw Error('SOURCE_MAPPING_UNRESOLVED');
  return transaction(repo.pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [productKey]);
    const current = await client.query('SELECT latest_revision FROM products WHERE product_key=$1 FOR UPDATE', [productKey]);
    if (current.rows[0]?.latest_revision !== reviewed.revision) throw Error('SOURCE_MAPPING_REVIEW_CHANGED');
    const prior = await client.query('SELECT id,review_fingerprint FROM listing_price_mapping_receipts WHERE product_key=$1 AND product_revision=$2', [productKey, reviewed.revision]);
    if (prior.rows.length) {
      if (prior.rows[0].review_fingerprint !== reviewed.fingerprint) throw Error('SOURCE_MAPPING_REVIEW_CHANGED');
      return { receiptId: prior.rows[0].id as string, productKey, revision: reviewed.revision, fingerprint: reviewed.fingerprint, rowCount: reviewed.rows.length };
    }
    for (const row of reviewed.rows) {
      const source = await client.query("SELECT sha256,status,kind FROM source_files WHERE id=$1 FOR SHARE", [row.importId]);
      if (source.rows[0]?.sha256 !== row.fileSha256 || source.rows[0]?.status !== 'ready' || source.rows[0]?.kind !== 'xlsx')
        throw Error('SOURCE_MAPPING_PRICEBOOK_CHANGED');
    }
    const receiptId = randomUUID();
    await client.query('INSERT INTO listing_price_mapping_receipts(id,product_key,product_revision,review_fingerprint) VALUES($1,$2,$3,$4)',
      [receiptId, productKey, reviewed.revision, reviewed.fingerprint]);
    for (const row of reviewed.rows) await client.query(
      `INSERT INTO listing_price_mapping_rows(receipt_id,slot_key,option_labels,price_import_id,price_row_key,price_file_sha256,price_sheet,price_profile,sku,sku_cell,original_price,price_cell)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [receiptId, row.slotKey, JSON.stringify(row.optionLabels), row.importId, row.rowKey, row.fileSha256,
        row.sheetName, row.priceProfile, row.sku, row.skuCell, row.originalPrice, row.priceCell],
    );
    return { receiptId, productKey, revision: reviewed.revision, fingerprint: reviewed.fingerprint, rowCount: reviewed.rows.length };
  });
}

/** Called at the final production write gate against the rebuilt source and exact price cells. */
export async function assertListingPriceMappingReceipt(repo: Repository, draft: ListingDraft, proofs: readonly ProductionDraftPriceProof[]) {
  const receipts = await repo.pool.query(
    'SELECT id FROM listing_price_mapping_receipts WHERE product_key=$1 AND product_revision=$2',
    [draft.productKey, draft.revision],
  );
  if (receipts.rows.length !== 1 || proofs.length !== draft.variants.length)
    throw Error('PRODUCTION_PRICE_MAPPING_CONFIRMATION_REQUIRED');
  const lines = await repo.pool.query('SELECT * FROM listing_price_mapping_rows WHERE receipt_id=$1', [receipts.rows[0].id]);
  if (lines.rows.length !== draft.variants.length) throw Error('PRODUCTION_PRICE_MAPPING_CONFIRMATION_REQUIRED');
  const bySlot = new Map(lines.rows.map((row: any) => [row.slot_key as string, row]));
  for (const [index, variant] of draft.variants.entries()) {
    const selected = draft.sourceSelection?.variants[index];
    const proof = proofs.find(p => p.rowKey === variant.key && p.sku === variant.sku.value);
    const slot = bySlot.get(listingPriceSlotKey(draft.tierNames, variant.optionLabels));
    if (!selected || !proof || !slot || selected.importId !== proof.importId ||
      !same(selected.optionLabels, variant.optionLabels) || selected.rowKey !== proof.rowKey ||
      !same(slot.option_labels, variant.optionLabels) || slot.price_import_id !== proof.importId ||
      slot.price_row_key !== proof.rowKey || slot.price_file_sha256 !== proof.fileSha256 ||
      slot.price_sheet !== proof.sheetName || (slot.price_profile ?? null) !== proof.priceProfile ||
      slot.sku !== proof.sku || slot.sku_cell !== proof.skuCell ||
      slot.original_price !== proof.originalPrice || slot.price_cell !== proof.priceCell ||
      variant.originalPrice.value !== proof.originalPrice)
      throw Error('PRODUCTION_PRICE_MAPPING_MISMATCH');
  }
}
