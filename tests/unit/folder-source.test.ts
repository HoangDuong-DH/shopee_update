import { describe, expect, it } from 'vitest';
import type { CatalogRow, SourceRef } from '../../packages/domain/src/contracts.js';
import {
  assembleFolderListing,
  groupDirectoryFiles,
  type FolderAssemblyInput,
  type FolderFile,
  type UploadedFolderFile,
} from '../../apps/web/src/folder-source.js';

const source: SourceRef = {
  fileSha256: 'fixture-sha',
  locator: 'source',
  observedAt: '2026-09-11T00:00:00Z',
  kind: 'product_file',
};
const fact = (value: string) => ({ value, sources: [source], confirmed: true });
const row = (sku: string, overrides: Partial<CatalogRow> = {}): CatalogRow => ({
  key: 'row-' + sku,
  sheet: 'Giá',
  row: 3,
  headerRow: 1,
  sku: fact(sku),
  name: fact('Tên hàng không phải nhãn phân loại'),
  originalPrice: fact('137998'),
  promotionTarget: fact('68999'),
  issues: [],
  ...overrides,
});
function file(path: string): FolderFile {
  return { name: path.split('/').at(-1)!, relativePath: path, size: 12 };
}
function uploaded(path: string, kind: 'image' | 'docx', body?: unknown): UploadedFolderFile {
  return {
    relativePath: path,
    record: {
      id: 'id-' + path,
      filename: path.split('/').at(-1)!,
      sha256: 'sha-' + path,
      kind,
      status: 'ready',
      bytes: 12,
      createdAt: source.observedAt,
      message: '',
      body: body ?? {
        source,
        key: path,
        sha256: 'sha-' + path,
        width: 1024,
        height: 1024,
        bytes: 12,
        mime: 'image/png',
      },
    },
  };
}
function fixture(): FolderAssemblyInput {
  const group = groupDirectoryFiles(
    ['Bộ/content.docx', 'Bộ/1.png', 'Bộ/2.png', 'Bộ/11.png'].map(file),
    'single_listing',
  ).bundles[0];
  return {
    group,
    files: [
      uploaded('Bộ/content.docx', 'docx', {
        source,
        paragraphs: [
          'Tài liệu nguồn',
          'TIÊU ĐỀ \n\n Tên listing giữ khoảng trắng \n',
          'BÀI MÔ TẢ ĐĂNG BÁN',
          'Mở đầu\nPhần chữ đầu',
          'Chữ  còn lại  ',
          '',
          '',
        ],
      }),
      uploaded('Bộ/1.png', 'image'),
      uploaded('Bộ/2.png', 'image'),
      uploaded('Bộ/11.png', 'image'),
    ],
    priceSource: {
      importId: 'price-file',
      sheet: 'Giá',
      priceProfile: null,
      rows: [row('SKU-A'), row('SKU-B')],
    },
    rules: {
      media: {
        convention: 'explicit_selection',
        coverPath: 'Bộ/1.png',
        galleryPaths: ['Bộ/2.png'],
        descriptionPaths: ['Bộ/2.png'],
      },
      word: {
        kind: 'labeled_sections',
        titleHeader: 'TIÊU ĐỀ',
        descriptionHeader: 'BÀI MÔ TẢ ĐĂNG BÁN',
        headline: 'first_line',
        paragraphSeparator: '\n\n',
      },
      membership: {
        tierNames: [' Màu ', 'Quy cách'],
        variants: [
          { sku: 'SKU-B', optionLabels: [' Đen ', '300 cái'], imagePath: 'Bộ/11.png' },
          { sku: 'SKU-A', optionLabels: ['Trắng', ' 100 cái '] },
        ],
      },
    },
  };
}
it('shows name-ranked price candidates without creating membership or replacing exact SKU mappings', async () => {
  const input = fixture();
  delete input.rules.membership;
  const path = 'Bộ/Tinh-dầu-xịt-Hoa-hồng-VINA-TƯƠI-100ml.png';
  input.group.files.push(file(path));
  input.files.push(uploaded(path, 'image'));
  input.priceSource.rows = [
    row('SKU-100', {
      name: fact('Tinh dầu xịt cao cấp Hoa hồng VNT 100ml'),
      brand: fact('VINA TƯƠI'),
    }),
    row('SKU-300', { name: fact('Tinh dầu xịt Hoa hồng VNT 300ml'), brand: fact('VINA TƯƠI') }),
  ];
  const result = await assembleFolderListing(input);
  expect(result.candidates.variants.map((v) => v.sku)).toEqual(['SKU-100']);
  expect(result.seed).toBeUndefined();
  expect(result.issues.some((i) => i.code === 'MEMBERSHIP_NOT_MAPPED')).toBe(true);
  expect(result.issues.some((i) => i.code === 'IMAGE_NAME_RANKED_CANDIDATES')).toBe(true);
});

describe('prepared listing folder grouping', () => {
  it('uses the explicitly selected grouping depth and keeps identical filenames in separate listing folders', () => {
    const files = [
      'Lô/Một/content.docx',
      'Lô/Một/ảnh/1.png',
      'Lô/Hai/content.docx',
      'Lô/Hai/1.png',
    ].map(file);
    const parent = groupDirectoryFiles(files, 'parent_with_listing_folders');
    expect(parent.issues).toEqual([]);
    expect(parent.bundles.map((group) => [group.key, group.files.length])).toEqual([
      ['Lô/Một', 2],
      ['Lô/Hai', 2],
    ]);
    expect(groupDirectoryFiles(files, 'single_listing').bundles[0].files).toHaveLength(4);
  });
  it('reports loose root files, duplicate paths, traversal and multiple roots without silently regrouping them', () => {
    expect(
      groupDirectoryFiles([file('Lô/readme.docx')], 'parent_with_listing_folders').issues[0].code,
    ).toBe('FILE_OUTSIDE_LISTING_FOLDER');
    expect(
      groupDirectoryFiles([file('Lô/1.png'), file('Lô/1.png')], 'single_listing').issues[0].code,
    ).toBe('FOLDER_PATH_DUPLICATE');
    for (const path of ['../a.png', '/Lô/a.png', 'Lô/../a.png', 'Lô\\a.png', 'Lô//a.png'])
      expect(groupDirectoryFiles([file(path)], 'single_listing').bundles).toEqual([]);
    expect(
      groupDirectoryFiles([file('Một/1.png'), file('Hai/1.png')], 'single_listing').bundles,
    ).toEqual([]);
  });
});

describe('prepared listing folder assembly', () => {
  it('accepts a reused image filename alias only with matching selected-file content proof', async () => {
    const input = fixture();
    const image = input.files[1];
    const digest = 'a'.repeat(64);
    image.record!.filename = 'original-canva-export.png';
    image.record!.sha256 = digest;
    const unproven = await assembleFolderListing(input);
    expect(unproven.seed).toBeUndefined();
    expect(unproven.issues.map((item) => item.code)).toContain('FOLDER_FILE_IDENTITY_CHANGED');

    image.sha256 = digest;
    const before = structuredClone(input);
    const proven = await assembleFolderListing(input);
    expect(proven.issues).toEqual([]);
    expect(proven.seed?.coverId).toBe(image.record!.id);
    expect(proven.candidates.cover).toEqual({
      relativePath: 'Bộ/1.png',
      importId: image.record!.id,
      name: '1.png',
    });
    expect(input).toEqual(before);
    expect(image.record!.filename).toBe('original-canva-export.png');
  });

  it('rejects a response with mismatched content even when its filename matches the selected file', async () => {
    const input = fixture();
    input.files[1].sha256 = 'b'.repeat(64);
    input.files[1].record!.sha256 = 'c'.repeat(64);
    const result = await assembleFolderListing(input);
    expect(result.seed).toBeUndefined();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'FOLDER_FILE_CONTENT_CHANGED',
        relativePath: 'Bộ/1.png',
        severity: 'block',
      }),
    );
    expect(result.candidates.cover).toBeUndefined();
    expect(result.candidates.images.map((image) => image.relativePath)).toEqual([
      'Bộ/2.png',
      'Bộ/11.png',
    ]);
  });

  it('applies explicit visual assignments and membership without rewriting text or creating combinations', async () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = await assembleFolderListing(input);
    expect(result.issues).toEqual([]);
    expect(result.seed).toMatchObject({
      title: ' Tên listing giữ khoảng trắng ',
      headline: 'Mở đầu',
      body: 'Phần chữ đầu\n\nChữ  còn lại  \n\n\n\n',
      coverId: 'id-Bộ/1.png',
      galleryIds: ['id-Bộ/2.png'],
      descriptionImageIds: ['id-Bộ/2.png'],
      tierNames: [' Màu ', 'Quy cách'],
      variants: [
        {
          importId: 'price-file',
          rowKey: 'row-SKU-B',
          optionLabels: [' Đen ', '300 cái'],
          imageId: 'id-Bộ/11.png',
        },
        { importId: 'price-file', rowKey: 'row-SKU-A', optionLabels: ['Trắng', ' 100 cái '] },
      ],
    });
    expect(result.provenance.some((ref) => ref.locator === 'Bộ/content.docx#section:TIÊU ĐỀ')).toBe(
      true,
    );
    expect(input).toEqual(before);
  });

  it('shows Word and numeric images immediately but never uses image order or catalog names as SKU labels', async () => {
    const input = fixture();
    input.rules = {};
    const result = await assembleFolderListing(input);
    expect(result.candidates.title).toBe(' Tên listing giữ khoảng trắng ');
    expect(result.candidates.body).toContain('Chữ  còn lại  ');
    expect(result.candidates.images).toHaveLength(3);
    expect(result.candidates.variants).toEqual([]);
    expect(result.seed).toBeUndefined();
    expect(result.issues.map((item) => item.code)).toContain('MEMBERSHIP_NOT_MAPPED');
    expect(result.issues.map((item) => item.code)).toContain('COVER_NOT_SELECTED');
  });

  it('provides exact isolated SKU filename candidates without guessing membership, labels, case or substrings', async () => {
    const input = fixture();
    delete input.rules.membership;
    for (const name of ['SKU-A.png', 'XSku-A.png', 'SKU-A9.png', 'sku-a.png']) {
      input.group.files.push(file('Bộ/' + name));
      input.files.push(uploaded('Bộ/' + name, 'image'));
    }
    const result = await assembleFolderListing(input);
    expect(result.candidates.variants).toHaveLength(1);
    expect(result.candidates.variants[0]).toMatchObject({
      sku: 'SKU-A',
      imagePath: 'Bộ/SKU-A.png',
    });
    expect(result.candidates.variants[0].optionLabels).toBeUndefined();
    expect(result.seed).toBeUndefined();
  });

  it('uses only explicit filename convention numbers and retains distinct gallery/description roles', async () => {
    const input = fixture();
    for (const name of ['Ảnh-Bìa.png', 'sản-phẩm-g2.png', 'sản-phẩm-g1.png', 'sản-phẩm-g9.png']) {
      input.group.files.push(file('Bộ/' + name));
      input.files.push(uploaded('Bộ/' + name, 'image'));
    }
    input.rules.media = {
      convention: 'cover-and-g-number',
      gallery: [1, 2],
      descriptionImages: 'all_g',
    };
    const result = await assembleFolderListing(input);
    expect(result.candidates.cover?.name).toBe('Ảnh-Bìa.png');
    expect(result.candidates.gallery.map((image) => image.name)).toEqual([
      'sản-phẩm-g1.png',
      'sản-phẩm-g2.png',
    ]);
    expect(result.candidates.descriptionImages.map((image) => image.name)).toEqual([
      'sản-phẩm-g1.png',
      'sản-phẩm-g2.png',
      'sản-phẩm-g9.png',
    ]);
  });

  it('blocks ambiguous/missing price matches and never chooses another profile automatically', async () => {
    const input = fixture();
    input.priceSource.rows.push(
      row('SKU-A', { key: 'duplicate' }),
      row('SKU-B', { key: 'mall-only', priceProfile: 'MALL' }),
    );
    let result = await assembleFolderListing(input);
    expect(result.seed).toBeUndefined();
    expect(result.candidates.variants[0].sourceRows.map((row) => row.key)).toEqual(['row-SKU-B']);
    expect(result.issues.map((item) => item.code)).toContain('VARIANT_PRICE_SOURCE_UNRESOLVED');
    input.rules.membership!.variants[1].rowKey = 'row-SKU-A';
    result = await assembleFolderListing(input);
    expect(result.seed).toBeDefined();
  });

  it('clears only resolved duplicate-SKU warnings after an exact price-row selection', async () => {
    const input = fixture();
    input.priceSource.rows[1].issues = [
      {
        code: 'DUPLICATE_SKU',
        message: 'Repeated across price profiles',
        field: 'sku',
        severity: 'warn',
        sources: [source],
      },
      {
        code: 'SOURCE_REVIEW',
        message: 'Keep this source concern',
        field: 'price',
        severity: 'warn',
        sources: [source],
      },
    ];
    input.priceSource.rows.push(row('SKU-B', { key: 'mall-only', priceProfile: 'MALL' }));
    let result = await assembleFolderListing(input);
    expect(result.seed).toBeDefined();
    expect(result.issues.map((item) => item.code)).not.toContain('DUPLICATE_SKU');
    expect(result.issues.map((item) => item.code)).toContain('SOURCE_REVIEW');
    input.priceSource.rows.push(row('SKU-B', { key: 'same-profile-duplicate' }));
    result = await assembleFolderListing(input);
    expect(result.seed).toBeUndefined();
    expect(result.issues.map((item) => item.code)).toContain('VARIANT_PRICE_SOURCE_UNRESOLVED');
    input.rules.membership!.variants[0].rowKey = 'row-SKU-B';
    result = await assembleFolderListing(input);
    expect(result.seed).toBeDefined();
    expect(result.issues.map((item) => item.code)).not.toContain('DUPLICATE_SKU');
    expect(result.issues.map((item) => item.code)).toContain('SOURCE_REVIEW');
  });

  it('rejects cross-folder image references and duplicate role positions while retaining valid source candidates', async () => {
    const input = fixture();
    input.files.push(uploaded('Khác/ảnh.png', 'image'));
    input.rules.media = {
      convention: 'explicit_selection',
      coverPath: 'Khác/ảnh.png',
      galleryPaths: ['Bộ/2.png', 'Bộ/2.png'],
      descriptionPaths: [],
    };
    const result = await assembleFolderListing(input);
    expect(result.seed).toBeUndefined();
    expect(result.candidates.images).toHaveLength(3);
    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(['ROLE_IMAGE_NOT_IN_FOLDER', 'DUPLICATE_ROLE_IMAGE']),
    );
    expect(result.candidates.title).toBeDefined();
  });

  it('retains successfully read candidates when a file failed and does not invent an import record', async () => {
    const input = fixture();
    input.files[3] = { relativePath: 'Bộ/11.png', record: null, error: 'upload failed' };
    const result = await assembleFolderListing(input);
    expect(result.seed).toBeUndefined();
    expect(result.candidates.images).toHaveLength(2);
    expect(result.candidates.title).toBeDefined();
    expect(result.issues.find((item) => item.relativePath === 'Bộ/11.png')?.code).toBe(
      'FOLDER_FILE_NOT_READY',
    );
  });

  it('keeps supplied logical identity while source hashes detect changed content independently of mapping edits', async () => {
    const input = fixture();
    const original = await assembleFolderListing(input);
    expect((await assembleFolderListing(structuredClone(input))).productKey).toBe(
      original.productKey,
    );
    input.rules.media = {
      convention: 'explicit_selection',
      coverPath: 'Bộ/2.png',
      galleryPaths: ['Bộ/1.png'],
      descriptionPaths: [],
    };
    expect((await assembleFolderListing(input)).productKey).toBe(original.productKey);
    input.productKey = 'stable-company-listing';
    input.files[0].record!.sha256 = 'changed-word-hash';
    const changed = await assembleFolderListing(input);
    expect(changed.productKey).toBe('stable-company-listing');
    expect(changed.sourceFingerprint).not.toBe(original.sourceFingerprint);
  });

  it('keeps ambiguous Word candidates unresolved instead of taking the first possible title', async () => {
    const input = fixture();
    input.files[0].record!.body = {
      source,
      paragraphs: ['TIÊU ĐỀ', 'Một tiêu đề', 'Tiêu đề khác', 'BÀI MÔ TẢ ĐĂNG BÁN', 'Chữ'],
    };
    const result = await assembleFolderListing(input);
    expect(result.candidates.title).toBeUndefined();
    expect(result.seed).toBeUndefined();
    expect(result.issues.map((item) => item.code)).toContain('WORD_TITLE_AMBIGUOUS');
  });
});
