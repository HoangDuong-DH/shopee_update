import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';

// A source receipt for this user-authorized pilot, not a production writer or default policy.
const directory = resolve('.local/production-pilot-1423724897');
const workbookPath = 'C:/Users/Admin/Downloads/Copy of SHOP VINA TƯƠI(AutoRecovered).xlsx';
const pricePath = 'C:/Users/Admin/Desktop/FILE GIÁ DORIS.xlsx';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const catalogBytes = await readFile(resolve('.local/input-catalog/vina-tuoi-20260914/catalog-snapshot.json'));
const catalog = JSON.parse(catalogBytes.toString('utf8'));
const catalogWorkbook = await readFile(workbookPath), priceWorkbook = await readFile(pricePath);
const content = new ExcelJS.Workbook(), prices = new ExcelJS.Workbook();
await content.xlsx.load(catalogWorkbook as any); await prices.xlsx.load(priceWorkbook as any);
const cellValue = (cell: ExcelJS.Cell): unknown => {
  const value = cell.value;
  if (value && typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) return 'result' in value ? value.result : undefined;
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value;
};
const choices = [
  { sourceKey: 'row-2', sourceRow: 5, canvaId: 'DAHUmT4_SaQ', dimensionCm: { length: 25, width: 20, height: 35 },
    mappings: [['Sả Java 5L','VTSJC5L',1021],['Hoa Lài 5L','VTHLC5L',1023],['Bạc Hà Lục 5L','VTBHLC5L',1026],
      ['Bạch Đàn Chanh 5L','VTBDCC5L',1027],['Bạc Hà 5L','VTBHC5L',1019],['Hương Thảo 5L','VTHTC5L',1028],
      ['Cam Sả 5L','VTCSC5L',1022],['Vỏ Quế 5L','VTVQC5L',1025],['Rừng Thông 5L','VTRTC5L',1029],
      ['Sả Chanh 5L','VTSCC5L',1018],['Oải Hương 5L','VTOHC5L',1024],['Trà Trắng 5L','VTTTC5L',1020]] },
  { sourceKey: 'row-11', sourceRow: 14, canvaId: 'DAHUmfQj44c', dimensionCm: { length: 12, width: 10, height: 15 },
    mappings: [['Tràm Huế 50ml','VTTHL50',997],['Tràm Huế 30ml','VTTHL30',996]] },
  { sourceKey: 'row-65', sourceRow: 68, canvaId: 'DAHUwEfYi4I', dimensionCm: { length: 12, width: 12, height: 28 },
    mappings: [['300ml','VTTDNLT300',833],['100ml','VTTDNLT100',832],['500ml','VTTDNLT500',834]] },
];
const listings = choices.map(choice => {
  const source = catalog.listings.find((row: any) => row.id === choice.sourceKey);
  if (!source || source.titleSource.sourceId !== `workbook:${hash(catalogWorkbook)}`) throw Error('CATALOG_SOURCE_CHANGED');
  const sourceSheet = content.getWorksheet('01 VINA TUOI')!, priceSheet = prices.getWorksheet('FILE GIÁ DORIS')!;
  const title = cellValue(sourceSheet.getCell(`D${choice.sourceRow}`));
  const description = cellValue(sourceSheet.getCell(`E${choice.sourceRow}`));
  const rawVariation = cellValue(sourceSheet.getCell(`F${choice.sourceRow}`));
  if (title !== source.title || description !== source.contents[0].value || rawVariation !== source.variations[0].value)
    throw Error('SOURCE_CONTENT_CHANGED');
  if (rawVariation !== 'Phân loại 1: ' + choice.mappings.map(([label]) => label).join(' · ')) throw Error('VARIATION_ORDER_CHANGED');
  const models = choice.mappings.map(([label, sku, row], index) => {
    if (cellValue(priceSheet.getCell(`E${row}`)) !== sku || cellValue(priceSheet.getCell(`C${row}`)) !== 'VINA TƯƠI')
      throw Error('SKU_SOURCE_CHANGED');
    const originalPrice = cellValue(priceSheet.getCell(`O${row}`));
    const salePrice = cellValue(priceSheet.getCell(`P${row}`));
    const weightGrams = cellValue(priceSheet.getCell(`J${row}`));
    if (typeof originalPrice !== 'number' || !Number.isSafeInteger(originalPrice) || originalPrice <= 0 ||
      typeof weightGrams !== 'number' || !Number.isFinite(weightGrams) || weightGrams <= 0) throw Error('PRICE_WEIGHT_INVALID');
    return { sku, optionLabels: [label], tierIndex: [index], originalPrice: String(originalPrice), stock: 100,
      declaredWeightGrams: weightGrams, promotionTargetPriceNotApplied: salePrice,
      source: { file: pricePath, sheet: 'FILE GIÁ DORIS', row, skuCell: `E${row}`, priceCell: `O${row}`, weightCell: `J${row}` } };
  });
  return { sourceKey: choice.sourceKey, sourceRevision: 1, sourceIdentity: `${catalog.catalog.id}:${choice.sourceKey}`,
    title, textDescription: description, rawVariation, tierNames: ['Phân loại 1'], models,
    canvaId: choice.canvaId, dimensionCm: choice.dimensionCm,
    dimensionsProvenance: { type: 'estimate', authorization: 'User: bạn suy luận ra giúp tôi', measured: false,
      basis: 'Conservative outer package estimate for the largest container in this listing; not a Shopee observation.' },
    sourceRefs: [source.titleSource, source.contents[0].evidence, source.variations[0].evidence],
    originalCatalogEntry: source, status: 'source_prepared_metadata_and_media_qc_pending' };
});
const receipt = { preparedAt: new Date().toISOString(), scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
  catalogId: catalog.catalog.id, pricebookId: '6bea45ed-8211-41c2-9f6f-4d8416f9af12',
  sourceHashes: { workbook: hash(catalogWorkbook), priceWorkbook: hash(priceWorkbook), catalogSnapshot: hash(catalogBytes) },
  decisions: { stockPerSku: 100, stockAuthorization: 'User: 100 đi', priceProfile: 'SHOP MALL',
    priceAuthorization: 'User: Dùng GIÁ GỐC bộ SHOP MALL trong DORIS', originalPriceColumn: 'O', createPromotions: false,
    scope: 'Only these three test listings on shop1423724897; no default for other shops or later batches.' },
  listings, listingCount: listings.length, modelCount: listings.reduce((n, item) => n + item.models.length, 0), mutations: 0 };
await mkdir(directory, { recursive: true });
const bytes = JSON.stringify(receipt, null, 2);
const output = resolve(directory, `prepared-source-${hash(bytes).slice(0, 16)}.json`);
await writeFile(output, bytes, { flag: 'wx' });
console.log(JSON.stringify({ output, listingCount: receipt.listingCount, modelCount: receipt.modelCount, mutations: 0,
  sourceHashes: receipt.sourceHashes, dimensionsAreEstimates: true }));
