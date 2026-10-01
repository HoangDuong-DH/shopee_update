import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ArchiveCloneCoordinator, documentedVideoPilotAllowed, verifyArchiveVideoAddItemDocumentation } from '../../apps/api/src/archive-clone-coordinator.js';
import { syntheticVideoDocumentation } from '../fixtures/archive-clone.js';

vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>(), readFile: vi.fn() }));
const pin = '2f66e33928a76f35bfdd71d9e16b95553da15c513794fe1c6f9b5933ab53e8d6';
beforeEach(() => { vi.mocked(readFile).mockReset().mockRejectedValue(Object.assign(Error('synthetic missing document'), { code: 'ENOENT' })); });

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
  it('keeps the production document gate closed when declarations or the pinned file are absent', async () => {
    expect(await documentedVideoPilotAllowed(undefined)).toBe(false);
    expect(await documentedVideoPilotAllowed('a'.repeat(64))).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    expect(await documentedVideoPilotAllowed(pin)).toBe(false);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(resolve(process.cwd(), 'knowledge-base/shopee-open-platform/documents/api/en/v2.product.add_item.md'));
  });
  it('keeps the production gate closed for synthetic or tampered bytes even with valid document markers', async () => {
    const fixture = syntheticVideoDocumentation();
    vi.mocked(readFile).mockResolvedValue(fixture.bytes);
    expect(fixture.sha256).not.toBe(pin);
    expect(await documentedVideoPilotAllowed(pin)).toBe(false);
  });
  it('verifies actual synthetic document bytes and their real digest through the pure predicate', () => {
    const fixture = syntheticVideoDocumentation();
    expect(verifyArchiveVideoAddItemDocumentation(fixture.bytes, fixture.sha256)).toBe(true);
    expect(verifyArchiveVideoAddItemDocumentation(fixture.bytes, pin)).toBe(false);
    expect(verifyArchiveVideoAddItemDocumentation(Buffer.concat([fixture.bytes, Buffer.from('tampered')]), fixture.sha256)).toBe(false);
  });
  it.each(['id: "api:v2.product.add_item:en"', '| video_upload_id | string[] | False |', 'Only accept one video_upload_id.'])('requires the pinned document marker %s', marker => {
    const fixture = syntheticVideoDocumentation(), changed = Buffer.from(fixture.bytes.toString('utf8').replace(marker, ''));
    expect(verifyArchiveVideoAddItemDocumentation(changed, createHash('sha256').update(changed).digest('hex'))).toBe(false);
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
