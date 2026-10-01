import { describe, expect, it } from 'vitest';
import {
  assessArchiveTargetPreflight,
  type ArchiveTargetPreflightInput,
  type Observation,
} from '../../apps/api/src/archive-target-preflight.js';

const now = '2026-09-30T07:00:00.000Z';
function fixture(): ArchiveTargetPreflightInput {
  const observation = <T>(value: T): Observation<T> => ({
    shopId: '200',
    revision: 3,
    observedAt: now,
    value,
  });
  return {
    now,
    source: {
      shopId: '100',
      itemId: '35',
      categoryPath: ['Home', 'Cleaners'],
      brandName: 'Sample Brand',
      itemSku: '',
      modelSkus: ['SKU-1', 'SKU-2'],
      sourceContractRef: 'archive-sha256:abc',
    },
    target: {
      shopId: '200',
      connection: { state: 'connected', revision: 3, expiresAt: '2026-09-30T08:00:00.000Z' },
      proposal: {
        categoryId: '90',
        brandId: '7',
        attributes: [],
        logisticIds: ['2'],
        mappingConfirmationRef: 'confirmed-target-map:abc',
      },
      shop: observation({ shopId: '200', status: 'NORMAL' }),
      categories: observation({
        complete: true,
        rows: [{ id: '90', path: ['Home', 'Cleaners'], leaf: true }],
      }),
      brands: observation({
        categoryId: '90',
        complete: true,
        rows: [{ id: '7', name: 'Sample Brand' }],
      }),
      attributeTree: observation({ categoryId: '90', tree: [] }),
      logistics: observation({
        complete: true,
        rows: [
          {
            id: '2',
            enabled: true,
            compulsory: true,
            relationsKnown: true,
            relatedEnabledIds: [],
            blockedWithIds: [],
          },
        ],
      }),
      inventory: observation({
        complete: true,
        statuses: ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING'],
        rows: [],
      }),
    },
  };
}
const codes = (input: ArchiveTargetPreflightInput) =>
  assessArchiveTargetPreflight(input).blockers.map((blocker) => blocker.code);

describe('archive target preflight', () => {
  it('accepts only complete, fresh, shop-scoped evidence for the writer preflight', () => {
    const result = assessArchiveTargetPreflight(fixture());
    expect(result.readyForWriterPreflight).toBe(true);
    expect(result.blockers).toEqual([]);
  });
  it('blocks a disconnected target even if old observations appear complete', () => {
    const input = fixture();
    input.target.connection.state = 'disconnected';
    expect(codes(input)).toContain('TARGET_DISCONNECTED');
    expect(assessArchiveTargetPreflight(input).readyForWriterPreflight).toBe(false);
  });
  it('checks category path, brand name, mandatory attributes and logistics dynamically', () => {
    const input = fixture();
    input.target.categories!.value.rows[0]!.path = ['Home', 'Other'];
    input.target.brands!.value.rows[0]!.name = 'Another Brand';
    input.target.attributeTree!.value.tree = [
      {
        attribute_id: 12,
        mandatory: true,
        attribute_info: { input_type: 1, input_validation_type: 0, format_type: 1 },
        attribute_value_list: [{ value_id: 5, name: 'Cotton' }],
      },
    ];
    input.target.proposal.logisticIds = [];
    const result = codes(input);
    expect(result).toContain('CATEGORY_UNRESOLVED');
    expect(result).toContain('BRAND_UNRESOLVED');
    expect(result).toContain('ATTRIBUTE_MANDATORY_ATTRIBUTE_MISSING');
    expect(result).toContain('LOGISTICS_COMPULSORY_MISSING');
  });
  it('requires a full target inventory scan including model SKUs and rejects stale evidence', () => {
    const input = fixture();
    input.target.inventory!.value.rows.push({ itemId: '77', itemSku: '', modelSkus: ['SKU-2'] });
    input.target.inventory!.value.statuses = ['NORMAL', 'UNLIST'];
    input.target.brands!.observedAt = '2026-09-30T06:30:00.000Z';
    const result = codes(input);
    expect(result).toContain('SKU_EXISTS');
    expect(result).toContain('INVENTORY_INCOMPLETE');
    expect(result).toContain('EVIDENCE_STALE_OR_WRONG_SHOP');
  });
  it('does not infer source contracts or target mapping confirmation', () => {
    const input = fixture();
    input.source.sourceContractRef = null;
    input.target.proposal.mappingConfirmationRef = null;
    expect(codes(input)).toEqual(
      expect.arrayContaining(['SOURCE_CONTRACT_REQUIRED', 'MAPPING_CONFIRMATION_REQUIRED']),
    );
  });
});
