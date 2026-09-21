import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SellerKnowledgeService } from './seller-knowledge-service.js';
import { SellerKnowledgeFacts, confirmedFactsSchema } from './seller-knowledge-facts.js';
import { normalizeSellerCategory, normalizeSellerObservation } from './seller-knowledge-adapter.js';
import { recommendSellerKnowledge } from '../../../packages/domain/src/seller-knowledge.js';

const uuid = z.string().uuid();
const searchSchema = z
  .object({
    connectionId: uuid,
    categoryId: z.string().regex(/^\d+$/).optional(),
    brandId: z.string().regex(/^\d+$/).optional(),
    query: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const targetSchema = z.object({ connectionId: uuid, evidenceId: uuid }).strict();

@Controller('v1/seller-knowledge')
export class SellerKnowledgeController {
  constructor(
    @Inject(SellerKnowledgeService) readonly knowledge: SellerKnowledgeService,
    @Inject(SellerKnowledgeFacts) readonly facts: SellerKnowledgeFacts,
  ) {}
  @Get('shops') async shops() {
    return { shops: await this.knowledge.listShops() };
  }
  @Get('search') async search(@Query() raw: unknown) {
    return { listings: await this.knowledge.search(searchSchema.parse(raw)) };
  }
  @Get('evidence/:id') evidence(@Param('id') id: string) {
    return this.knowledge.getEvidence(uuid.parse(id));
  }
  @Get('syncs/:id') sync(@Param('id') id: string) {
    return this.knowledge.getSync(uuid.parse(id));
  }
  @Post('syncs') start(@Body() raw: unknown) {
    return this.knowledge.startSync(
      z
        .object({
          connectionId: uuid,
          requestId: uuid,
          maxItems: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .parse(raw),
    );
  }
  @Post('syncs/:id/resume') resume(@Param('id') id: string, @Body() raw: unknown) {
    z.object({})
      .strict()
      .parse(raw ?? {});
    return this.knowledge.resumeSync(uuid.parse(id));
  }
  private async target(connectionId: string, evidenceId: string) {
    const proof = await this.knowledge.getEvidence(evidenceId);
    if (!proof || proof.connectionId !== connectionId || proof.kind !== 'listing')
      throw Error('SELLER_KNOWLEDGE_SCOPE_MISMATCH');
    const target = {
      ...proof.body,
      connectionId,
      evidenceId: proof.id,
      scope: proof.scope,
      observedAt: proof.observedAt,
    };
    await this.facts.assertCurrentTarget(connectionId, String(target.itemId), evidenceId);
    return { raw: target, normalized: normalizeSellerObservation(target) };
  }
  @Post('recommendations') async recommendations(@Body() raw: unknown) {
    const input = targetSchema.parse(raw),
      target = await this.target(input.connectionId, input.evidenceId);
    const category = await this.knowledge.getCategory({
      connectionId: input.connectionId,
      categoryId: String(target.normalized.categoryId),
    });
    if (category.issues.length) throw Error('SELLER_KNOWLEDGE_CATEGORY_REVIEW_REQUIRED');
    const metadata = normalizeSellerCategory(category);
    const candidateQuery = {
      connectionId: input.connectionId,
      categoryId: String(target.normalized.categoryId),
      brandId: String(target.normalized.brandId),
      skus: target.normalized.modelSkus,
      excludeItemId: target.normalized.itemId,
    };
    const [candidates, candidateCoverage] = await Promise.all([
      this.knowledge.getCandidates(candidateQuery),
      this.knowledge.getCandidateCoverage(candidateQuery),
    ]);
    const observations = [],
      rejected: string[] = [];
    for (const candidate of candidates)
      try {
        observations.push(normalizeSellerObservation(candidate));
      } catch {
        rejected.push(candidate.evidenceId);
      }
    const sourceFacts = await this.facts.forTarget(input.connectionId, target.raw);
    const recommendations = recommendSellerKnowledge(
      {
        scope: target.normalized.scope,
        categoryId: target.normalized.categoryId,
        brandId: target.normalized.brandId,
        skus: target.normalized.modelSkus,
        modelCount: target.normalized.modelCount,
        skuIdentityComplete: target.normalized.skuIdentityComplete,
        currentAttributes: target.normalized.attributes,
        excludeItemId: target.normalized.itemId,
        sourceFacts,
      },
      observations,
      metadata,
      new Date(),
    );
    if (candidateCoverage.truncated) {
      recommendations.issues.push({
        code: 'CANDIDATE_COVERAGE_INCOMPLETE',
        detail:
          'Chỉ xét 100 nguồn phù hợp đầu tiên; chưa kiểm hết mâu thuẫn trong kho. Thông tin đã xác nhận cho sản phẩm được xét riêng.',
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
    await this.facts.assertCurrentTarget(
      input.connectionId,
      target.normalized.itemId,
      input.evidenceId,
    );
    const named = recommendations.suggestions.map((suggestion) => ({
      ...suggestion,
      values: suggestion.values.map((value) => ({
        ...value,
        displayName:
          metadata.attributes
            .find((a: any) => a.attributeId === suggestion.attributeId)
            ?.values.find((v: any) => v.valueId === value.valueId)?.displayName ??
          value.originalValueName ??
          String(value.valueId),
      })),
    }));
    return {
      target: target.normalized,
      recommendations: { ...recommendations, suggestions: named },
      candidateCoverage,
      metadata: {
        evidenceId: category.evidenceId,
        observedAt: category.observedAt,
        expiresAt: category.expiresAt,
        categoryId: category.categoryId,
      },
      rejectedEvidenceIds: rejected,
      sourceFacts,
      localOnly: true,
      shopMutations: 0,
    };
  }
  @Post('facts') async confirmFacts(@Body() raw: unknown) {
    const input = confirmedFactsSchema.parse(raw),
      target = await this.target(input.connectionId, input.evidenceId);
    const category = await this.knowledge.getCategory({
      connectionId: input.connectionId,
      categoryId: String(target.normalized.categoryId),
    });
    if (category.issues.length) throw Error('SELLER_KNOWLEDGE_CATEGORY_REVIEW_REQUIRED');
    const metadata = normalizeSellerCategory(category);
    const result = recommendSellerKnowledge(
      {
        scope: target.normalized.scope,
        categoryId: target.normalized.categoryId,
        brandId: target.normalized.brandId,
        skus: target.normalized.modelSkus,
        modelCount: target.normalized.modelCount,
        skuIdentityComplete: target.normalized.skuIdentityComplete,
        currentAttributes: target.normalized.attributes,
        sourceFacts: input.facts.map((f) => ({
          ...f,
          confirmed: true,
          sourceId: input.requestId,
          sourceLocator: input.sourceReference,
        })),
      },
      [],
      metadata,
      new Date(),
    );
    if (
      input.facts.some(
        (f) => !result.suggestions.some((s) => s.attributeId === f.attributeId && s.canPrefill),
      )
    )
      throw Error('SELLER_KNOWLEDGE_FACT_INVALID');
    return this.facts.save(input, target.raw);
  }
}
