import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { canonicalJson } from '@shopee/domain';
import { assertProductionBatchMappingProof } from '../../apps/api/src/production-batch-provenance.js';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function fixture() {
  const id = '83c41660-8b4d-4c7a-8d70-1fabf100b123';
  const body = { publicationMode: 'hidden_for_review', imageQcPolicy: 'required', entries: [] };
  const fingerprint = digest(body);
  const loaded: any = {
    sha256: 'a'.repeat(64),
    value: {
      version: 2,
      batchId: '1b2a75f6-f621-48b9-b4fa-09af61b9aa67',
      preparation: { id, fingerprint },
      authorizationReference: `operator-preparation:${id}:${fingerprint}`,
      publicationMode: 'hidden_for_review',
      imageQcPolicy: 'required',
      listings: [],
      sourceFiles: [],
    },
  };
  const row = {
    body,
    fingerprint,
    approved_at: new Date(),
    registration: { batches: [{ batchId: loaded.value.batchId, manifestSha256: loaded.sha256 }] },
  };
  const query = vi.fn(async () => ({ rows: [row] }));
  return { loaded, row, query, repo: { pool: { query } } as any };
}

it('rejects a legacy batch before any Shopee or database access', async () => {
  const f = fixture();
  f.loaded.value.version = 1;
  await expect(assertProductionBatchMappingProof(f.loaded, [], f.repo, {} as any))
    .rejects.toThrow('PRODUCTION_SOURCE_MAPPING_PROOF_REQUIRED');
  expect(f.query).not.toHaveBeenCalled();
});

it.each(['publication', 'image-qc', 'registration', 'authorization'] as const)(
  'blocks a batch whose %s differs from its approved preparation', async (change) => {
    const f = fixture();
    if (change === 'publication') f.loaded.value.publicationMode = 'publish_after_verification';
    if (change === 'image-qc') f.loaded.value.imageQcPolicy = 'defer_image_qc';
    if (change === 'registration') f.row.registration.batches[0]!.manifestSha256 = 'b'.repeat(64);
    if (change === 'authorization') f.loaded.value.authorizationReference = 'unrelated';
    await expect(assertProductionBatchMappingProof(f.loaded, [], f.repo, {} as any))
      .rejects.toThrow('PRODUCTION_SOURCE_MAPPING_PROOF_REQUIRED');
    expect(f.query).toHaveBeenCalledTimes(1);
  },
);

it('accepts the immutable preparation receipt before checking the selected listing source', async () => {
  const f = fixture();
  await expect(assertProductionBatchMappingProof(f.loaded, [], f.repo, {} as any)).resolves.toBeUndefined();
  expect(f.query).toHaveBeenCalledTimes(1);
});
