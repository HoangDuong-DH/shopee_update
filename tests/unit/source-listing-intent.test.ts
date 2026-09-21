import { expect, it } from 'vitest';
import { sourceListingIntent } from '../../packages/domain/src/source-catalog.js';

it('routes only blank source IDs to create, and preserves the exact existing target', () => {
  for (const value of [null, undefined, '', '  \t\n'])
    expect(sourceListingIntent(value)).toEqual({ kind: 'create', itemId: null });
  expect(sourceListingIntent('29926930476')).toEqual({ kind: 'update', itemId: '29926930476' });
  expect(sourceListingIntent(' 29926930476 ')).toEqual({ kind: 'update', itemId: '29926930476' });
  expect(sourceListingIntent(29926930476)).toEqual({ kind: 'update', itemId: '29926930476' });
});

it('never falls back to create for malformed, formula, URL or unsafe source IDs', () => {
  for (const value of ['0', '00123', '-1', '123.4', '1e10', '9007199254740992', '#VALUE!',
    '=C4', 'https://shopee.vn/product/1/2', {}, false, Number.MAX_SAFE_INTEGER + 1])
    expect(sourceListingIntent(value).kind).toBe('invalid');
});
