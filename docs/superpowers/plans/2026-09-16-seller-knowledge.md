# Seller Knowledge Implementation Plan

> **For agentic workers:** Use parallel bounded agents and integration review; implementation is authorized by the user's request to build the mechanism.

**Goal:** Store reusable, evidence-backed seller observations and generate guarded attribute suggestions without repeated agent browsing or automatic Shopee writes.

**Architecture:** PostgreSQL observation journal + bounded resumable GET collector + pure deterministic recommendation engine + HTTP/UI for synchronization, retrieval and review.

**Tech Stack:** Node24.20.0, TypeScript, Nest/Fastify, PostgreSQL, React, Zod, Vitest/Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-seller-knowledge-design.md`.

## Global constraints

- Connected production scope only; dynamic shop IDs, server credentials, GET-only transport.
- Existing publication receipts/source data stay unchanged. No keyword or frequency can authorize writes.
- Vietnamese product names first. Partial, stale and conflicting results remain visible.
- Agent usage is reserved for ambiguity; ingestion, caching and retrieval require no model calls.

## Task 1 — durable collector (backend agent)

Files: `packages/persistence/migrations/026_seller_knowledge.sql`, `apps/api/src/seller-knowledge-service.ts`, isolated collector/helper modules and corresponding unit/integration tests.

Interfaces: `SellerKnowledgeService(repo, options)`: startSync({connectionId,requestId,maxItems?}), resumeSync(id), getSync(id), listShops(), search({connectionId,categoryId?,brandId?,query?,limit?}), getEvidence(id), getCategory({connectionId,categoryId,refresh?}), getCandidates({connectionId,categoryId,brandId?,skus?,excludeItemId?}). Sync identity is durable; resumed work uses saved scope/cursor; old observations are immutable.

- [x] RED: same request never starts duplicate work; page cap remains resumable; changed revision stops; failed GET does not imply empty catalog; no POST transport.
- [x] Implement migration, bounded collection and provenance, filters and cache.
- [x] GREEN: test isolation with fixture scopes and PostgreSQL, including process restart/resume.

## Task 2 — guarded recommendations (policy agent)

Files: `packages/domain/src/seller-knowledge.ts`, `tests/unit/seller-knowledge.test.ts`.

Interface: `recommendSellerKnowledge(target, observations, metadata, now)` accepts normalized scope/category/brand/SKUs, product facts with locator, attributed historical observations and fresh typed metadata. Returns suggestions, evidence IDs, source class, reasons, confidence, coverage and missing mandatory fields. `canPrefill` means local preview only.

- [x] RED: stale metadata, conflicting evidence, different shops/brands, partial SKU coverage, invalid enum/unit/count, free-text type3 and protected factual claims.
- [x] Implement deterministic bounded ranking and explicit issues; no LLM or write API.
- [x] GREEN: test source provenance and no majority-rule truth assertion.

## Task 3 — HTTP/UI integration (root + UI agent)

Files: `apps/api/src/seller-knowledge-controller.ts`, narrow imports/providers in `apps/api/src/app.ts`; `apps/web/src/SellerKnowledgePanel.tsx` mounted in `AssistantPanel.tsx`.

Routes under `/v1/seller-knowledge`: GET shops/search/evidence/:id/syncs/:id, POST syncs/syncs/:id/resume/recommendations. Root normalizes raw attribute metadata into pure engine contracts. Recommendation response never invokes publication or edits canonical source.

- [x] RED: HTTP wrong/unknown scope, invalid request, source isolation and UI loading/error/resume/name-first states.
- [x] Implement endpoints and user-readable panel with no publish buttons; errors retain context.
- [x] GREEN: integration and UI fixture tests, typecheck/build.

## Task 4 — current shop acceptance and handoff

- [x] Apply additive migration, restart idle API with existing production flags, verify local health.
- [x] Run bounded sync through HTTP for connected vuatinhdau.vn; inspect observed listings and request budget, resume if capped until requested listing inventory is accounted for.
- [x] Query carpet listing recommendations and compare source matrix; record supported candidates/missing facts without changing shop.
- [x] Independent review, broad verification plus final focused checks, operator instructions and delivery evidence. Preserve old checkpoint history and separate fixture tests from live GETs.

Acceptance evidence: [delivery](../../delivery/2026-09-16-seller-knowledge.md), [operator guide](../../operator-guides/kien-thuc-tu-listing-cua-shop.md). One production shop only: 57 current listings/839 models plus 73 deleted-status markers. Warm read: 13 GET/7.528s, 126 reused and 4 incomplete-attribute listings reread. Five user-confirmed carpet facts are local preview data only; the responsible organization's address is still unknown. Final stable checks: 93 focused tests, 5 browser fixtures and type/build. Broad baseline: 1845 unit/integration + 7 legacy; it overlapped the final search/UI edit, so it is not claimed as a final unchanged-source full run. No multi-shop live, 24-hour scheduler or automatic application to Shopee acceptance is implied.

Later frozen-source full verification completed at 2026-09-16T03:58:19.128Z: 1857/1857 unit/integration across 99 files, 7/7 legacy, 0 skip, typecheck/TS build/web build passed. It includes final KB and the additional preparation brand/authorization changes. Private archive: `.local/vina-input-preparation-20260916/orchestration/{verification-frozen-final.json,test-results-frozen-final.json,full-verify-frozen.log}`. Keep earlier partial-run evidence as history.
