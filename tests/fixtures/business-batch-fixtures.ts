import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { sha256, wordBytes } from '../e2e/bulk-folder-fixtures.js';

/** Explicitly synthetic, local-only business acceptance inputs. None of these IDs grant live rights. */
export const businessCoordinationSheet = 'Điều phối listing';
export const businessCoordinationHeaders = [
  'THƯ MỤC',
  'SHOP ID',
  'BẢNG GIÁ',
  'MÃ NGÀNH',
  'MÃ THƯƠNG HIỆU',
  'MÃ THUỘC TÍNH',
  'MÃ GIÁ TRỊ',
  'KÊNH VẬN CHUYỂN',
  'CÂN NẶNG G',
  'DÀI CM',
  'RỘNG CM',
  'CAO CM',
  'WORD',
  'ẢNH BÌA',
  'ẢNH GALLERY',
  'ẢNH MÔ TẢ',
  'TÊN TẦNG 1',
  'TÊN TẦNG 2',
] as const;
export const businessPriceHeaders = [
  'SKU',
  'TÊN SẢN PHẨM',
  'NGÀNH HÀNG',
  'BRAND',
  'GIÁ GỐC',
  'GIÁ BÁN',
  'CÂN NẶNG KHAI BÁO G',
  'THƯ MỤC',
  'TỒN BÁN',
  'PHÂN LOẠI 1',
  'PHÂN LOẠI 2',
  'ẢNH PHÂN LOẠI',
] as const;

export type BusinessCategoryFixture = {
  categoryId: string;
  name: string;
  brandId: string;
  brandName: string;
  requiredAttribute: {
    attributeId: string;
    name: string;
    values: { valueId: string; name: string }[];
  };
};
export type BusinessShopFixture = {
  shopId: string;
  name: string;
  ownerId: string;
  priceSheet: string;
  priceProfile: null;
  logisticsChannelId: string;
  categories: BusinessCategoryFixture[];
};
export type BusinessSourceFile = {
  path: string;
  /** Relative to fixture.root, including the parent selected by the browser for folder files. */
  relativePath: string;
  filename: string;
  folderName?: string;
  kind: 'docx' | 'image' | 'xlsx';
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
};
export type BusinessVariantFixture = {
  sku: string;
  optionLabels: string[];
  tierIndex: number[];
  originalPrice: string;
  promotionTarget: string;
  stock: number;
  /** Filename inside this listing folder; absent for listings without tiers. */
  imagePath?: string;
  priceRow: number;
};
export type BusinessListingFixture = {
  index: number;
  productKey: string;
  folderName: string;
  folderPath: string;
  groupKey: string;
  shopId: string;
  shopName: string;
  priceSheet: string;
  priceProfile: null;
  coordinationRow: number;
  categoryId: string;
  categoryName: string;
  brandId: string;
  attributes: { attributeId: string; valueId: string; name: string; valueName: string }[];
  logistics: {
    channelId: string;
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
  };
  title: string;
  headline: '';
  /** Full untouched text of the Word description section. */
  body: string;
  expectedDescription: {
    headline: string;
    body: string;
    blocks: ({ type: 'text'; text: string } | { type: 'image'; path: string })[];
  };
  paragraphs: string[];
  wordPath: string;
  tierNames: string[];
  variants: BusinessVariantFixture[];
  media: { coverPath: string; galleryPaths: string[]; descriptionPaths: string[] };
  files: BusinessSourceFile[];
};
export type BusinessBatchFixture = {
  root: string;
  directory: string;
  workbookPath: string;
  workbook: BusinessSourceFile;
  manifestPath: string;
  manifestSha256: string;
  shops: BusinessShopFixture[];
  categories: BusinessCategoryFixture[];
  listings: BusinessListingFixture[];
  files: BusinessSourceFile[];
  expected: {
    listingCount: number;
    variantCount: number;
    wordCount: number;
    imageCount: number;
    shopCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    tierCounts: Record<string, number>;
    sharedSkuAcrossShops: string[];
  };
};

export const businessCategoryFixtures: BusinessCategoryFixture[] = [
  'QA Văn phòng phẩm',
  'QA Gia dụng',
  'QA Mẹ và bé',
  'QA Làm đẹp',
].map((name, index) => ({
  categoryId: String(99001001 + index),
  name,
  brandId: String(99002001 + index),
  brandName: `QA Nhãn thử ${index + 1}`,
  requiredAttribute: {
    attributeId: String(99003001 + index),
    name: ['Loại giấy QA', 'Vật liệu QA', 'Kiểu đóng gói QA', 'Loại dụng cụ QA'][index],
    values: ['QA Loại A', 'QA Loại B', 'QA Loại C'].map((value, valueIndex) => ({
      valueId: String(99004001 + index * 10 + valueIndex),
      name: value,
    })),
  },
}));

export const businessShopFixtures: BusinessShopFixture[] = ['Bắc', 'Trung', 'Nam'].map(
  (region, index) => ({
    shopId: String(910000001 + index),
    name: `QA Shop ${region}`,
    ownerId: String(980000001 + index),
    priceSheet: `QA ${region}`,
    priceProfile: null,
    logisticsChannelId: String(99005001 + index),
    categories: structuredClone(businessCategoryFixtures),
  }),
);

async function qaImage(index: number, role: string, square: boolean): Promise<Buffer> {
  const width = 900,
    height = square ? 900 : 1200;
  const roleIndex = [...role].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}"><rect x="30" y="30" width="840" height="200" fill="white"/><text x="65" y="100" font-size="42" font-family="sans-serif" fill="#222">QA ONLY - SYNTHETIC</text><text x="65" y="175" font-size="40" font-family="sans-serif" fill="#222">LISTING ${index + 1} / ${role}</text></svg>`,
  );
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: {
        r: 60 + ((index * 11 + roleIndex) % 160),
        g: 60 + ((index * 7 + roleIndex * 3) % 160),
        b: 60 + ((index * 17 + roleIndex * 7) % 160),
      },
    },
  })
    .composite([{ input: overlay }])
    .png()
    .toBuffer();
}

/** Creates real DOCX/PNG/XLSX bytes. Expected values are authored here before any app parser runs. */
export async function createBusinessBatchFixture(
  options: { root?: string; count?: number } = {},
): Promise<BusinessBatchFixture> {
  const count = options.count ?? 80;
  if (!Number.isInteger(count) || count < 1 || count > 80)
    throw new Error('QA_FIXTURE_COUNT_INVALID');
  const parent = resolve(options.root ?? '.local/acceptance-20260914/business-batch');
  // Even a caller-supplied parent may not write outside this workspace's local acceptance data.
  const allowed = resolve('.local');
  if (!parent.startsWith(allowed + sep)) throw new Error('QA_FIXTURE_ROOT_OUTSIDE_LOCAL');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  const directory = join(root, '80-business-listings');
  const shops = structuredClone(businessShopFixtures);
  const categories = structuredClone(businessCategoryFixtures);
  const files: BusinessSourceFile[] = [];
  async function save(
    relativePath: string,
    bytes: Buffer,
    extra: Partial<BusinessSourceFile> = {},
  ) {
    const path = resolve(root, relativePath);
    if (!path.startsWith(root + sep)) throw new Error('QA_FIXTURE_PATH_ESCAPED');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const file: BusinessSourceFile = {
      path,
      relativePath,
      filename: basename(path),
      kind: path.endsWith('.docx') ? 'docx' : path.endsWith('.xlsx') ? 'xlsx' : 'image',
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...extra,
    };
    files.push(file);
    return file;
  }
  const book = new ExcelJS.Workbook();
  book.creator = 'Local synthetic QA fixture';
  book.created = new Date('2026-09-14T00:00:00Z');
  book.modified = book.created;
  const coordination = book.addWorksheet(businessCoordinationSheet);
  coordination.addRow([...businessCoordinationHeaders]);
  const priceSheets = new Map(
    shops.map((shop) => {
      const sheet = book.addWorksheet(shop.priceSheet);
      sheet.addRow([...businessPriceHeaders]);
      return [shop.shopId, sheet];
    }),
  );
  const listings: BusinessListingFixture[] = [];
  for (let index = 0; index < count; index++) {
    const number = String(index + 1).padStart(3, '0');
    const family = Math.floor(index / 3);
    const shopIndex = index % shops.length;
    const shop = shops[shopIndex];
    const category = categories[family % categories.length];
    const tiers = Math.floor(index / 12) % 3;
    const folderName = `${number} - ${category.name} - ${shop.name}`;
    const groupKey = basename(directory) + '/' + folderName;
    const title = ` QA ${number} · ${category.name} · bộ mẫu  nguyên văn `;
    const body = `Mở đầu ${number} & chi tiết <gốc>\n  Nội dung được chuẩn bị: giữ  hai khoảng trắng.  \n\nDòng cuối ${number} — chỉ dùng kiểm thử, không bán.`;
    const paragraphs = ['TIÊU ĐỀ', title, 'BÀI MÔ TẢ ĐĂNG BÁN', ...body.split('\n')];
    const wordPath = 'Nội dung gốc.docx';
    const listingFiles = [
      await save(groupKey + '/' + wordPath, wordBytes(paragraphs), { folderName }),
    ];
    const media = {
      coverPath: 'Ảnh bìa.png',
      galleryPaths: ['Chi tiết 03.png', 'Chi tiết 01.png', 'Chi tiết 02.png'],
      descriptionPaths: ['Chi tiết 02.png', 'Chi tiết 03.png'],
    };
    const tierNames = tiers === 0 ? [] : tiers === 1 ? [' Màu sắc '] : [' Màu sắc ', 'Quy cách'];
    const options =
      tiers === 0
        ? [[]]
        : tiers === 1
          ? [[' Trắng '], ['Đen'], [' Xanh đậm ']]
          : [
              [' Trắng ', 'Hộp  1'],
              [' Trắng ', 'Hộp 3 '],
              ['Đen', 'Hộp  1'],
              ['Đen', 'Hộp 3 '],
            ];
    const variationFiles =
      tiers === 0
        ? []
        : tiers === 1
          ? ['Mẫu trắng.png', 'Mẫu đen.png', 'Mẫu xanh.png']
          : ['Mẫu trắng.png', 'Mẫu đen.png'];
    const imageNames = [
      media.coverPath,
      'Chi tiết 01.png',
      'Chi tiết 02.png',
      'Chi tiết 03.png',
      ...variationFiles,
    ];
    for (const [imageIndex, filename] of imageNames.entries()) {
      const square = filename === media.coverPath;
      listingFiles.push(
        await save(groupKey + '/' + filename, await qaImage(index, String(imageIndex), square), {
          folderName,
          width: 900,
          height: square ? 900 : 1200,
        }),
      );
    }
    const value = category.requiredAttribute.values[shopIndex];
    const logistics = {
      channelId: shop.logisticsChannelId,
      weightGrams: 180 + (family % 4) * 95 + tiers * 40 + (index % 5),
      lengthCm: 12 + (family % 4),
      widthCm: 8 + tiers,
      heightCm: 3 + shopIndex,
    };
    const sheet = priceSheets.get(shop.shopId)!;
    const variants = options.map((optionLabels, variantIndex): BusinessVariantFixture => {
      const sku = `QA-BIZ-${String(family + 1).padStart(3, '0')}-${String(variantIndex + 1).padStart(2, '0')}`;
      const originalPrice = String(10000 + family * 100 + shopIndex * 1000 + variantIndex * 75);
      const promotionTarget = String(Number(originalPrice) - 500 - shopIndex * 100);
      const stock = 30 + family + shopIndex * 7 + variantIndex * 2;
      const imagePath =
        tiers === 0
          ? undefined
          : variationFiles[tiers === 1 ? variantIndex : Math.floor(variantIndex / 2)];
      const priceRow = sheet.rowCount + 1;
      sheet.addRow([
        sku,
        `${category.name} · ${optionLabels.join(' / ') || 'Một SKU'}`,
        category.name,
        category.brandName,
        Number(originalPrice),
        Number(promotionTarget),
        logistics.weightGrams,
        folderName,
        stock,
        optionLabels[0] ?? '',
        optionLabels[1] ?? '',
        imagePath ?? '',
      ]);
      return {
        sku,
        optionLabels,
        tierIndex:
          tiers === 0
            ? []
            : tiers === 1
              ? [variantIndex]
              : [Math.floor(variantIndex / 2), variantIndex % 2],
        originalPrice,
        promotionTarget,
        stock,
        ...(imagePath ? { imagePath } : {}),
        priceRow,
      };
    });
    const coordinationRow = coordination.rowCount + 1;
    coordination.addRow([
      folderName,
      shop.shopId,
      shop.priceSheet,
      category.categoryId,
      category.brandId,
      category.requiredAttribute.attributeId,
      value.valueId,
      logistics.channelId,
      logistics.weightGrams,
      logistics.lengthCm,
      logistics.widthCm,
      logistics.heightCm,
      wordPath,
      media.coverPath,
      JSON.stringify(media.galleryPaths),
      JSON.stringify(media.descriptionPaths),
      tierNames[0] ?? '',
      tierNames[1] ?? '',
    ]);
    listings.push({
      index,
      productKey: `qa-business-${number}`,
      folderName,
      folderPath: join(directory, folderName),
      groupKey,
      shopId: shop.shopId,
      shopName: shop.name,
      priceSheet: shop.priceSheet,
      priceProfile: null,
      coordinationRow,
      categoryId: category.categoryId,
      categoryName: category.name,
      brandId: category.brandId,
      attributes: [
        {
          attributeId: category.requiredAttribute.attributeId,
          valueId: value.valueId,
          name: category.requiredAttribute.name,
          valueName: value.name,
        },
      ],
      logistics,
      title,
      headline: '',
      body,
      expectedDescription: {
        headline: paragraphs[3],
        body: paragraphs.slice(4).join('\n'),
        blocks: [
          { type: 'text', text: paragraphs[3] + '\n\n' },
          ...media.descriptionPaths.map((path) => ({ type: 'image' as const, path })),
          { type: 'text', text: '\n\n' + paragraphs.slice(4).join('\n') },
        ],
      },
      paragraphs,
      wordPath,
      tierNames,
      variants,
      media,
      files: listingFiles,
    });
  }
  const workbook = await save(
    'QA - Điều phối và giá ba shop.xlsx',
    Buffer.from(await book.xlsx.writeBuffer()),
  );
  const counts = (values: string[]) =>
    Object.fromEntries(
      [...new Set(values)].map((value) => [
        value,
        values.filter((entry) => entry === value).length,
      ]),
    );
  const skuShops = new Map<string, Set<string>>();
  for (const listing of listings)
    for (const variant of listing.variants) {
      const scopes = skuShops.get(variant.sku) ?? new Set<string>();
      scopes.add(listing.shopId);
      skuShops.set(variant.sku, scopes);
    }
  const expected = {
    listingCount: listings.length,
    variantCount: listings.reduce((sum, listing) => sum + listing.variants.length, 0),
    wordCount: files.filter((file) => file.kind === 'docx').length,
    imageCount: files.filter((file) => file.kind === 'image').length,
    shopCounts: counts(listings.map((listing) => listing.shopId)),
    categoryCounts: counts(listings.map((listing) => listing.categoryId)),
    tierCounts: counts(listings.map((listing) => String(listing.tierNames.length))),
    sharedSkuAcrossShops: [...skuShops].filter(([, scopes]) => scopes.size > 1).map(([sku]) => sku),
  };
  const manifestPath = join(root, 'source-manifest.json');
  const manifest = Buffer.from(
    JSON.stringify(
      {
        synthetic: true,
        liveEvidence: false,
        statement:
          'Authored QA source values. Fake shop/category/brand/attribute/channel IDs have no live authority. All stock is explicit per SKU/shop. No promotions are requested.',
        root,
        directory,
        workbookPath: workbook.path,
        workbook,
        shops,
        categories,
        listings,
        files,
        expected,
      },
      null,
      2,
    ),
  );
  await writeFile(manifestPath, manifest);
  return {
    root,
    directory,
    workbookPath: workbook.path,
    workbook,
    manifestPath,
    manifestSha256: sha256(manifest),
    shops,
    categories,
    listings,
    files,
    expected,
  };
}

export type BusinessExceptionFixture = BusinessBatchFixture & {
  cases: {
    folderName: string;
    problem:
      | 'missing_word'
      | 'corrupt_word'
      | 'duplicate_price'
      | 'cross_folder_image'
      | 'unknown_shop'
      | 'invalid_image_array'
      | 'good_neighbor';
    expectedSourceAssembly: 'blocked' | 'ready';
  }[];
};

/** Separate negative inputs; creates its own files and never modifies the 80-listing happy fixture. */
export async function createBusinessBatchExceptionFixture(
  options: { root?: string } = {},
): Promise<BusinessExceptionFixture> {
  const fixture = await createBusinessBatchFixture({ ...options, count: 7 });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await readFile(fixture.workbookPath)) as unknown as ExcelJS.Buffer);
  const coordination = book.getWorksheet(businessCoordinationSheet)!;
  const [missing, corrupt, duplicate, crossFolder, unknownShop, invalidArray, good] =
    fixture.listings;
  const missingWord = missing.files.find((file) => file.kind === 'docx')!;
  if (!resolve(missingWord.path).startsWith(fixture.root + sep))
    throw new Error('QA_FIXTURE_PATH_ESCAPED');
  await unlink(missingWord.path);
  missing.files = missing.files.filter((file) => file !== missingWord);
  fixture.files = fixture.files.filter((file) => file !== missingWord);
  const corruptWord = corrupt.files.find((file) => file.kind === 'docx')!;
  const corruptBytes = Buffer.from(
    'QA intentionally corrupt Office file; no original content was replaced.',
  );
  await writeFile(corruptWord.path, corruptBytes);
  corruptWord.bytes = corruptBytes.length;
  corruptWord.sha256 = sha256(corruptBytes);
  const duplicateSheet = book.getWorksheet(duplicate.priceSheet)!;
  const duplicateRow = [
    ...(duplicateSheet.getRow(duplicate.variants[0].priceRow).values as ExcelJS.CellValue[]),
  ].slice(1);
  duplicateRow[4] = Number(duplicate.variants[0].originalPrice) + 999;
  duplicateSheet.addRow(duplicateRow);
  coordination.getCell(crossFolder.coordinationRow, 14).value =
    '../' + good.folderName + '/' + good.media.coverPath;
  coordination.getCell(unknownShop.coordinationRow, 2).value = '919999999';
  coordination.getCell(invalidArray.coordinationRow, 15).value = 'Chi tiết 01.png,Chi tiết 02.png';
  const workbookBytes = Buffer.from(await book.xlsx.writeBuffer());
  await writeFile(fixture.workbookPath, workbookBytes);
  fixture.workbook.bytes = workbookBytes.length;
  fixture.workbook.sha256 = sha256(workbookBytes);
  fixture.expected.wordCount--;
  const cases: BusinessExceptionFixture['cases'] = [
    { folderName: missing.folderName, problem: 'missing_word', expectedSourceAssembly: 'blocked' },
    { folderName: corrupt.folderName, problem: 'corrupt_word', expectedSourceAssembly: 'blocked' },
    {
      folderName: duplicate.folderName,
      problem: 'duplicate_price',
      expectedSourceAssembly: 'blocked',
    },
    {
      folderName: crossFolder.folderName,
      problem: 'cross_folder_image',
      expectedSourceAssembly: 'blocked',
    },
    {
      folderName: unknownShop.folderName,
      problem: 'unknown_shop',
      expectedSourceAssembly: 'blocked',
    },
    {
      folderName: invalidArray.folderName,
      problem: 'invalid_image_array',
      expectedSourceAssembly: 'blocked',
    },
    { folderName: good.folderName, problem: 'good_neighbor', expectedSourceAssembly: 'ready' },
  ];
  const manifest = Buffer.from(
    JSON.stringify(
      {
        ...fixture,
        manifestSha256: undefined,
        synthetic: true,
        liveEvidence: false,
        cases,
        expectationScope:
          'Authored source before faults plus six explicit independent faults and one intact neighbor. Cases are expected application behavior, not observed execution evidence.',
      },
      null,
      2,
    ),
  );
  await writeFile(fixture.manifestPath, manifest);
  return { ...fixture, manifestSha256: sha256(manifest), cases };
}
