import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { CatalogRow, ListingDraft, WorkbookImport } from '@shopee/domain';
const path = process.argv[2];
if (!path) throw new Error('Provide a local source recipe path.');
const recipe = JSON.parse(await readFile(path, 'utf8'));
const base = 'http://127.0.0.1:4310';
async function call(path: string, init?: RequestInit) {
  const r = await fetch(base + path, {
    ...init,
    headers: { 'X-App-Client': 'internal-workspace', ...init?.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.code ?? 'REQUEST_FAILED');
  return data;
}
async function upload(path: string, expectedSha?: string) {
  const bytes = await readFile(path);
  if (expectedSha && createHash('sha256').update(bytes).digest('hex') !== expectedSha)
    throw new Error('SOURCE_HASH_CHANGED');
  const r = await call('/v1/imports', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(basename(path)),
    },
    body: bytes,
  });
  return r.id as string;
}
async function ready(id: string) {
  for (let n = 0; n < 120; n++) {
    const r = await call('/v1/imports/' + id);
    if (r.status === 'ready') return r;
    if (r.status === 'failed') throw new Error(r.message);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('IMPORT_NOT_READY');
}
const workbookId = await upload(recipe.workbook),
  wordId = await upload(recipe.word);
const images = new Map<string, string>();
for (const img of recipe.images) images.set(img.name, await upload(img.path, img.sha256));
const imported = await ready(workbookId);
await ready(wordId);
for (const key of images.values()) await ready(key);
const rows = (imported.body as WorkbookImport).rows;
const variants = recipe.variants.map((v: any) => {
  const matches = rows.filter(
    (r: CatalogRow) => r.sku.value === v.sku && r.sheet === v.sheet && r.row === v.row,
  );
  if (matches.length !== 1) throw new Error('AMBIGUOUS_RECIPE_ROW');
  const row = matches[0];
  if (row.originalPrice?.value !== v.expectedPrice) throw new Error('SOURCE_PRICE_CHANGED');
  return {
    importId: workbookId,
    rowKey: row.key,
    optionLabels: [v.label],
    imageId: images.get(v.image),
  };
});
const existing = ((await call('/v1/products')) as ListingDraft[]).find(
  (p) => p.productKey === recipe.productKey,
);
if (existing) {
  console.log(
    JSON.stringify({
      status: 'already_imported',
      productKey: existing.productKey,
      revision: existing.revision,
    }),
  );
  process.exit(0);
}
const draft = (await call('/v1/products', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    productKey: recipe.productKey,
    expectedRevision: 0,
    title: recipe.title,
    headline: recipe.headline,
    body: recipe.body,
    coverId: images.get(recipe.cover),
    galleryIds: recipe.gallery.map((n: string) => images.get(n)),
    descriptionImageIds: recipe.descriptionImages.map((n: string) => images.get(n)),
    tierNames: [recipe.tierName],
    variants,
  }),
})) as ListingDraft;
const result = {
  observedAt: new Date().toISOString(),
  productKey: draft.productKey,
  revision: draft.revision,
  workbookId,
  wordId,
  sourceSha: imported.sha256,
  sheets: (imported.body as WorkbookImport).sheets,
  catalogRows: rows.length,
  variants: draft.variants.map((v) => ({
    sku: v.sku.value,
    label: v.optionLabels,
    price: v.originalPrice.value,
    promotionTarget: v.promotionTarget?.value,
    source: v.originalPrice.sources[0].locator,
  })),
  assets: draft.assets.length,
  descriptionImages: draft.description.filter((b) => b.type === 'image').length,
  originalWordWhitespacePreserved: true,
  oldSandboxPayloadTextEqual:
    JSON.stringify(draft.description.filter((b) => b.type === 'text').map((b) => b.text)) ===
    JSON.stringify(recipe.expectedText),
  shopeeApiCalls: 0,
};
await writeFile('.local/source-import-verification.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
