import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { canonicalJson } from '@shopee/domain';
import { checkOfficeArchive } from '../../../packages/domain/src/source/archive.js';

type PriceProof = { sheetName: string; skuCell: string; priceCell: string; sku: string; originalPrice: string };
const checked = new Map<string, true>();
const fail = () => { throw Error('PRODUCTION_BATCH_PRICE_CELL_MISMATCH'); };
function cellScalar(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value && typeof value === 'object') {
    // Read only the result shipped in this exact source file. Never evaluate formulas.
    if ('formula' in value || 'sharedFormula' in value) return value.result;
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value;
}
/** Validate cells, not only agreement between two copies of a price inside the manifest.
 * Cache successful checks by the actual bytes and exact nominated cells/values. */
export async function verifyProductionPriceCells(bytes: Uint8Array, proofs: readonly PriceProof[]) {
  const key = createHash('sha256').update(bytes).update(canonicalJson(proofs)).digest('hex');
  if (checked.has(key)) return;
  checkOfficeArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  for (const proof of proofs) {
    const sheet = workbook.getWorksheet(proof.sheetName);
    if (!sheet) return fail();
    const sku = cellScalar(sheet.getCell(proof.skuCell));
    const price = cellScalar(sheet.getCell(proof.priceCell));
    if (typeof sku !== 'string' || sku !== proof.sku ||
      !((typeof price === 'number' && Number.isSafeInteger(price) && price > 0) ||
        (typeof price === 'string' && /^[1-9]\d*$/.test(price))) || String(price) !== proof.originalPrice)
      return fail();
  }
  if (checked.size >= 64) checked.delete(checked.keys().next().value!);
  checked.set(key, true);
}
