import { describe, expect, it } from 'vitest';
import {
  buildArchiveCopyPreparationUrl,
  readArchiveCopyPreparationIntent,
  resolveArchiveCopyTargets,
  applyArchiveCopyTargets,
} from '../../apps/web/src/archive-copy-selection.js';
const target = {
  id: 'connection-destination',
  scope: { environment: 'production', partnerId: '44', shopId: '202' },
};
const source = { environment: 'production', partnerId: '44', shopId: '101' };
const saved = [{ partnerId: '55', shopId: '303', displayName: 'Saved target' }];
describe('archive copy preparation selection', () => {
  it('transfers identity only and preserves explicit destination scope across reload', () => {
    const shopWithPrivateData = {
      ...target,
      accessToken: 'must-not-transfer',
      officialName: 'Destination',
    };
    const url = buildArchiveCopyPreparationUrl([shopWithPrivateData]);
    expect(url).not.toContain('must-not-transfer');
    expect(url).not.toContain('officialName');
    expect(new URL(url, 'https://local.invalid').searchParams.get('page')).toBe('archives');
    expect(readArchiveCopyPreparationIntent(new URL(url, 'https://local.invalid').search)).toEqual({
      explicit: true,
      targets: [
        {
          connectionId: 'connection-destination',
          environment: 'production',
          partnerId: '44',
          shopId: '202',
        },
      ],
      error: null,
    });
  });
  it('keeps malformed explicit intent held instead of falling back', () => {
    expect(readArchiveCopyPreparationIntent('?copyTargets=broken')).toMatchObject({
      explicit: true,
      targets: [],
      error: expect.any(String),
    });
    expect(readArchiveCopyPreparationIntent('')).toEqual({
      explicit: false,
      targets: [],
      error: null,
    });
  });
  it('holds missing connections and changed scopes instead of choosing a replacement', () => {
    const intent = [{ connectionId: target.id, ...target.scope }];
    expect(
      resolveArchiveCopyTargets(intent, [{ ...target, id: 'replacement' }], source)[0]?.reason,
    ).toBe('CONNECTION_MISSING');
    expect(
      resolveArchiveCopyTargets(
        intent,
        [{ ...target, scope: { ...target.scope, partnerId: '999' } }],
        source,
      )[0]?.reason,
    ).toBe('CONNECTION_SCOPE_CHANGED');
  });
  it('holds sandbox and the same physical source shop under another partner', () => {
    const sandbox = { ...target, scope: { ...target.scope, environment: 'sandbox' } };
    expect(
      resolveArchiveCopyTargets(
        [{ connectionId: target.id, ...sandbox.scope }],
        [sandbox],
        source,
      )[0]?.reason,
    ).toBe('SANDBOX_UNSUPPORTED');
    const sameSource = { ...target, scope: { ...target.scope, partnerId: '55', shopId: '101' } };
    expect(
      resolveArchiveCopyTargets(
        [{ connectionId: target.id, ...sameSource.scope }],
        [sameSource],
        source,
      )[0]?.reason,
    ).toBe('SOURCE_IS_TARGET');
  });
  it('supports arbitrary targets and only merges or replaces on explicit choice', () => {
    const resolved = resolveArchiveCopyTargets(
      [{ connectionId: target.id, ...target.scope }],
      [{ ...target, displayName: 'Chosen target' }],
      source,
    );
    expect(resolved[0]?.reason).toBeNull();
    expect(applyArchiveCopyTargets(saved, resolved, 'replace')).toEqual([
      { partnerId: '44', shopId: '202', displayName: 'Chosen target' },
    ]);
    expect(applyArchiveCopyTargets(saved, resolved, 'merge')).toEqual([
      { partnerId: '55', shopId: '303', displayName: 'Saved target' },
      { partnerId: '44', shopId: '202', displayName: 'Chosen target' },
    ]);
    expect(saved).toEqual([{ partnerId: '55', shopId: '303', displayName: 'Saved target' }]);
  });
  it('does not drop a held target or exceed the backend plan limit', () => {
    const resolved = resolveArchiveCopyTargets(
      [{ connectionId: target.id, ...target.scope }],
      [],
      source,
    );
    expect(() => applyArchiveCopyTargets(saved, resolved, 'replace')).toThrow('COPY_TARGETS_HELD');
    const many = Array.from({ length: 31 }, (_, index) => ({
      intent: {
        connectionId: String(index),
        environment: 'production',
        partnerId: '44',
        shopId: String(index + 1),
      },
      target: { partnerId: '44', shopId: String(index + 1) },
      reason: null,
    }));
    expect(() => applyArchiveCopyTargets([], many, 'replace')).toThrow('COPY_TARGET_LIMIT');
  });
});
