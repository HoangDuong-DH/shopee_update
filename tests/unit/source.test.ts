import { expect, it } from 'vitest';
import {
  compileDescription,
  parseVnd,
  sortGalleryKeys,
} from '../../packages/domain/src/source/normalize.js';
it('keeps g1 and all paragraph whitespace in an explicit content layout', () => {
  expect(compileDescription('🎒 Tiêu đề', 'Nội dung\n\nDòng sau ', ['g1', 'g2'])).toEqual([
    { type: 'text', text: '🎒 Tiêu đề\n\n' },
    { type: 'image', assetKey: 'g1' },
    { type: 'image', assetKey: 'g2' },
    { type: 'text', text: '\n\nNội dung\n\nDòng sau ' },
  ]);
});
it('rejects ambiguous money, fractions and invalid values instead of silently changing the price', () => {
  expect(parseVnd('137998')).toBe('137998');
  for (const value of ['137.998', '137998.5', '-1', '', ' 137998', 'NaN'])
    expect(() => parseVnd(value)).toThrow();
  expect(parseVnd('0')).toBe('0');
});
it('sorts numbered source images numerically', () => {
  expect(sortGalleryKeys(['anh-g10.png', 'anh-g2.png', 'anh-g1.png'])).toEqual([
    'anh-g1.png',
    'anh-g2.png',
    'anh-g10.png',
  ]);
});
