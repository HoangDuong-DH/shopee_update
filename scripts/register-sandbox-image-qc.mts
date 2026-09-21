import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, Repository, BlobStore } from '../packages/persistence/src/index.js';
import { ImageQcService } from '../apps/api/src/image-qc-service.js';
import { fetchObservedShopeeImage } from '../packages/shopee/src/image-qc.js';
const folder = '.local/acceptance-20260914/variation-qc/image-cases';
await mkdir(folder, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const service = new ImageQcService(
    new Repository(pool),
    new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
  );
  for (const name of ['gallery-portrait', 'cover-restore']) {
    const path = join(folder, name + '.json');
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      console.log(JSON.stringify({ case: name, existing: true }));
      continue;
    }
    const root = join('.local/acceptance-20260914/patch-matrix/live', name);
    const identity = JSON.parse(await readFile(join(root, 'cover-identity.json'), 'utf8'));
    const before = identity.images.find((x: any) => x.name === 'before'),
      after = identity.images.find((x: any) => x.name === 'after');
    if (identity.itemId !== '803935036' || !before || !after)
      throw new Error('TECHNICAL_IMAGE_IDENTITY_REQUIRED');
    const historical = (await service.list()).find(
      (r) => r.binding.operationId === identity.operationId,
    );
    if (historical) {
      if (
        historical.comparison.state !== 'mismatch' ||
        historical.comparison.evidence?.source.decodedSha256 !== before.pixelSha256 ||
        historical.comparison.evidence?.output.decodedSha256 !== after.pixelSha256
      )
        throw new Error('HISTORICAL_CASE_REQUIRES_INSPECTION');
      await writeFile(
        path,
        JSON.stringify(
          {
            ...historical,
            referenceKind: 'Lossless decoded PNG reference; no fresh byte attestation',
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      console.log(
        JSON.stringify({
          case: name,
          id: historical.id,
          state: historical.state,
          referenceKind: 'decoded-png',
        }),
      );
      continue;
    }
    const observedUrls = [before.url, after.url];
    const source = await fetchObservedShopeeImage({ url: before.url, observedUrls }),
      output = await fetchObservedShopeeImage({ url: after.url, observedUrls });
    if (
      source.state !== 'fetched' ||
      output.state !== 'fetched' ||
      source.sha256 !== before.sha256 ||
      output.sha256 !== after.sha256
    )
      throw new Error('OBSERVED_IMAGE_BYTES_CHANGED');
    const input = {
      id: randomUUID(),
      binding: {
        environment: 'sandbox' as const,
        partnerId: '1232297',
        shopId: '227418363',
        itemId: '803935036',
        operationId: identity.operationId,
        role: 'cover' as const,
        position: 0,
        sourceAssetId: before.imageId,
        outputImageId: after.imageId,
      },
      source: source.bytes,
      output: output.bytes,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const result = await service.prepare(input);
    if (result.sourceSha256 !== before.sha256 || result.outputSha256 !== after.sha256)
      throw new Error('SAVED_IMAGE_HASH_CHANGED');
    await writeFile(path, JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(
      JSON.stringify({
        case: name,
        id: result.id,
        state: result.state,
        reason: result.comparison.reason,
      }),
    );
  }
} finally {
  await pool.end();
}
