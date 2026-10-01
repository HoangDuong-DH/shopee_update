import { describe, expect, it, vi } from 'vitest';
import { ArchiveCloneCoordinator, documentedVideoPilotAllowed } from '../../apps/api/src/archive-clone-coordinator.js';

const emptyDeps = () => ({
  journal: {} as any,
  readCurrentSource: vi.fn(async () => { throw Error('unexpected source read'); }),
  readTargetInventory: vi.fn(async () => { throw Error('unexpected target read'); }),
  readTargetEvidence: vi.fn(async () => { throw Error('unexpected metadata read'); }),
  readImageEvidence: vi.fn(async () => { throw Error('unexpected media read'); }),
  readConnection: vi.fn(async () => { throw Error('unexpected connection read'); }),
  readQcEvidence: vi.fn(async () => { throw Error('unexpected QC read'); }),
  makeTransport: vi.fn(() => { throw Error('unexpected transport'); }),
});
const input = () => ({
  manifest: { archiveId: 'archive', sourceShopId: '111', items: [] },
  sourceItemId: '123', sourceEvidenceId: 'evidence',
  target: { shopId: '222', connectionId: 'connection', connectionRevision: 1, media: [] },
  scope: { environment: 'production' as const, partnerId: '2010476', shopId: '222',
    connectionId: 'connection', connectionRevision: 1 },
  policyHash: 'a'.repeat(64), mode: 'pilot' as const,
  context: {} as any,
});

describe('archive clone coordinator', () => {
  it('allows only the pinned Shopee add_item document for a one-pair video pilot', async () => {
    expect(await documentedVideoPilotAllowed(undefined)).toBe(false);
    expect(await documentedVideoPilotAllowed('a'.repeat(64))).toBe(false);
    expect(await documentedVideoPilotAllowed(
      '2f66e33928a76f35bfdd71d9e16b95553da15c513794fe1c6f9b5933ab53e8d6')).toBe(true);
  });
  it('never reads or sends a pilot without an exact one-item shop permit', async () => {
    const deps = emptyDeps();
    const result = await new ArchiveCloneCoordinator(deps).executeOne(input());
    expect(result).toEqual({ kind: 'held', reasons: ['PILOT_SCOPE_REQUIRED'] });
    expect(deps.makeTransport).not.toHaveBeenCalled();
    expect(deps.readCurrentSource).not.toHaveBeenCalled();
  });
  it('does not cross shop or connection boundaries', async () => {
    const deps = emptyDeps();
    const proposal: ReturnType<typeof input> & { pilot?: { sourceItemId: string; targetShopId: string } } = input();
    proposal.pilot = { sourceItemId: '123', targetShopId: '222' };
    proposal.scope.shopId = '333';
    const result = await new ArchiveCloneCoordinator(deps).executeOne(proposal);
    expect(result.kind).toBe('held');
    expect(deps.makeTransport).not.toHaveBeenCalled();
  });
});
