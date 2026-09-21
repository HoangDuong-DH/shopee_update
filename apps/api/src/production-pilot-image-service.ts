import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { relative, sep, isAbsolute } from 'node:path';
import { canonicalJson } from '@shopee/domain';
import type { BlobStore, Repository } from '@shopee/persistence';
import { ImageQcService } from './image-qc-service.js';
import type { ProductionPilotCoverQcOptions } from './production-pilot-cover-qc.js';

/** Server-owned source and image proof lookup. No caller-provided case ID, file path or approval. */
export function productionPilotImageService(repo: Repository, blobs: BlobStore, assetRoot: string): ProductionPilotCoverQcOptions {
  const service = new ImageQcService(repo, blobs);
  const source = async (input: Parameters<ProductionPilotCoverQcOptions['findCase']>[0]) => {
    const b = input.binding;
    if (b.environment !== 'production' || b.partnerId !== '2010476' || b.shopId !== '1423724897' ||
      b.role !== 'cover' || b.position !== 0) throw Error('PRODUCTION_PILOT_COVER_SCOPE_INVALID');
    const op = (await repo.pool.query(`SELECT source_payload FROM production_pilot_operations
      WHERE id=$1 AND owner_key=$2 AND item_id=$3 AND source_fingerprint=$4 AND state IN ('acknowledged','verified')`,
    [b.operationId, 'production:2010476:1423724897', b.itemId, input.sourceFingerprint])).rows[0];
    const document = op?.source_payload?.document, assets = op?.source_payload?.assets;
    if (!document || document.cover.importId !== b.sourceAssetId || document.cover.sha256 !== input.sourceSha256 ||
      typeof assets?.[b.sourceAssetId] !== 'string') throw Error('PRODUCTION_PILOT_COVER_SOURCE_CHANGED');
    return assets[b.sourceAssetId] as string;
  };
  return {
    service,
    findCase: async (input) => {
      await source(input);
      const rows = (await repo.pool.query(`SELECT id FROM image_qc_cases
        WHERE binding=$1::jsonb AND source_sha256=$2 AND expires_at>now() ORDER BY created_at DESC,id DESC LIMIT 1`,
      [canonicalJson(input.binding), input.sourceSha256])).rows;
      return rows[0] ? { caseId: rows[0].id } : null;
    },
    captureCase: async (input) => {
      const path = await source(input), root = await realpath(assetRoot), actual = await realpath(path);
      const tail = relative(root, actual);
      if (!tail || tail === '..' || tail.startsWith('..' + sep) || isAbsolute(tail)) throw Error('PRODUCTION_PILOT_COVER_ASSET_OUTSIDE_ROOT');
      const bytes = await readFile(actual);
      if (createHash('sha256').update(bytes).digest('hex') !== input.sourceSha256) throw Error('PRODUCTION_PILOT_COVER_SOURCE_CHANGED');
      const entry = await service.prepare({ id: randomUUID(), binding: input.binding, source: bytes,
        output: input.output, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
      return { caseId: entry.id };
    },
  };
}
