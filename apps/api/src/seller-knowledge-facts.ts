import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repository } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import type { SellerKnowledgeSourceFact } from '../../../packages/domain/src/seller-knowledge.js';

const value = z
  .object({
    valueId: z.number().int().nonnegative().safe(),
    originalValueName: z.string().max(1000).optional(),
    valueUnit: z.string().max(40).optional(),
  })
  .strict();
export const confirmedFactsSchema = z
  .object({
    requestId: z.string().uuid(),
    connectionId: z.string().uuid(),
    evidenceId: z.string().uuid(),
    sourceReference: z.string().min(5).max(2000),
    facts: z
      .array(
        z
          .object({
            attributeId: z.number().int().positive().safe(),
            values: z.array(value).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export function sellerFactTargetFingerprint(target: any) {
  if (
    !target?.scope ||
    !target?.itemId ||
    !target?.categoryId ||
    target.brandId === undefined ||
    target.brandId === null
  )
    throw Error('SELLER_KNOWLEDGE_TARGET_INVALID');
  const scope = {
    environment: target.scope.environment,
    partnerId: target.scope.partnerId,
    shopId: target.scope.shopId,
  };
  const modelIdentities = (target.models ?? [])
    .map((model: any) => ({
      modelId: String(model.model_id),
      sku: model.model_sku ?? null,
      tierIndex: model.tier_index ?? null,
    }))
    .sort((a: any, b: any) => a.modelId.localeCompare(b.modelId));
  return hash({
    scope,
    itemId: String(target.itemId),
    categoryId: String(target.categoryId),
    brandId: String(target.brandId),
    modelSkus: [
      ...new Set<string>(
        target.modelSkus?.length ? target.modelSkus : target.itemSku ? [target.itemSku] : [],
      ),
    ].sort(),
    modelIdentities,
  });
}
/** User-declared product facts are local evidence, never a publication permit. */
export class SellerKnowledgeFacts {
  constructor(private readonly repo: Repository) {}
  async assertCurrentTarget(connectionId: string, itemId: string, evidenceId: string) {
    const row = (
      await this.repo.pool.query(
        'SELECT evidence_id FROM seller_knowledge_items WHERE connection_id=$1 AND item_id=$2',
        [connectionId, itemId],
      )
    ).rows[0];
    if (!row || row.evidence_id !== evidenceId) throw Error('SELLER_KNOWLEDGE_TARGET_STALE');
  }
  async save(input: z.infer<typeof confirmedFactsSchema>, target: any) {
    const parsed = confirmedFactsSchema.parse(input);
    if (target.connectionId !== parsed.connectionId || target.evidenceId !== parsed.evidenceId)
      throw Error('SELLER_KNOWLEDGE_SCOPE_MISMATCH');
    if (new Set(parsed.facts.map((f) => f.attributeId)).size !== parsed.facts.length)
      throw Error('SELLER_KNOWLEDGE_DUPLICATE_FACT');
    const targetFingerprint = sellerFactTargetFingerprint(target),
      requestFingerprint = hash({ ...parsed, targetFingerprint });
    const client = await this.repo.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query(
          'SELECT evidence_id FROM seller_knowledge_items WHERE connection_id=$1 AND item_id=$2 FOR SHARE',
          [parsed.connectionId, String(target.itemId)],
        )
      ).rows[0];
      if (!current || current.evidence_id !== parsed.evidenceId)
        throw Error('SELLER_KNOWLEDGE_TARGET_STALE');
      const result = await client.query(
        `INSERT INTO seller_knowledge_fact_receipts(id,request_id,connection_id,item_id,target_fingerprint,request_fingerprint,source_reference,facts) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(request_id) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          parsed.requestId,
          parsed.connectionId,
          String(target.itemId),
          targetFingerprint,
          requestFingerprint,
          parsed.sourceReference,
          JSON.stringify(parsed.facts),
        ],
      );
      const row =
        result.rows[0] ??
        (
          await client.query('SELECT * FROM seller_knowledge_fact_receipts WHERE request_id=$1', [
            parsed.requestId,
          ])
        ).rows[0];
      if (!row || row.request_fingerprint !== requestFingerprint)
        throw Error('SELLER_KNOWLEDGE_REQUEST_CONFLICT');
      await client.query('COMMIT');
      return {
        id: row.id,
        sourceReference: row.source_reference,
        createdAt: new Date(row.created_at).toISOString(),
        localOnly: true,
        shopMutations: 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async forTarget(connectionId: string, target: any, db: Pick<Repository['pool'], 'query'> = this.repo.pool): Promise<SellerKnowledgeSourceFact[]> {
    const rows = (
      await db.query(
        'SELECT * FROM seller_knowledge_fact_receipts WHERE connection_id=$1 AND item_id=$2 AND target_fingerprint=$3 ORDER BY created_at DESC,id DESC LIMIT 100',
        [connectionId, String(target.itemId), sellerFactTargetFingerprint(target)],
      )
    ).rows;
    const seen = new Set<number>(),
      output: SellerKnowledgeSourceFact[] = [];
    for (const row of rows)
      for (const fact of row.facts)
        if (!seen.has(fact.attributeId)) {
          seen.add(fact.attributeId);
          output.push({
            ...fact,
            sourceId: row.id,
            sourceLocator: row.source_reference,
            confirmed: true,
          });
        }
    return output;
  }
}
