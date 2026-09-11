import type { ContentBlock } from '../contracts.js';
export function parseVnd(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('MONEY_FORMAT_REQUIRED');
  return BigInt(value).toString();
}
export function compileDescription(
  headline: string,
  body: string,
  imageKeys: string[],
): ContentBlock[] {
  return [
    { type: 'text', text: headline + '\n\n' },
    ...imageKeys.map((assetKey) => ({ type: 'image' as const, assetKey })),
    { type: 'text', text: '\n\n' + body },
  ];
}
export function sortGalleryKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
}
export function headerKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
