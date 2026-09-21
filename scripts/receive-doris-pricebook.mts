import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { WorkbookImport } from '@shopee/domain';

// Receive only the supplied local workbook. This script cannot create jobs, products or Shopee requests.
const root = resolve('.local/input-catalog/doris-20260914');
const sourcePath = 'C:/Users/Admin/Desktop/FILE GIÁ DORIS.xlsx';
const expectedSha = '2642c4182a41a39cb01b0acde0f70d5b1c8d50c8daba640c942c281bf5930750';
const base = 'http://127.0.0.1:4310/v1/imports';
const bytes = await readFile(sourcePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== expectedSha) throw Error('SOURCE_CHANGED_SINCE_AUDIT');
await mkdir(resolve(root, 'sources'), { recursive: true });
await copyFile(sourcePath, resolve(root, 'sources', basename(sourcePath)));
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { 'X-App-Client': 'internal-workspace', ...init?.headers } });
  if (!response.ok) throw Error('LOCAL_IMPORT_HTTP_' + response.status);
  return response.json();
}
const existing = (await json(base)).filter((row: any) => row.sha256 === sha256 && row.kind === 'xlsx');
if (existing.length > 1) throw Error('DUPLICATE_SOURCE_IMPORT');
const record = existing[0] ?? await json(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(basename(sourcePath)) },
  body: bytes,
});
// Persist the ID before polling; an interrupted receipt check must never cause a second upload.
await writeFile(resolve(root, 'intake-request.json'), JSON.stringify({ id: record.id, sha256, existing: existing.length === 1, observedAt: new Date().toISOString() }, null, 2));
let ready = record;
for (let attempt = 0; attempt < 60 && !['ready', 'failed'].includes(ready.status); attempt++) {
  await new Promise(r => setTimeout(r, 500));
  ready = await json(base + '/' + encodeURIComponent(record.id));
}
if (ready.status !== 'ready') throw Error('SOURCE_NOT_READY:' + ready.status);
const workbook = ready.body as WorkbookImport;
if (workbook.source.fileSha256 !== sha256) throw Error('SOURCE_RECEIPT_MISMATCH');
const count = (field: (row: WorkbookImport['rows'][number]) => string) => {
  const result: Record<string, number> = {};
  for (const row of workbook.rows) { const key = field(row); result[key] = (result[key] ?? 0) + 1; }
  return result;
};
const receipt = { observedAt: new Date().toISOString(), importId: ready.id, sha256, rowCount: workbook.rows.length, sheets: workbook.sheets, profiles: count(r => `${r.sheet} / ${r.priceProfile ?? 'Chưa phân biệt bộ giá'}`), issues: workbook.issues, issueRows: Object.fromEntries([...new Set(workbook.rows.flatMap(r => r.issues.map(i => i.code)))].map(code => [code, workbook.rows.filter(r => r.issues.some(i => i.code === code)).length])), assignedToListing: false, shopeeRequests: 0 };
await writeFile(resolve(root, 'imported-pricebook.json'), JSON.stringify(ready, null, 2));
await writeFile(resolve(root, 'import-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
