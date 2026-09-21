import { expect, it } from 'vitest';
import {
  rankImagePriceCandidates,
  longestContiguousMatch,
} from '../../packages/domain/src/source/image-price-candidates.js';
import type { CatalogRow } from '../../packages/domain/src/contracts.js';
const fact = (value: string) => ({ value, confirmed: true, sources: [] });
const row = (sku: string, name: string, brand = 'VINA TƯƠI'): CatalogRow => ({
  key: sku,
  sheet: 'DORIS',
  row: 1,
  headerRow: 1,
  sku: fact(sku),
  name: fact(name),
  brand: fact(brand),
  originalPrice: fact('100000'),
  issues: [],
});
it('ranks the longest contiguous normalized text only inside exact scent/capacity/family/brand', () => {
  const rows = [
    row('300', 'Tinh dầu xịt cao cấp Hoa hồng VNT 300ml'),
    row('100', 'Tinh dầu xịt cao cấp Hoa hồng VNT 100ml'),
    row('longer', 'Tinh dầu xịt Hoa hồng VINA TƯƠI 100ml'),
    row('jasmine', 'Tinh dầu xịt Hoa lài VNT 100ml'),
    row('other', 'Tinh dầu xịt Hoa hồng ABURA 100ml', 'ABURA'),
  ];
  const before = JSON.stringify(rows);
  const r = rankImagePriceCandidates('Tinh-dầu-xịt-Hoa-hồng-(MỚI)-VINA-TƯƠI-100ml.png', rows);
  expect(r.candidates.map((c) => c.row.sku.value)).toEqual(['longer', '100']);
  expect(r.candidates[0]!.score).toBeGreaterThan(r.candidates[1]!.score);
  expect(r.candidates[0]!.score).toBeGreaterThan(0);
  expect(r.requiresConfirmation).toBe(true);
  expect(JSON.stringify(rows)).toBe(before);
  expect(longestContiguousMatch('abXcd', 'abYcd').length).toBe(2);
});
it('retains ties and does not treat a partial scent, conflicting volume or package/concentration as a match', () => {
  const a = row('A', 'Tinh dầu xịt Sả Chanh VNT 100ml');
  expect(
    rankImagePriceCandidates('Tinh dầu xịt Sả Chanh VINA TƯƠI 100ml.png', [
      a,
      { ...a, key: 'B', sku: fact('B') },
    ]).issues,
  ).toContain('NAME_MATCH_TIE');
  expect(
    rankImagePriceCandidates('Tinh dầu xịt Sả Chanh VINA TƯƠI 100ml-300ml.png', [a]).issues,
  ).toContain('IMAGE_CAPACITY_AMBIGUOUS');
  expect(
    rankImagePriceCandidates('Tinh dầu xịt Chanh VINA TƯƠI 100ml.png', [a]).candidates,
  ).toEqual([]);
  for (const name of [
    'Tinh dầu xịt Sả Chanh VINA TƯƠI 10ml.png',
    'Tinh dầu xịt Sả Chanh VINA TƯƠI 100ml 50%.png',
    'Combo 2 chai Tinh dầu xịt Sả Chanh VINA TƯƠI 100ml.png',
    'Nến thơm Sả Chanh VINA TƯƠI 100g.png',
  ])
    expect(rankImagePriceCandidates(name, [a]).candidates).toEqual([]);
});
it('explicit SKU never falls back to a different ranked row and equivalent capacity units match', () => {
  const rows = [
    row('A', 'Nước lau sàn Vỏ Quế VNT 1 lít'),
    row('B', 'Tinh dầu xịt Vỏ Quế VNT 100ml'),
  ];
  expect(
    rankImagePriceCandidates('Nước lau sàn Vỏ Quế VINA TƯƠI 1000ml.png', rows).candidates.map(
      (c) => c.row.sku.value,
    ),
  ).toEqual(['A']);
  expect(
    rankImagePriceCandidates('Nước lau sàn Vỏ Quế VINA TƯƠI 1000ml.png', rows, {
      explicitSku: 'MISSING',
    }).candidates,
  ).toEqual([]);
  expect(
    rankImagePriceCandidates('Nước lau sàn Vỏ Quế VINA TƯƠI 1000ml.png', rows, {
      explicitSku: 'B',
    }).candidates.map((c) => c.row.sku.value),
  ).toEqual(['B']);
});
it('does not shorten an unknown compound scent to an available shorter scent', () => {
  const rows = [
    row('lemon', 'Tinh dầu xịt Chanh VNT 100ml'),
    row('lemongrass', 'Tinh dầu xịt Sả Chanh VNT 300ml'),
  ];
  expect(
    rankImagePriceCandidates('Tinh dầu xịt Sả Chanh VINA TƯƠI 100ml.png', rows).candidates,
  ).toEqual([]);
  expect(
    rankImagePriceCandidates('Tinh dầu xịt Vỏ Chanh VINA TƯƠI 100ml.png', rows.slice(0, 1))
      .candidates,
  ).toEqual([]);
});
it('uses the listing title only for missing brand and family in a numbered variant filename', () => {
  const rows = [
    row('floor', 'Nước lau sàn Oải Hương VNT 1 lít'),
    row('spray', 'Tinh dầu xịt Oải Hương VNT 100ml'),
  ];
  const options = {
    trustedContext: { listingTitle: 'Nước Lau Sàn VINA TƯƠI - Sáu Lựa Chọn Chai 1 Lít' },
  };
  const result = rankImagePriceCandidates('phan-loai-01-oai-huong-1l.png', rows, options);
  expect(result.candidates.map((c) => c.row.sku.value)).toEqual(['floor']);
  expect(result.requiresConfirmation).toBe(true);
  expect(rankImagePriceCandidates('phan-loai-01-oai-huong-1l.png', rows).candidates).toEqual([]);
  expect(
    rankImagePriceCandidates('Tinh dầu xịt Oải Hương VINA TƯƠI 100ml.png', rows, options)
      .candidates,
  ).toEqual([]);
});
it('resolves the full scent before capacity and cannot replace a missing compound scent with its suffix', () => {
  const rows = [
    row('lemon', 'Tinh dầu xịt Chanh VNT 100ml'),
    row('lemongrass', 'Tinh dầu xịt Sả Chanh VNT 300ml'),
  ];
  const options = { trustedContext: { listingTitle: 'Xịt Khử Mùi VINA TƯƠI' } };
  expect(
    rankImagePriceCandidates('phan-loai-01-sa-chanh-100ml.png', rows, options).candidates,
  ).toEqual([]);
  expect(
    rankImagePriceCandidates('phan-loai-01-vo-chanh-100ml.png', rows.slice(0, 1), options)
      .candidates,
  ).toEqual([]);
  expect(
    rankImagePriceCandidates('phan-loai-01-sa-chanh-300ml.png', rows, options).candidates.map(
      (c) => c.row.sku.value,
    ),
  ).toEqual(['lemongrass']);
});
