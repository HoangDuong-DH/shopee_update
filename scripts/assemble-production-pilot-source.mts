import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

// Local source assembly only. The source workbooks, original artwork and prior receipts are immutable.
const root = resolve('.local/production-pilot-1423724897');
const digest = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const read = async (path: string) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const originalPath = 'prepared-source-f4e2233ec6c67a5a.json';
const original = await read(originalPath);
const qc = await read('assets/row-2/asset-manifest.visual-qc.json');
const row65 = await read('assets/row-65/asset-inventory.json');
const metadata = await read('metadata-adjudication.json');
const changes: Record<string, [string, string][]> = {
  'row-2': [
    ['Thành phần: tinh dầu của hương bạn chọn và cồn thực phẩm.', 'Thành phần: Nguyên chất 100%.'],
    ['Sản phẩm chứa cồn thực phẩm, dễ bắt lửa.', 'Sản phẩm dễ bắt lửa.'],
    ['Cồn có thể làm phai màu một số loại vải nhuộm nên hãy thử góc khuất trước.', 'Sản phẩm có thể làm phai màu một số loại vải nhuộm nên hãy thử góc khuất trước.'],
  ],
  'row-65': [
    ['Thành phần: cồn thực phẩm và tinh dầu tạo hương Ngọc Lan Tây.', 'Thành phần: Nguyên chất 100%.'],
    ['Chai có cồn thực phẩm nên dễ bắt lửa.', 'Sản phẩm dễ bắt lửa.'],
  ],
};
const assets: Record<string, string> = {};
const media = async (entry: any) => {
  const path = resolve(entry.path), bytes = await readFile(path), actual = await sharp(bytes).metadata();
  if (digest(bytes) !== entry.sha256 || actual.width !== entry.width || actual.height !== entry.height || actual.format !== 'png')
    throw Error('ORIGINAL_IMAGE_CHANGED');
  const h = entry.sha256;
  const importId = `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  assets[importId] = path;
  return { importId, sha256: h, width: entry.width, height: entry.height, mime: 'image/png' };
};
const reviewed65 = row65.map((entry: any) => ({ ...entry,
  roles: entry.name.endsWith('anh-bia.png') ? [{ role: 'cover' }]
    : /g([1-9])\.png$/.test(entry.name) ? ['gallery','description'].map(role => ({ role, order: Number(entry.name.match(/g([1-9])\.png$/)[1]) - 1 }))
      : entry.name.endsWith('-pl.png') ? [{ role: 'variation', shared: true, skus: ['VTTDNLT300','VTTDNLT100','VTTDNLT500'] }] : [],
  visualReviewed: true, originalUnmodified: true,
}));
if (reviewed65.length !== 11 || reviewed65.some((e: any) => !e.roles.length)) throw Error('ROW65_ASSET_ROLE_MISSING');
const listings = [];
for (const key of ['row-2', 'row-65']) {
  const source = original.listings.find((s: any) => s.sourceKey === key);
  const entries = key === 'row-2' ? qc.entries : reviewed65;
  const one = (role: string, sku?: string) => {
    const found = entries.filter((e: any) => e.roles.some((r: any) => r.role === role && (!sku || r.sku === sku || r.skus?.includes(sku))));
    if (found.length !== 1) throw Error('IMAGE_ROLE_AMBIGUOUS');
    return found[0];
  };
  const galleryEntries = entries.filter((e: any) => e.roles.some((r: any) => r.role === 'gallery'))
    .sort((a: any,b: any) => a.roles.find((r: any) => r.role === 'gallery').order - b.roles.find((r: any) => r.role === 'gallery').order);
  if (galleryEntries.length !== 9 || galleryEntries.some((e: any,i: number) => e.roles.find((r: any) => r.role === 'gallery').order !== i))
    throw Error('GALLERY_SEQUENCE_INVALID');
  const cover = await media(one('cover')), gallery = await Promise.all(galleryEntries.map(media));
  let text = source.textDescription;
  for (const [before,after] of changes[key]!) {
    if (text.split(before).length !== 2) throw Error('SOURCE_PATCH_NOT_EXACT');
    text = text.replace(before, after);
  }
  if (/cồn/i.test(text)) throw Error('UNRESOLVED_ALCOHOL_REFERENCE');
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 1) throw Error('DESCRIPTION_HEADING_MISSING');
  const description = [
    { type: 'text', text: text.slice(0, firstBreak) + '\n\n' },
    ...gallery.map(image => ({ type: 'image', image })),
    { type: 'text', text: '\n\n' + text.slice(firstBreak + 1) },
  ];
  const models = await Promise.all(source.models.map(async (m: any) => ({
    sku: m.sku, optionLabels: m.optionLabels, tierIndex: m.tierIndex, originalPrice: m.originalPrice,
    stock: m.stock, weightGrams: m.declaredWeightGrams, dimensionCm: source.dimensionCm,
    image: await media(one('variation', m.sku)),
  })));
  const proposed = metadata.sources.find((s: any) => s.sourceKey === key).sourceBackedOptionalAttributeProposals;
  const attributeList = proposed.map((a: any) => ({ attribute_id: a.attribute_id, attribute_value_list: a.attribute_value_list }));
  listings.push({ sourceKey: key, sourceIdentity: source.sourceIdentity, sourceRevision: 2,
    source: source, textRevision: { parentRevision: 1, userDecision: 'ghi “Nguyên chất 100%”',
      changes: changes[key]!.map(([before,after]) => ({ before,after })), text,
      note: 'Only composition conflict corrected. Flame, eye, child and fabric precautions retained. This records seller confirmation, not an independent laboratory certification.' },
    document: { sourceKey: source.sourceIdentity, title: source.title, description, cover, gallery,
      tierNames: source.tierNames, models, categoryId: '101128', brandId: '1252097',
      attributes: Object.fromEntries(attributeList.map((a: any) => [String(a.attribute_id),a.attribute_value_list.map((v: any) => String(v.value_id))])),
      logistics: [{ channelId: '5001', enabled: true }], weightGrams: Math.max(...models.map(m => m.weightGrams)),
      dimensionCm: source.dimensionCm, publication: 'unlisted' },
    proposedAttributeList: attributeList, attributeProvenance: proposed,
    galleryAndDescriptionImageOrder: 'g1–g9 in original order, blank lines after original opening heading and before body',
    variationImagePolicy: key === 'row-65' ? 'One supplied square pl image shows all three sizes and is reused unchanged for each size. No synthesized size-specific images.' : 'Per-SKU visual mapping from reviewed manifest; never filename ordinal order.',
  });
}
const result = { schemaVersion: 1, assembledAt: new Date().toISOString(), scope: original.scope,
  originalReceipt: originalPath, originalReceiptSha256: digest(await readFile(resolve(root, originalPath))),
  sourceHashes: original.sourceHashes, decisions: { ...original.decisions, scope: 'Only row-2 and row-65 on shop1423724897',
    excluded: [{ sourceKey: 'row-11', reason: 'User: Để bộ Tràm Huế ra ngoài lô thử' }] },
  listings, assets, listingCount: 2, modelCount: 15, mutations: 0,
  readyToSend: false, remaining: ['Fresh metadata and duplicate scan','Capability probe remains unverified','Reviewed journal and transport','Readback before publication'] };
const output = resolve(root, 'source-authorized-v2.json');
await writeFile(output, JSON.stringify(result,null,2), { flag: 'wx' });
await writeFile(resolve(root,'assets/row-65/asset-manifest.visual-qc.json'),JSON.stringify({
  reviewedAt: new Date().toISOString(), reviewer: 'Codex root visual inspection of original images/contact sheet',
  listingKey: 'row-65', scope: original.scope, entries: reviewed65,
  artworkChangesMade: false, imageGeneration: false, puritySource: 'Seller confirmed Nguyên chất 100%; original Excel preserved in source revision1',
  variationPolicy: result.listings[1]!.variationImagePolicy, shopeeWrites: 0,
},null,2),{flag:'wx'});
console.log(JSON.stringify({ output, listings: result.listingCount, models: result.modelCount, sourceRevision: 2,
  imageFiles: Object.keys(assets).length, excluded: ['row-11'], mutations: 0 }));
