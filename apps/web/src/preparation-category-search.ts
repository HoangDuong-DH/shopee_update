export type PreparationCategory = { id: string; label: string; path: string };
const normalized = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi-VN');
/** Search current metadata only; a text filter never changes the chosen category. */
export function categorySearchResults(categories: PreparationCategory[], query: string, selectedId: string, limit = 100) {
  const terms = normalized(query).trim().split(/\s+/).filter(Boolean);
  const matches = categories.filter(category => terms.every(term => normalized(category.path + ' ' + category.label).includes(term)));
  const items = matches.slice(0, limit);
  const selected = categories.find(category => category.id === selectedId);
  if (selected && !items.some(category => category.id === selectedId)) items.unshift(selected);
  return { items, total: matches.length };
}
