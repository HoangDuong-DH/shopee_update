import { describe, expect, it } from 'vitest';
import {
  classifyFolderImage,
  fillSuggestedImageRoles,
  suggestFolderImageRoles,
} from '../../apps/web/src/folder-image-names.js';

describe('folder image filename recognition', () => {
  it.each([
    ['Bộ/g1.png', 1],
    ['Bộ/G02.JPG', 2],
    ['Bộ/g_2.webp', 2],
    ['Bộ/g 2.png', 2],
    ['Bộ/Nuoc-Lau-San-Huong-Que-VINA-TUOI-San-Nha-Thom-Am-g2.png', 2],
  ])('recognizes content suffixes in %s', (path, ordinal) => {
    expect(classifyFolderImage(path)).toMatchObject({ role: 'content', ordinal });
  });

  it.each([
    'Bộ/Nuoc-Lau-San-Huong-Que-VINA-TUOI-San-Nha-Thom-Am-Sau-Lua-Chon-Chai-1-Lit -anh-bia.png',
    'Bộ/Ảnh-Bìa.PNG',
    'Bộ/anh_bia.jpg',
    'Bộ/Tinh dầu - ẢNH BÌA.webp',
    'Bộ/cover.png',
    'Bộ/Tên-sản-phẩm-cover.jpg',
  ])('recognizes a cover token in %s', (path) => {
    expect(classifyFolderImage(path).role).toBe('cover');
  });

  it.each([
    ['Bộ/1.png', 1],
    ['Bộ/02.jpg', 2],
    ['Bộ/10.PNG', 10],
  ])(
    'keeps whole numeric filenames unresolved until their convention is known: %s',
    (path, ordinal) => {
      expect(classifyFolderImage(path)).toMatchObject({ role: 'numbered', ordinal });
    },
  );

  it.each([
    'Bộ/phan-loai-Huong-Que-100ml.png',
    'Bộ/Phân-loại-Hương-Sả-300ml.jpg',
    'Bộ/pl-02-Huong-Buoi.webp',
  ])('recognizes an explicit variation marker: %s', (path) => {
    expect(classifyFolderImage(path).role).toBe('variant');
  });

  it.each([
    'Bộ/chua-phan-vai-tro-anh-bia.png',
    'Bộ/chua-phan-vai-tro-product-g2.jpg',
    'Bộ/chua-phan-vai-tro-1.png',
    'Bộ/chua-phan-vai-tro-phan-loai-Huong-Que.webp',
  ])('keeps explicitly unresolved files unknown despite old role-looking names: %s', (path) => {
    expect(classifyFolderImage(path).role).toBe('unknown');
  });

  it.each([
    'Bộ/0.png',
    'Bộ/00.png',
    'Bộ/9007199254740992.png',
    'Bộ/product-1.png',
    'Bộ/100ml.png',
    'Bộ/-1.png',
    'Bộ/1.5.png',
    'Bộ/big2.png',
    'Bộ/g2-extra.png',
    'Bộ/coverall.png',
    'Bộ/anh-biax.png',
  ])('does not infer a role from unrelated or invalid numbering: %s', (path) => {
    expect(classifyFolderImage(path).role).toBe('unknown');
  });

  it.each([
    'Bộ/draft-g1.png',
    'Bộ/Nháp-ảnh-bìa.png',
    'Bộ/backup-cover.png',
    'Bộ/san-pham-g2-copy.png',
    'Bộ/san-pham-g2 (1).png',
    'Bộ/draft/1.png',
    'Bộ/Nháp/g2.png',
    'Bộ/backup/Ảnh-Bìa.png',
  ])('keeps a draft or copy available only for manual selection: %s', (path) => {
    expect(classifyFolderImage(path).role).toBe('draft');
  });

  it.each(['Bộ/drafted-g1.png', 'Bộ/copyright-g2.png', 'Bộ/backupseed-g3.png'])(
    'does not match draft markers inside ordinary words: %s',
    (path) => {
      expect(classifyFolderImage(path).role).toBe('content');
    },
  );

  it('uses the selected basename even when parent folders contain role-looking names', () => {
    expect(classifyFolderImage('Bộ/g2/1.png')).toMatchObject({ role: 'numbered', ordinal: 1 });
    expect(classifyFolderImage('Bộ/cover/product-1.png').role).toBe('unknown');
    // The selected path may differ from the filename on a SHA-reused import record.
    expect(suggestFolderImageRoles(['Bộ/renamed-product-g2.png']).contentPaths).toEqual([
      'Bộ/renamed-product-g2.png',
    ]);
  });

  it('does not confuse the existing portable Nhap_01 batch folder with a draft folder', () => {
    const result = suggestFolderImageRoles([
      'Bo_nguon/Nhap_01/Nuoc-Lau-San/product-g1.png',
      'Bo_nguon/Nhap_01/Nuoc-Lau-San/anh-bia.png',
      'Bo_nguon/Nhap_01/Nuoc-Lau-San/02.png',
    ]);
    expect(result.coverPath).toBe('Bo_nguon/Nhap_01/Nuoc-Lau-San/anh-bia.png');
    expect(result.contentPaths).toEqual(['Bo_nguon/Nhap_01/Nuoc-Lau-San/product-g1.png']);
    expect(classifyFolderImage('Bo_nguon/Nhap_01/Nuoc-Lau-San/02.png').role).toBe('numbered');
  });
});

describe('folder image role suggestions', () => {
  it('sorts content numerically and does not turn plain numbers into variation assignments', () => {
    const paths = [
      'Bộ/10.png',
      'Bộ/product-g10.png',
      'Bộ/product-g2.png',
      'Bộ/02.jpg',
      'Bộ/product-g1.png',
      'Bộ/1.png',
      'Bộ/anh-bia.png',
    ];
    const before = [...paths];
    const result = suggestFolderImageRoles(paths);
    expect(result.coverPath).toBe('Bộ/anh-bia.png');
    expect(result.contentPaths).toEqual([
      'Bộ/product-g1.png',
      'Bộ/product-g2.png',
      'Bộ/product-g10.png',
    ]);
    expect(result.variantPaths).toEqual([]);
    expect(paths).toEqual(before);
  });

  it('requires role evidence for a plain Canva sequence including later pages', () => {
    const paths = [
      'Bộ/2.png',
      'Bộ/3.png',
      'Bộ/9.png',
      'Bộ/10.png',
      'Bộ/11.png',
      'Bộ/26.png',
      'Bộ/27.png',
    ];
    expect(paths.map((path) => classifyFolderImage(path).role)).toEqual([
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
    ]);
    const result = suggestFolderImageRoles(paths);
    expect(result.coverPath).toBeUndefined();
    expect(result.contentPaths).toEqual([]);
    expect(result.variantPaths).toEqual([]);
  });

  it('suggests explicitly named variation files without guessing a matching SKU', () => {
    const result = suggestFolderImageRoles([
      'Bộ/pl-Huong-Que-100ml.png',
      'Bộ/26.png',
      'Bộ/product-g1.png',
    ]);
    expect(result.variantPaths).toEqual(['Bộ/pl-Huong-Que-100ml.png']);
    expect(result.contentPaths).toEqual(['Bộ/product-g1.png']);
  });

  it('does not choose one of multiple cover candidates', () => {
    const result = suggestFolderImageRoles(['Bộ/ảnh-bìa.png', 'Bộ/cover.jpg', 'Bộ/g1.png']);
    expect(result.coverPath).toBeUndefined();
    expect(result.contentPaths).toEqual(['Bộ/g1.png']);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('withholds the entire content suggestion when a g ordinal is duplicated', () => {
    const result = suggestFolderImageRoles([
      'Bộ/product-g1.png',
      'Bộ/product-G01.jpg',
      'Bộ/product-g2.png',
      'Bộ/1.png',
    ]);
    expect(result.contentPaths).toEqual([]);
    expect(result.variantPaths).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('withholds content from different named designs even without duplicate ordinals', () => {
    const result = suggestFolderImageRoles([
      'Bộ/Huong-Que-g1.png',
      'Bộ/Huong-Sa-g2.png',
      'Bộ/cover.png',
    ]);
    expect(result.contentPaths).toEqual([]);
    expect(result.coverPath).toBe('Bộ/cover.png');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not treat draft copies as competing cover or content candidates', () => {
    const result = suggestFolderImageRoles([
      'Bộ/cover.png',
      'Bộ/cover (1).png',
      'Bộ/product-g1.png',
      'Bộ/product-g1-copy.png',
      'Bộ/draft/product-g2.png',
      'Bộ/backup/1.png',
    ]);
    expect(result.coverPath).toBe('Bộ/cover.png');
    expect(result.contentPaths).toEqual(['Bộ/product-g1.png']);
    expect(result.variantPaths).toEqual([]);
  });

  it('leaves an unrecognized folder available for manual assignment', () => {
    const result = suggestFolderImageRoles(['Bộ/product-photo.png', 'Bộ/100ml.png']);
    expect(result.coverPath).toBeUndefined();
    expect(result.contentPaths).toEqual([]);
    expect(result.variantPaths).toEqual([]);
  });
});

describe('filling only empty image roles after an explicit user action', () => {
  const suggestions = {
    coverPath: 'Bộ/cover.png',
    contentPaths: ['Bộ/g1.png', 'Bộ/g2.png'],
    variantPaths: ['Bộ/pl-Huong-Que.png', 'Bộ/pl-Huong-Sa.png'],
    warnings: [],
  };

  it.each([
    ['gallery', ['Bộ/g1.png', 'Bộ/g2.png'], []],
    ['description', [], ['Bộ/g1.png', 'Bộ/g2.png']],
    ['both', ['Bộ/g1.png', 'Bộ/g2.png'], ['Bộ/g1.png', 'Bộ/g2.png']],
  ] as const)('fills only the requested content destination: %s', (role, gallery, description) => {
    const result = fillSuggestedImageRoles(
      { galleryPaths: [], descriptionPaths: [] },
      suggestions,
      role,
    );
    expect(result).toEqual({
      coverPath: 'Bộ/cover.png',
      galleryPaths: [...gallery],
      descriptionPaths: [...description],
    });
  });

  it('preserves all existing choices and their manually arranged order', () => {
    const current = {
      coverPath: 'Bộ/manual-cover.jpg',
      galleryPaths: ['Bộ/manual-2.jpg', 'Bộ/manual-1.jpg'],
      descriptionPaths: ['Bộ/manual-description.jpg'],
    };
    const before = structuredClone(current);
    const suggestionsBefore = structuredClone(suggestions);
    expect(fillSuggestedImageRoles(current, suggestions, 'both')).toEqual(before);
    expect(current).toEqual(before);
    expect(suggestions).toEqual(suggestionsBefore);
  });

  it('fills an empty description without replacing a chosen cover or gallery', () => {
    expect(
      fillSuggestedImageRoles(
        {
          coverPath: 'Bộ/manual-cover.jpg',
          galleryPaths: ['Bộ/manual-gallery.jpg'],
          descriptionPaths: [],
        },
        suggestions,
        'both',
      ),
    ).toEqual({
      coverPath: 'Bộ/manual-cover.jpg',
      galleryPaths: ['Bộ/manual-gallery.jpg'],
      descriptionPaths: ['Bộ/g1.png', 'Bộ/g2.png'],
    });
  });

  it('does not substitute variation candidates for ambiguous content or cover', () => {
    const result = fillSuggestedImageRoles(
      { galleryPaths: [], descriptionPaths: [] },
      { contentPaths: [], variantPaths: ['Bộ/pl-Huong-Que.png'], warnings: ['Cần chọn tay'] },
      'both',
    );
    expect(result.coverPath).toBeUndefined();
    expect(result.galleryPaths).toEqual([]);
    expect(result.descriptionPaths).toEqual([]);
  });
});
