import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, sourceListingIntent, type ListingDraft } from '@shopee/domain';
import type { Repository } from '@shopee/persistence';
import {
  recommendSellerKnowledge,
  type SellerKnowledgeSourceFact,
  type SellerKnowledgeScope,
} from '../../../packages/domain/src/seller-knowledge.js';
import { normalizeSellerCategory, normalizeSellerObservation } from './seller-knowledge-adapter.js';
import { SellerKnowledgeService } from './seller-knowledge-service.js';
import { SellerKnowledgeFacts } from './seller-knowledge-facts.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const uuid = z.string().uuid();
const valueSchema = z
  .object({
    valueId: z.number().int().nonnegative().safe(),
    originalValueName: z.string().min(1).max(1000).optional(),
    valueUnit: z.string().min(1).max(40).optional(),
  })
  .strict();
export const draftKnowledgeTargetSchema = z
  .object({
    productKey: z.string().min(1).max(500),
    expectedRevision: z.number().int().positive(),
    connectionId: uuid,
    categoryId: z.number().int().positive().safe(),
    brandId: z.number().int().nonnegative().safe(),
  })
  .strict();
const acceptanceSchema = draftKnowledgeTargetSchema
  .extend({
    requestId: uuid,
    recommendationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    attributeIds: z.array(z.number().int().positive().safe()).min(1).max(100),
  })
  .strict();
type Target = z.infer<typeof draftKnowledgeTargetSchema>;
type Db = Pick<Repository['pool'], 'query'>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function scopeOf(connection: any): SellerKnowledgeScope {
  return {
    environment: connection.environment,
    partnerId: connection.partner_id,
    shopId: connection.shop_id,
  };
}
function connected(connection: any, now: number) {
  if (
    !connection ||
    connection.environment !== 'production' ||
    connection.state !== 'connected' ||
    !connection.expires_at ||
    new Date(connection.expires_at).getTime() <= now
  )
    throw Error('KNOWLEDGE_DRAFT_CONNECTION_UNAVAILABLE');
}
async function currentBinding(
  db: Db,
  input: Pick<Target, 'productKey' | 'expectedRevision' | 'connectionId'>,
  now: number,
  lock = false,
) {
  const row = (
    await db.query(
      `SELECT p.latest_revision,r.body FROM products p JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision WHERE p.product_key=$1${lock ? ' FOR SHARE OF p' : ''}`,
      [input.productKey],
    )
  ).rows[0];
  if (
    !row ||
    row.latest_revision !== input.expectedRevision ||
    row.body.revision !== input.expectedRevision
  )
    throw Error('KNOWLEDGE_DRAFT_REVISION_CHANGED');
  const connection = (
    await db.query(`SELECT * FROM connections WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [
      input.connectionId,
    ])
  ).rows[0];
  connected(connection, now);
  return {
    draft: row.body as ListingDraft,
    draftFingerprint: hash(row.body),
    connectionRevision: connection.revision as number,
    scope: scopeOf(connection),
  };
}
function draftFacts(draft: ListingDraft, input: Target, now: number): SellerKnowledgeSourceFact[] {
  // An attribute number belongs to its category. A shop/history inference cannot confirm a fact.
  if (
    draft.categoryId?.value !== String(input.categoryId) ||
    draft.brandId?.value !== String(input.brandId)
  )
    return [];
  const facts: SellerKnowledgeSourceFact[] = [];
  for (const [key, fact] of Object.entries(draft.attributes)) {
    if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key)) || !fact.confirmed) continue;
    const sources = fact.sources.filter(
      (source) =>
        ['product_file', 'user_decision'].includes(source.kind) &&
        /^[a-f0-9]{64}$/.test(source.fileSha256) &&
        source.locator.trim() &&
        Number.isFinite(Date.parse(source.observedAt)) &&
        Date.parse(source.observedAt) <= now,
    );
    if (!sources.length) continue;
    const raw = Array.isArray(fact.value) ? fact.value : [fact.value];
    const parsed = z
      .array(valueSchema)
      .min(1)
      .max(50)
      .safeParse(
        raw.map((value) =>
          typeof value === 'string' && /^[1-9]\d*$/.test(value)
            ? { valueId: Number(value) }
            : value,
        ),
      );
    if (!parsed.success) continue; // Text without an explicit value ID is ambiguous; never guess one.
    facts.push({
      attributeId: Number(key),
      values: parsed.data,
      confirmed: true,
      sourceId:
        'draft:' + hash({ productKey: draft.productKey, revision: draft.revision, key, fact }),
      sourceLocator: sources.map((source) => `${source.locator} [${source.fileSha256}]`).join('; '),
    });
  }
  return facts;
}
function existingItem(draft: ListingDraft): string | undefined {
  const declared = sourceListingIntent(draft.sourceListingId?.value),
    selected = sourceListingIntent(draft.sourceSelection?.sourceListingId);
  if (declared.kind === 'invalid' || selected.kind === 'invalid' || !same(declared, selected))
    throw Error('KNOWLEDGE_DRAFT_ITEM_ID_CONFLICT');
  return declared.kind === 'update' ? declared.itemId : undefined;
}
function attributesFor(
  suggestions: Array<{ attributeId: number; values: z.infer<typeof valueSchema>[] }>,
) {
  return suggestions.map((suggestion) => ({
    attribute_id: suggestion.attributeId,
    attribute_value_list: suggestion.values.map((value) => ({
      value_id: value.valueId,
      ...(value.originalValueName === undefined
        ? {}
        : { original_value_name: value.originalValueName }),
      ...(value.valueUnit === undefined ? {} : { value_unit: value.valueUnit }),
    })),
  }));
}
const receiptView = (row: any) => ({ ...row.body, fingerprint: row.fingerprint });

/** Explicit local preview choices only. Never edits a source or grants publication capability. */
export class SellerKnowledgeDraftService {
  private readonly now: () => number;
  constructor(
    private readonly repo: Repository,
    private readonly knowledge: SellerKnowledgeService,
    private readonly facts: SellerKnowledgeFacts,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async recommend(raw: unknown) {
    const input = draftKnowledgeTargetSchema.parse(raw),
      binding = await currentBinding(this.repo.pool, input, this.now());
    const category = await this.knowledge.getCategory({
      connectionId: input.connectionId,
      categoryId: input.categoryId,
    });
    if (
      !same(
        scopeOf({
          environment: category.scope.environment,
          partner_id: category.scope.partnerId,
          shop_id: category.scope.shopId,
        }),
        binding.scope,
      ) ||
      category.scope.connectionRevision !== binding.connectionRevision ||
      String(category.categoryId) !== String(input.categoryId)
    )
      throw Error('KNOWLEDGE_DRAFT_METADATA_SCOPE_CHANGED');
    if (category.issues.length) throw Error('KNOWLEDGE_DRAFT_METADATA_REVIEW_REQUIRED');
    const metadata = normalizeSellerCategory(category),
      now = this.now();
    if (
      Date.parse(metadata.observedAt) > now ||
      Math.min(Date.parse(metadata.observedAt) + 900000, Date.parse(category.expiresAt)) <= now
    )
      throw Error('KNOWLEDGE_DRAFT_METADATA_EXPIRED');
    const skus = binding.draft.variants.map((variant) => variant.sku.value),
      skuIdentityComplete =
        skus.length > 0 &&
        skus.every((sku) => typeof sku === 'string' && sku.trim()) &&
        new Set(skus).size === skus.length;
    const sourceFacts = draftFacts(binding.draft, input, now),
      itemId = existingItem(binding.draft);
    let existingEvidenceId: string | undefined, existingFactsFingerprint: string | undefined;
    if (itemId && skuIdentityComplete) {
      const pointer = (
        await this.repo.pool.query(
          'SELECT evidence_id FROM seller_knowledge_items WHERE connection_id=$1 AND item_id=$2',
          [input.connectionId, itemId],
        )
      ).rows[0];
      if (pointer) {
        const proof = await this.knowledge.getEvidence(pointer.evidence_id);
        if (proof && proof.connectionId === input.connectionId && proof.kind === 'listing') {
          const rawTarget = {
            ...proof.body,
            connectionId: input.connectionId,
            evidenceId: proof.id,
            scope: proof.scope,
            observedAt: proof.observedAt,
          };
          try {
            const observed = normalizeSellerObservation(rawTarget);
            if (
              same(observed.scope, binding.scope) &&
              observed.categoryId === input.categoryId &&
              observed.brandId === input.brandId &&
              observed.skuIdentityComplete &&
              same([...observed.modelSkus].sort(), [...skus].sort()) &&
              Math.max(1, observed.modelCount) === skus.length
            ) {
              const existingFacts = await this.facts.forTarget(input.connectionId, rawTarget);
              sourceFacts.push(...existingFacts);
              existingFactsFingerprint = hash(existingFacts);
              existingEvidenceId = proof.id;
            }
          } catch {
            /* An incomplete observation is not a transferable product fact. */
          }
        }
      }
    }
    const query = {
      connectionId: input.connectionId,
      categoryId: input.categoryId,
      brandId: input.brandId,
      skus,
      ...(itemId ? { excludeItemId: itemId } : {}),
    };
    const [candidates, candidateCoverage] = await Promise.all([
      this.knowledge.getCandidates(query),
      this.knowledge.getCandidateCoverage(query),
    ]);
    const observations = [],
      rejectedEvidenceIds: string[] = [];
    for (const candidate of candidates) {
      try {
        observations.push(normalizeSellerObservation(candidate));
      } catch {
        rejectedEvidenceIds.push(candidate.evidenceId);
      }
    }
    const recommendations = recommendSellerKnowledge(
      {
        scope: binding.scope,
        categoryId: input.categoryId,
        brandId: input.brandId,
        skus,
        skuIdentityComplete,
        modelCount: skus.length,
        sourceFacts,
        ...(itemId ? { excludeItemId: itemId } : {}),
      },
      observations,
      metadata,
      new Date(now),
    );
    if (candidateCoverage.truncated) {
      recommendations.issues.push({
        code: 'CANDIDATE_COVERAGE_INCOMPLETE',
        detail: 'Chưa kiểm hết nguồn lịch sử; chỉ thông tin sản phẩm đã xác nhận mới có thể chọn.',
      });
      for (const suggestion of recommendations.suggestions)
        if (suggestion.sourceClass !== 'product_source') {
          suggestion.alternatives ??= [
            { values: suggestion.values, evidenceIds: suggestion.evidenceIds },
          ];
          suggestion.values = [];
          suggestion.canPrefill = false;
          suggestion.confidence = 'blocked';
          suggestion.reasons.push('CANDIDATE_COVERAGE_INCOMPLETE');
        }
    }
    const current = await currentBinding(this.repo.pool, input, this.now());
    if (
      current.draftFingerprint !== binding.draftFingerprint ||
      current.connectionRevision !== binding.connectionRevision ||
      !same(current.scope, binding.scope)
    )
      throw Error('KNOWLEDGE_DRAFT_BINDING_CHANGED');
    if (existingEvidenceId)
      await this.facts.assertCurrentTarget(input.connectionId, itemId!, existingEvidenceId);
    const body = {
      target: {
        ...input,
        draftFingerprint: binding.draftFingerprint,
        connectionRevision: binding.connectionRevision,
        scope: binding.scope,
        title: binding.draft.title.value,
        ...(existingEvidenceId
          ? { existingEvidenceId, existingItemId: itemId, existingFactsFingerprint }
          : {}),
      },
      recommendations: {
        ...recommendations,
        suggestions: recommendations.suggestions.map((suggestion) => ({
          ...suggestion,
          values: suggestion.values.map((value) => ({
            ...value,
            displayName:
              metadata.attributes
                .find((attribute) => attribute.attributeId === suggestion.attributeId)
                ?.values.find((entry: any) => entry.valueId === value.valueId)?.displayName ??
              value.originalValueName ??
              String(value.valueId),
          })),
        })),
      },
      metadata: {
        evidenceId: category.evidenceId,
        categoryId: category.categoryId,
        observedAt: category.observedAt,
        expiresAt: category.expiresAt,
        evidenceRefs: category.evidenceRefs,
      },
      sourceFacts,
      candidateCoverage,
      rejectedEvidenceIds,
      localOnly: true as const,
      shopMutations: 0 as const,
    };
    return { ...body, fingerprint: hash(body) };
  }

  async accept(raw: unknown) {
    const input = acceptanceSchema.parse(raw),
      requestHash = hash(input);
    if (new Set(input.attributeIds).size !== input.attributeIds.length)
      throw Error('KNOWLEDGE_DRAFT_DUPLICATE_SELECTION');
    const prior = (
      await this.repo.pool.query(
        'SELECT * FROM seller_knowledge_draft_acceptances WHERE request_id=$1',
        [input.requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw Error('KNOWLEDGE_DRAFT_REQUEST_CONFLICT');
      return receiptView(prior);
    }
    const result = await this.recommend(
      draftKnowledgeTargetSchema.parse({
        productKey: input.productKey,
        expectedRevision: input.expectedRevision,
        connectionId: input.connectionId,
        categoryId: input.categoryId,
        brandId: input.brandId,
      }),
    );
    if (result.fingerprint !== input.recommendationFingerprint)
      throw Error('KNOWLEDGE_DRAFT_RECOMMENDATION_CHANGED');
    const selected = input.attributeIds.map((id) =>
      result.recommendations.suggestions.find((suggestion) => suggestion.attributeId === id),
    );
    if (
      selected.some(
        (suggestion) => !suggestion?.canPrefill || suggestion.sourceClass !== 'product_source',
      )
    )
      throw Error('KNOWLEDGE_DRAFT_SELECTION_NOT_CONFIRMED');
    const body = {
      version: 1,
      id: randomUUID(),
      requestId: input.requestId,
      target: result.target,
      recommendationFingerprint: result.fingerprint,
      metadata: result.metadata,
      selectedSuggestions: selected,
      sourceFacts: result.sourceFacts,
      attributeList: attributesFor(selected as NonNullable<(typeof selected)[number]>[]),
      acceptedAt: new Date(this.now()).toISOString(),
      localOnly: true,
      shopMutations: 0,
    };
    const client = await this.repo.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await currentBinding(client, input, this.now(), true);
      if (
        current.draftFingerprint !== result.target.draftFingerprint ||
        current.connectionRevision !== result.target.connectionRevision ||
        !same(current.scope, result.target.scope)
      )
        throw Error('KNOWLEDGE_DRAFT_BINDING_CHANGED');
      await assertReceiptMetadata(client, body, this.now(), this.facts, true);
      const inserted = (
        await client.query(
          'INSERT INTO seller_knowledge_draft_acceptances(id,request_id,request_hash,product_key,source_revision,connection_id,body,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_id) DO NOTHING RETURNING *',
          [
            body.id,
            input.requestId,
            requestHash,
            input.productKey,
            input.expectedRevision,
            input.connectionId,
            body,
            hash(body),
          ],
        )
      ).rows[0];
      const row =
        inserted ??
        (
          await client.query(
            'SELECT * FROM seller_knowledge_draft_acceptances WHERE request_id=$1',
            [input.requestId],
          )
        ).rows[0];
      if (row.request_hash !== requestHash) throw Error('KNOWLEDGE_DRAFT_REQUEST_CONFLICT');
      await client.query('COMMIT');
      return receiptView(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function assertReceiptMetadata(
  db: Db,
  receipt: any,
  now: number,
  facts: SellerKnowledgeFacts,
  lock = false,
) {
  if (
    Date.parse(receipt.metadata.expiresAt) <= now ||
    Date.parse(receipt.metadata.observedAt) + 900000 <= now
  )
    throw Error('KNOWLEDGE_DRAFT_METADATA_EXPIRED');
  const row = (
    await db.query(
      `SELECT k.evidence_id,k.connection_revision,k.expires_at,o.body FROM seller_knowledge_categories k JOIN seller_knowledge_observations o ON o.id=k.evidence_id WHERE k.connection_id=$1 AND k.category_id=$2${lock ? ' FOR SHARE OF k' : ''}`,
      [receipt.target.connectionId, String(receipt.target.categoryId)],
    )
  ).rows[0];
  if (
    !row ||
    row.evidence_id !== receipt.metadata.evidenceId ||
    row.connection_revision !== receipt.target.connectionRevision ||
    new Date(row.expires_at).getTime() <= now ||
    row.body.issues?.length
  )
    throw Error('KNOWLEDGE_DRAFT_METADATA_CHANGED');
  const normalized = normalizeSellerCategory(row.body);
  const selectedIds = new Set(receipt.attributeList.map((entry: any) => entry.attribute_id));
  const result = recommendSellerKnowledge(
    {
      scope: receipt.target.scope,
      categoryId: receipt.target.categoryId,
      brandId: receipt.target.brandId,
      sourceFacts: receipt.sourceFacts.filter((fact: SellerKnowledgeSourceFact) =>
        selectedIds.has(fact.attributeId),
      ),
    },
    [],
    normalized,
    new Date(now),
  );
  for (const accepted of receipt.attributeList) {
    const suggestion = result.suggestions.find(
      (entry) =>
        entry.attributeId === accepted.attribute_id &&
        entry.canPrefill &&
        entry.sourceClass === 'product_source',
    );
    if (!suggestion || !same(attributesFor([suggestion])[0], accepted))
      throw Error('KNOWLEDGE_DRAFT_SCHEMA_CHANGED');
  }
  if (receipt.target.existingEvidenceId) {
    const pointer = (
      await db.query(
        `SELECT i.evidence_id,o.body,o.scope FROM seller_knowledge_items i JOIN seller_knowledge_observations o ON o.id=i.evidence_id WHERE i.connection_id=$1 AND i.item_id=$2${lock ? ' FOR UPDATE OF i' : ''}`,
        [receipt.target.connectionId, receipt.target.existingItemId],
      )
    ).rows[0];
    if (pointer?.evidence_id !== receipt.target.existingEvidenceId)
      throw Error('KNOWLEDGE_DRAFT_ITEM_EVIDENCE_CHANGED');
    const currentFacts = await facts.forTarget(
      receipt.target.connectionId,
      { ...pointer.body, scope: pointer.scope },
      db,
    );
    if (hash(currentFacts) !== receipt.target.existingFactsFingerprint)
      throw Error('KNOWLEDGE_DRAFT_FACTS_CHANGED');
  }
}

/** Revalidated while making a local preparation; the writer still runs its full live preflight. */
export async function validateDraftKnowledgeAcceptance(
  repo: Repository,
  input: {
    receiptId: string;
    productKey: string;
    expectedRevision: number;
    categoryId: string;
    brandId: string;
    scope?: SellerKnowledgeScope;
    attributeList: unknown[];
  },
  options: { now?: () => number } = {},
) {
  const row = (
    await repo.pool.query('SELECT * FROM seller_knowledge_draft_acceptances WHERE id=$1', [
      uuid.parse(input.receiptId),
    ])
  ).rows[0];
  if (!row || hash(row.body) !== row.fingerprint)
    throw Error('KNOWLEDGE_DRAFT_ACCEPTANCE_NOT_FOUND');
  const receipt = row.body,
    now = (options.now ?? Date.now)();
  if (
    receipt.target.productKey !== input.productKey ||
    receipt.target.expectedRevision !== input.expectedRevision
  )
    throw Error('KNOWLEDGE_DRAFT_REVISION_CHANGED');
  if (
    String(receipt.target.categoryId) !== input.categoryId ||
    String(receipt.target.brandId) !== input.brandId ||
    (input.scope && !same(receipt.target.scope, input.scope))
  )
    throw Error('KNOWLEDGE_DRAFT_SCOPE_CHANGED');
  const current = await currentBinding(repo.pool, receipt.target, now);
  if (current.draftFingerprint !== receipt.target.draftFingerprint)
    throw Error('KNOWLEDGE_DRAFT_REVISION_CHANGED');
  if (
    current.connectionRevision !== receipt.target.connectionRevision ||
    !same(current.scope, receipt.target.scope)
  )
    throw Error('KNOWLEDGE_DRAFT_CONNECTION_CHANGED');
  const submitted = z
    .array(
      z
        .object({
          attribute_id: z.number().int().positive(),
          attribute_value_list: z
            .array(
              z
                .object({
                  value_id: z.number().int().nonnegative(),
                  original_value_name: z.string().optional(),
                  value_unit: z.string().optional(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    )
    .parse(input.attributeList);
  for (const accepted of receipt.attributeList)
    if (
      submitted.filter((entry) => entry.attribute_id === accepted.attribute_id).length !== 1 ||
      !same(
        submitted.find((entry) => entry.attribute_id === accepted.attribute_id),
        accepted,
      )
    )
      throw Error('KNOWLEDGE_DRAFT_VALUES_CHANGED');
  await assertReceiptMetadata(repo.pool, receipt, now, new SellerKnowledgeFacts(repo));
  return receiptView(row);
}
