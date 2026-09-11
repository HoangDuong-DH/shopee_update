import { describe, expect, it } from 'vitest';
import {
  decodeIntakeRecovery,
  hasIntakeInput,
  newIntakeDraft,
  pastedMembershipToRows,
  rowsToMembership,
} from '../../apps/web/src/intake-state.js';

describe('nontechnical listing intake', () => {
  it('creates tracking identity without treating generated defaults as operator changes', () => {
    const draft = newIntakeDraft();
    expect(draft.productKey).toMatch(/^listing-[a-f0-9-]+$/);
    expect(hasIntakeInput(draft)).toBe(false);
    expect(hasIntakeInput({ ...draft, tierCount: 0 })).toBe(true);
  });

  it('preserves literal cells, supplied order and only the supplied two-tier combinations', () => {
    const pasted = ' B \t Đen  \t300 cái\r\nA\tTrắng\t 100 cái \r\n';
    const result = pastedMembershipToRows(pasted, 2, () => 'fixture-row');
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(rowsToMembership(result.rows!, 2)).toEqual({
      membership: ' B \t Đen  \t300 cái\nA\tTrắng\t 100 cái ',
      issues: [],
    });
  });

  it('blocks hidden classification data rather than losing it when structure changes', () => {
    const rows = [{ id: 'row', sku: 'A', labels: ['Trắng', '  '] as [string, string] }];
    expect(rowsToMembership(rows, 1).issues).toHaveLength(1);
    expect(rows[0].labels).toEqual(['Trắng', '  ']);
  });

  it('rejects cell delimiters instead of turning an individual input into additional SKU rows', () => {
    for (const sku of ['A\tB', 'A\nB', 'A\rB']) {
      expect(rowsToMembership([{ id: 'row', sku, labels: ['', ''] }], 0).issues).toHaveLength(1);
    }
  });

  it('rejects pasted missing/extra columns or internal blank rows without silently dropping data', () => {
    for (const value of ['A', 'A\tTrắng\t100\textra', 'A\tTrắng\n\nB\tĐen']) {
      const result = pastedMembershipToRows(value, 1);
      expect(result.rows).toBeUndefined();
      expect(result.issues.length).toBeGreaterThan(0);
    }
    expect(rowsToMembership([{ id: 'row', sku: '', labels: ['', ''] }], 0).issues).toHaveLength(1);
  });

  it('restores only bounded known input state and retains the original tracking identity', () => {
    const draft = newIntakeDraft();
    draft.sourceId = 'source-1';
    draft.tierCount = 2;
    draft.rows[0] = { ...draft.rows[0], sku: ' A ', labels: [' Đỏ ', '100 cái'] };
    expect(decodeIntakeRecovery(JSON.stringify(draft))).toEqual(draft);
    for (const input of [
      { ...draft, accessToken: 'never-store' },
      { ...draft, version: 2 },
      { ...draft, rows: [...draft.rows, draft.rows[0]] },
      { ...draft, confirmed: true },
      {
        ...draft,
        rows: Array.from({ length: 2001 }, (_, index) => ({ ...draft.rows[0], id: String(index) })),
      },
    ])
      expect(decodeIntakeRecovery(JSON.stringify(input))).toBeUndefined();
    expect(decodeIntakeRecovery('{broken')).toBeUndefined();
    expect(decodeIntakeRecovery(JSON.stringify(newIntakeDraft()))).toBeUndefined();
  });
});
