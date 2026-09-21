import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { strToU8, zipSync } from 'fflate';

// Deliberately synthetic: these names are source category labels, not live Shopee IDs/rights.
export const categoryFamilies = ['QA Văn phòng phẩm', 'QA Gia dụng', 'QA Mẹ và bé', 'QA Làm đẹp'];
export const shopProfiles = [
  { shopId: '910000001', name: 'QA Shop Bắc', priceProfile: 'QA Bắc', price: 11001 },
  { shopId: '910000002', name: 'QA Shop Trung', priceProfile: 'QA Trung', price: 22002 },
  { shopId: '910000003', name: 'QA Shop Nam', priceProfile: 'QA Nam', price: 33003 },
];
export const sharedSku = 'QA-SHARED-001';
export const priceSheet = 'Giá chung 3 shop';
export const conflictSheet = 'Giá xung đột';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type SourceFile = {
  relativePath: string;
  path: string;
  kind: 'docx' | 'image' | 'xlsx';
  sha256: string;
  bytes: number;
  paragraphs?: string[];
  expectedStatus: 'ready' | 'failed';
};
export type FolderFixture = {
  name: string;
  categoryFamily: string;
  sku: string;
  files: SourceFile[];
};
export type BulkFolderFixture = {
  root: string;
  directory: string;
  exceptionDirectory: string;
  workbook: SourceFile;
  folders: FolderFixture[];
  exceptions: SourceFile[];
};
const xmlEscape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function wordBytes(paragraphs: string[]) {
  const document =
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs
      .map(
        (value) => '<w:p><w:r><w:t xml:space="preserve">' + xmlEscape(value) + '</w:t></w:r></w:p>',
      )
      .join('') +
    '<w:sectPr/></w:body></w:document>';
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      'word/document.xml': strToU8(document),
    }),
  );
}
async function imageBytes(index: number, role: number) {
  return sharp({
    create: {
      width: role === 1 ? 120 : 90,
      height: 120,
      channels: 3,
      background: { r: (index * 3) % 256, g: role * 70, b: (index * 11 + role) % 256 },
    },
  })
    .png()
    .toBuffer();
}
export async function createBulkFolderFixture(): Promise<BulkFolderFixture> {
  const parent = resolve('.local/acceptance-20260914/bulk-folders');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  const directory = join(root, '80-listing-folders');
  const exceptionDirectory = join(root, 'isolated-exceptions');
  async function file(
    relativePath: string,
    bytes: Buffer,
    paragraphs?: string[],
    expectedStatus: 'ready' | 'failed' = 'ready',
  ): Promise<SourceFile> {
    const path = resolve(root, relativePath);
    if (!path.startsWith(root + sep))
      throw new Error('Synthetic fixture path escaped its run directory');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return {
      relativePath,
      path,
      kind: relativePath.endsWith('.docx')
        ? 'docx'
        : relativePath.endsWith('.xlsx')
          ? 'xlsx'
          : 'image',
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...(paragraphs ? { paragraphs } : {}),
      expectedStatus,
    };
  }
  const folders: FolderFixture[] = [];
  for (let index = 0; index < 80; index++) {
    const number = String(index + 1).padStart(3, '0');
    const categoryFamily = categoryFamilies[index % categoryFamilies.length];
    const name = `${number} - ${categoryFamily}`;
    const sku = index === 0 ? sharedSku : `QA-SOURCE-${number}`;
    const paragraphs = [
      'TIÊU ĐỀ',
      `  QA ${number} · ${categoryFamily} · tiêu đề nguyên bản  `,
      'BÀI MÔ TẢ ĐĂNG BÁN',
      `Mở đầu ${number} & chi tiết <gốc>`,
      `  Phần thân ${number}: giữ  hai khoảng trắng.  `,
      '',
      `Kết thúc ${number} — SKU ${sku}`,
    ];
    const prefix = basename(directory) + '/' + name + '/';
    const files = [await file(prefix + 'content.docx', wordBytes(paragraphs), paragraphs)];
    for (let role = 1; role <= 3; role++) {
      // Two folders intentionally contain identical bytes; their membership remains separate.
      const imageIndex = index === 79 && role === 3 ? 78 : index;
      files.push(await file(prefix + role + '.png', await imageBytes(imageIndex, role)));
    }
    folders.push({ name, categoryFamily, sku, files });
  }
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(priceSheet);
  sheet.addRow([
    '',
    '',
    '',
    ...shopProfiles.flatMap((shop) => [shop.priceProfile, shop.priceProfile]),
  ]);
  sheet.addRow([
    'SKU',
    'TÊN SẢN PHẨM',
    'NGÀNH HÀNG',
    ...shopProfiles.flatMap(() => ['GIÁ GỐC', 'GIÁ BÁN']),
  ]);
  folders.forEach((folder, index) =>
    sheet.addRow([
      folder.sku,
      folder.name,
      folder.categoryFamily,
      ...shopProfiles.flatMap((shop) => [shop.price + index * 10, shop.price + index * 10 - 1000]),
    ]),
  );
  const conflict = book.addWorksheet(conflictSheet);
  conflict.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC']);
  conflict.addRow([sharedSku, 'QA Cùng SKU — giá thứ nhất', 44004]);
  conflict.addRow([sharedSku, 'QA Cùng SKU — giá thứ hai', 55005]);
  const workbook = await file(
    'QA - Bảng giá chung ba shop.xlsx',
    Buffer.from(await book.xlsx.writeBuffer()),
  );
  const exceptionPrefix = basename(exceptionDirectory) + '/';
  const goodParagraphs = [
    'TIÊU ĐỀ',
    'QA hàng xóm đọc được',
    'BÀI MÔ TẢ ĐĂNG BÁN',
    'Giữ tệp tốt khi thư mục khác bị lỗi.',
  ];
  const exceptions = [
    await file(exceptionPrefix + '01 Missing Word/1.png', await imageBytes(90, 1)),
    await file(
      exceptionPrefix + '02 Corrupt Word/content.docx',
      Buffer.from('This is not an Office archive.'),
      undefined,
      'failed',
    ),
    await file(exceptionPrefix + '02 Corrupt Word/1.png', await imageBytes(91, 1)),
    await file(
      exceptionPrefix + '03 Good Neighbour/content.docx',
      wordBytes(goodParagraphs),
      goodParagraphs,
    ),
    await file(exceptionPrefix + '03 Good Neighbour/1.png', await imageBytes(92, 1)),
    await file(
      exceptionPrefix + '04 Corrupt Image/content.docx',
      wordBytes([
        'TIÊU ĐỀ',
        'QA ảnh lỗi nhưng Word tốt',
        'BÀI MÔ TẢ ĐĂNG BÁN',
        'Nguyên văn giữ lại.',
      ]),
      ['TIÊU ĐỀ', 'QA ảnh lỗi nhưng Word tốt', 'BÀI MÔ TẢ ĐĂNG BÁN', 'Nguyên văn giữ lại.'],
    ),
    await file(
      exceptionPrefix + '04 Corrupt Image/1.png',
      Buffer.from('This is not a PNG.'),
      undefined,
      'failed',
    ),
  ];
  const fixture = { root, directory, exceptionDirectory, workbook, folders, exceptions };
  await writeFile(
    join(root, 'source-manifest.json'),
    JSON.stringify({ ...fixture, synthetic: true, categoryFamilies, shopProfiles }, null, 2),
  );
  return fixture;
}
