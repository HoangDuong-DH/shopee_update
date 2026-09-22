import { describe, expect, it } from 'vitest';
import {
  buildManagementCorridor,
  parseManagementHandoff,
  renderManagementBrief,
} from '../../packages/agent-runtime/src/management.js';
import { fixtureScope } from '../helpers/fixtures.js';

const source = { planId: 'plan-1', revision: 2, fingerprint: 'a'.repeat(64) };

describe('model management corridor', () => {
  it('keeps ordinary investigation read-only', () => {
    const corridor = buildManagementCorridor({
      mode: 'inspect',
      scope: fixtureScope,
      authorization: 'read_only',
      source,
    });
    expect(corridor.canWriteShopee).toBe(false);
    expect(corridor.allowedCapabilities).not.toContain('execute_registered_operation');
    expect(renderManagementBrief(corridor)).toContain('canWriteShopee=false');
  });

  it('opens a production write only for an explicitly authorized registered operation', () => {
    const blocked = buildManagementCorridor({
      mode: 'publish_hidden',
      scope: { ...fixtureScope, environment: 'production' },
      authorization: 'read_only',
      source,
      operationId: 'operation-1',
      targetCount: 10,
    });
    expect(blocked.canWriteShopee).toBe(false);
    expect(blocked.blockedBy).toContain('EXPLICIT_WRITE_AUTHORIZATION_REQUIRED');

    const allowed = buildManagementCorridor({
      mode: 'publish_hidden',
      scope: { ...fixtureScope, environment: 'production' },
      authorization: 'explicit_production_write',
      source,
      operationId: 'operation-1',
      targetCount: 10,
    });
    expect(allowed.canWriteShopee).toBe(true);
    expect(allowed.requiredSequence.at(-1)).toBe('keep_listing_hidden_until_qc');
  });

  it('requires readback identity before recovery and preserves claim boundaries', () => {
    const corridor = buildManagementCorridor({
      mode: 'recover',
      scope: fixtureScope,
      authorization: 'read_only',
      source,
    });
    expect(corridor.blockedBy).toContain('RECOVERY_OPERATION_REQUIRED');
    expect(corridor.requiredSequence).toContain('read_remote_state_before_any_retry');
    expect(corridor.claimBoundary).toContain(
      'unknown_outcome_must_not_be_replayed_without_readback',
    );
  });

  it('validates a compact handoff and rejects undeclared fields', () => {
    const handoff = {
      version: 1,
      updatedAt: '2026-09-22T00:00:00.000Z',
      repository: { branch: 'main', commit: 'a2acc42' },
      objective: 'Manage prepared listings without widening write authority.',
      state: 'stable',
      authoritativeSources: [{ label: 'Source folder', location: 'local', kind: 'file' }],
      activeWork: [],
      doNotReplay: [],
      verification: [{ check: 'typecheck', result: 'passed' }],
      knownLimits: [],
      nextActions: [],
    } as const;
    expect(parseManagementHandoff(handoff).repository.commit).toBe('a2acc42');
    expect(() => parseManagementHandoff({ ...handoff, accessToken: 'secret' })).toThrow();
  });
});
