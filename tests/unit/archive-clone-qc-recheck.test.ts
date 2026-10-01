import { describe, expect, it, vi } from 'vitest';
import { ArchiveCloneQcRechecker } from '../../apps/api/src/archive-clone-qc-recheck.js';

const proposal = () => ({
  manifest: { archiveId: 'archive', sourceShopId: 'source', items: [
    { sourceItemId: '123', observationHash: 'hash', media: [] },
  ] },
  sourceItemId: '123', sourceEvidenceId: 'evidence', policyHash: 'a'.repeat(64),
  target: { shopId: '456', connectionId: 'conn', connectionRevision: 2 },
  scope: { shopId: '456', partnerId: 'partner', connectionId: 'conn', connectionRevision: 2 },
  mode: 'pilot', pilot: { sourceItemId: '123', targetShopId: '456' }, context: {},
}) as any;
const prior = () => ({ intent: { state: 'held', target_item_id: '789', archive_id: 'archive',
  source_item_id: '123', source_evidence_id: 'evidence', policy_hash: 'a'.repeat(64),
  target_connection_id: 'conn', target_connection_revision: 2,
  target_partner_id: 'partner', target_shop_id: '456' }, qc: { result: 'mismatch' } });
const evidence = () => ({ manifest: proposal().manifest, sourceItemId: '123',
  sourceObservationHash: 'hash', targetShopId: '456',
  readbacks: [0, 1].map(() => ({ shopId: '456', observedAt: new Date().toISOString(),
    item: { item_id: '789' } })) });

describe('append-only archive clone QC recheck', () => {
  it('blocks cross-shop scope before any reader or mutation', async () => {
    const journal = { get: vi.fn(), recordQcRecheck: vi.fn() };
    const readQcEvidence = vi.fn();
    const input = proposal(); input.scope.shopId = 'other';
    const result = await new ArchiveCloneQcRechecker({ journal, readQcEvidence } as any)
      .recheckOne(input, 'intent', '789');
    expect(result).toEqual({ kind: 'held', reasons: ['QC_RECHECK_SCOPE_INVALID'], targetItemId: '789' });
    expect(journal.get).not.toHaveBeenCalled();
    expect(readQcEvidence).not.toHaveBeenCalled();
  });
  it('requires exact held intent and original mismatching QC', async () => {
    const old = prior(); old.intent.target_shop_id = 'other';
    const journal = { get: vi.fn(async () => old), recordQcRecheck: vi.fn() };
    const readQcEvidence = vi.fn();
    const result = await new ArchiveCloneQcRechecker({ journal, readQcEvidence } as any)
      .recheckOne(proposal(), 'intent', '789');
    expect(result.kind).toBe('held');
    expect(readQcEvidence).not.toHaveBeenCalled();
    expect(journal.recordQcRecheck).not.toHaveBeenCalled();
  });
  it('gets two fresh reads and appends only through journal', async () => {
    const journal = { get: vi.fn(async () => prior()),
      recordQcRecheck: vi.fn(async () => ({ result: 'verified' })) };
    const readImageEvidence = vi.fn(async () => ({ complete: true, shopId: '456',
      connectionRevision: 2, observedAt: new Date().toISOString() }));
    const readQcEvidence = vi.fn(async () => evidence());
    const result = await new ArchiveCloneQcRechecker({ journal, readImageEvidence,
      readQcEvidence } as any).recheckOne(proposal(), 'intent', '789');
    expect(result).toEqual({ kind: 'verified', targetItemId: '789', intentId: 'intent' });
    expect(readQcEvidence).toHaveBeenCalledTimes(1);
    expect(journal.recordQcRecheck).toHaveBeenCalledWith('intent',
      expect.objectContaining({ targetItemId: '789', evidence: expect.objectContaining({ readbacks: expect.arrayContaining([expect.anything()]) }) }));
  });
});
