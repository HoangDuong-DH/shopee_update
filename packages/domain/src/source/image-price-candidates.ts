import type { CatalogRow } from '../contracts.js';

/** Ranking hints only. This module never selects a price, SKU membership, or image. */
export type ImagePriceCandidates = {
  candidates: { row: CatalogRow; score: number; matchedText: string }[];
  issues: string[];
  requiresConfirmation: true;
  basis: 'explicit_sku' | 'name';
};
export function normalizeProductName(value: string): string {
  return value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\b(?:cao[\s._-]+cap|moi)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export function longestContiguousMatch(a: string, b: string): { length: number; text: string } {
  const left = normalizeProductName(a).slice(0, 512),
    right = normalizeProductName(b).slice(0, 512);
  let previous = new Uint16Array(right.length + 1),
    best = 0,
    end = 0;
  for (let i = 1; i <= left.length; i++) {
    const next = new Uint16Array(right.length + 1);
    for (let j = 1; j <= right.length; j++)
      if (left[i - 1] === right[j - 1]) {
        next[j] = previous[j - 1]! + 1;
        if (next[j]! > best) {
          best = next[j]!;
          end = i;
        }
      }
    previous = next;
  }
  return { length: best, text: left.slice(end - best, end) };
}
const phrase = (text: string, value: string) => (' ' + text + ' ').includes(' ' + value + ' ');
const brandTokens = (brand: string) => (brand === 'vina tuoi' ? ['vina tuoi', 'vnt'] : [brand]);
function capacities(value: string): string[] {
  const text = value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return [
    ...new Set(
      [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|lit|l|kg|g)(?![a-z])/g)].map((m) => {
        const n = Number(m[1]!.replace(',', '.')),
          unit = m[2]!;
        return (
          n * (unit === 'lit' || unit === 'l' || unit === 'kg' ? 1000 : 1) +
          (unit === 'g' || unit === 'kg' ? 'g' : 'ml')
        );
      }),
    ),
  ];
}
function markers(value: string) {
  const raw = value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const text = normalizeProductName(value);
  const percents = [...raw.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)]
    .map((m) => String(Number(m[1]!.replace(',', '.'))))
    .sort();
  const concentration = percents.length
    ? 'percent:' + percents.join(',')
    : phrase(text, 'nguyen chat')
      ? 'pure'
      : phrase(text, 'pha loang')
        ? 'diluted'
        : null;
  const count =
    text.match(/\b(?:combo|bo|set)\s+(\d+)\b/)?.[1] ??
    text.match(/\b(\d+)\s*(?:chai|lo|hu|goi)\b/)?.[1] ??
    (/\bcap(?: 2)? chai\b/.test(text) ? '2' : null);
  const pack = count ?? (/\b(combo|bo|set|cap)\b/.test(text) ? 'unknown' : null);
  return { concentration, pack };
}
function imageFamily(text: string): string | null {
  if (phrase(text, 'nuoc lau san')) return 'floor';
  if (/\b(dung dich|xit lau|lau ban|lau bep)\b/.test(text)) return 'solution';
  if (phrase(text, 'nen thom')) return 'candle';
  if (phrase(text, 'xit thom phong may lanh')) return 'aircon';
  if (/\b(tinh dau xit|xit tinh dau|xit khu mui|xit thom|chai xit|xit phong)\b/.test(text))
    return 'spray';
  if (phrase(text, 'tinh dau')) return 'oil';
  return null;
}
function catalogIdentity(row: CatalogRow) {
  const brand = normalizeProductName(row.brand?.value ?? '');
  if (!brand) return null;
  const sizes = capacities(row.name.value);
  if (sizes.length !== 1) return null;
  let text = normalizeProductName(row.name.value)
    .replace(/\b\d+(?: \d+)?\s*(ml|lit|l|kg|g)\b/g, ' ')
    .trim();
  for (const token of brandTokens(brand))
    text = (' ' + text + ' ')
      .split(' ' + token + ' ')
      .join(' ')
      .trim();
  text = text.replace(/\s+/g, ' ');
  const patterns: [string, RegExp][] = [
    ['spray', /^tinh dau xit (.+)$/],
    ['aircon', /^xit thom phong may lanh (.+)$/],
    ['candle', /^nen thom (.+)$/],
    ['solution', /^dung dich (.+)$/],
    ['floor', /^nuoc lau san (.+)$/],
    ['oil', /^tinh dau (.+)$/],
  ];
  for (const [family, pattern] of patterns) {
    const match = text.match(pattern);
    if (match)
      return { brand, family, scent: match[1]!, capacity: sizes[0]!, ...markers(row.name.value) };
  }
  return null;
}
export function rankImagePriceCandidates(
  imageName: string,
  rows: CatalogRow[],
  options: { explicitSku?: string; trustedContext?: { listingTitle: string } } = {},
): ImagePriceCandidates {
  const base = {
    requiresConfirmation: true as const,
    basis: options.explicitSku !== undefined ? ('explicit_sku' as const) : ('name' as const),
  };
  if (options.explicitSku !== undefined) {
    const found = rows.filter((row) => row.sku.value === options.explicitSku);
    return {
      ...base,
      candidates: found.map((row) => ({ row, score: 0, matchedText: options.explicitSku! })),
      issues:
        found.length === 1
          ? []
          : [found.length ? 'EXPLICIT_SKU_AMBIGUOUS' : 'EXPLICIT_SKU_NOT_FOUND'],
    };
  }
  if (imageName.length > 4000 || rows.length > 10000)
    return { ...base, candidates: [], issues: ['NAME_MATCH_LIMIT'] };
  const stem = imageName
      .split(/[\\/]/)
      .at(-1)!
      .replace(/\.(?:png|jpe?g|webp)$/i, ''),
    text = normalizeProductName(stem),
    sizes = capacities(stem),
    declaredFamily = imageFamily(text),
    contextText = normalizeProductName(options.trustedContext?.listingTitle ?? ''),
    contextFamily = imageFamily(contextText),
    family = declaredFamily ?? contextFamily,
    specific = markers(stem);
  if (sizes.length !== 1)
    return {
      ...base,
      candidates: [],
      issues: [sizes.length ? 'IMAGE_CAPACITY_AMBIGUOUS' : 'IMAGE_CAPACITY_MISSING'],
    };
  if (!family) return { ...base, candidates: [], issues: ['IMAGE_PRODUCT_FAMILY_MISSING'] };
  if (declaredFamily && contextFamily && declaredFamily !== contextFamily)
    return { ...base, candidates: [], issues: ['IMAGE_CONTEXT_FAMILY_CONFLICT'] };
  const identities = rows.map((row) => ({ row, identity: catalogIdentity(row) }));
  const brandsIn = (name: string) => [
    ...new Set(
      identities.flatMap(({ identity }) =>
        identity && brandTokens(identity.brand).some((t) => phrase(name, t))
          ? [identity.brand]
          : [],
      ),
    ),
  ];
  const imageBrands = brandsIn(text),
    contextBrands = brandsIn(contextText);
  if (
    imageBrands.length &&
    contextBrands.length &&
    (contextBrands.length !== 1 || imageBrands.some((brand) => brand !== contextBrands[0]))
  )
    return { ...base, candidates: [], issues: ['IMAGE_CONTEXT_BRAND_CONFLICT'] };
  const brandMatches = imageBrands.length ? imageBrands : contextBrands;
  if (brandMatches.length !== 1)
    return {
      ...base,
      candidates: [],
      issues: [brandMatches.length ? 'IMAGE_BRAND_AMBIGUOUS' : 'IMAGE_BRAND_MISSING'],
    };
  const imageIdentity = catalogIdentity({
    name: { value: stem },
    brand: { value: brandMatches[0] },
  } as CatalogRow);
  // A whole scent declaration is required. A substring such as Chanh must never
  // stand in for Sả Chanh / Vỏ Chanh merely because the full scent is absent in a pricebook.
  let scent = imageIdentity?.scent;
  if (!scent && options.trustedContext && !declaredFamily) {
    // The context supplies brand/family only. A numbered role is not a scent,
    // and neither a title's scent nor its capacity may be copied into an image.
    let declaration = text
      .replace(/^(?:anh )?phan loai(?: \d+)? /, '')
      .replace(/\b\d+(?: \d+)?\s*(ml|lit|l|kg|g)\b/g, ' ');
    for (const token of brandTokens(brandMatches[0]!))
      declaration = (' ' + declaration + ' ')
        .split(' ' + token + ' ')
        .join(' ')
        .trim();
    declaration = declaration.trim().replace(/\s+/g, ' ');
    // Match across all scoped row sizes first: Sả Chanh 300ml must prevent
    // Sả Chanh 100ml from falling back to the shorter Chanh 100ml row.
    const scentPhrases = [
      ...new Set(
        identities.flatMap(({ identity }) =>
          identity && phrase(declaration, identity.scent) ? [identity.scent] : [],
        ),
      ),
    ].sort((a, b) => b.length - a.length || a.localeCompare(b));
    if (scentPhrases[0] === declaration) scent = declaration;
  }
  if (!scent) return { ...base, candidates: [], issues: ['IMAGE_SCENT_NOT_EXACT'] };
  const eligible = identities.filter(
    ({ identity }) =>
      identity?.brand === brandMatches[0] &&
      identity.family === family &&
      identity.capacity === sizes[0],
  );
  if (!eligible.some(({ identity }) => identity!.scent === scent))
    return { ...base, candidates: [], issues: ['IMAGE_SCENT_OR_CAPACITY_CONFLICT'] };
  const compatible = eligible.filter(
    ({ identity }) =>
      identity!.scent === scent &&
      identity!.concentration === specific.concentration &&
      identity!.pack === specific.pack &&
      specific.pack !== 'unknown',
  );
  if (!compatible.length)
    return { ...base, candidates: [], issues: ['IMAGE_CONCENTRATION_OR_PACK_CONFLICT'] };
  const candidates = compatible
    .map(({ row }) => {
      const m = longestContiguousMatch(stem, row.name.value);
      return { row, score: m.length, matchedText: m.text };
    })
    .sort((a, b) => b.score - a.score || a.row.key.localeCompare(b.row.key));
  const issues =
    candidates.length > 1 && candidates[0]!.score === candidates[1]!.score
      ? ['NAME_MATCH_TIE']
      : [];
  if (candidates.length > 20) issues.push('NAME_CANDIDATES_TRUNCATED');
  return { ...base, candidates: candidates.slice(0, 20), issues };
}
