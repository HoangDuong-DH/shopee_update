# Current project handoff

Updated: 2026-10-01

## ListingStudio integration

The current operating fixes and the internal upgrade have been combined in `codex/product-integration`, based on review commit `0eebc2a`. The final release commit and operating deployment receipt are pending. The interface is named **ListingStudio** and has four primary tasks: **Tổng quan**, **Bộ listing**, **Đăng hàng**, and **Shop**. **Công cụ** retains source intake, update intake, workbench, and archive tools. Start with the [integration review](../reviews/2026-10-01-product-integration.md), [operator workflow](../runbooks/internal-manual-review.md), and [isolated development guide](../runbooks/internal-development.md).

The integrated candidate includes paginated local listing summaries, compact seller-knowledge projections, exact selected-shop isolation, dynamic authorization callback/return locations, authorization recovery, and source/revision guards after bulk edits. Migrations 001–046 retain their original bytes; 047–051 are additive release migrations. Backup, offline restore verification, and operating deployment are in progress. Listing writes, copying, repair, and automatic batch resume remain paused. No new AI feature is included, and these upgrade tests made no Shopee writes.

## Objective

Maintain a resumable Shopee bulk-listing application that receives Word, image, and price sources; prepares reviewable listing drafts; creates hidden listings through a controlled backend; and keeps human QC separate from publication.

## Current system boundary

- The repository contains the web application, API, worker, persistence layer, Shopee transport, tests, operator runbooks, and a deterministic assistant harness.
- Private source files, shop tokens, database volumes, raw API evidence, and dated execution checkpoints remain local and are excluded from Git.
- Production writes must be scoped to the selected partner, shop, connection revision, capability revision, source revision, plan fingerprint, registered operation, and exact target set.
- A newly created production listing remains hidden until readback and human QC are complete.

## Authoritative source order

1. The user's current instruction and explicit authorization for the exact action.
2. The selected local source files and their recorded revision/fingerprint.
3. Current shop metadata and remote readback returned for the selected connection.
4. Durable operation journal and request receipts.
5. Official Shopee Open Platform and Seller Education documentation.
6. Historical observations, only as dated references and never as silent defaults.

## AI management corridor

`@shopee/agent-runtime` exports `buildManagementCorridor`, `managementHandoffSchema`, `parseManagementHandoff`, and `renderManagementBrief`. The corridor has five modes: inspect, prepare, publish hidden, recover, and handoff.

It does not call an LLM or grant write authority. It makes scope, source identity, allowed capabilities, required sequence, stopping conditions, and claim boundaries explicit for whichever model or orchestrator uses it.

Repository skills:

- [`shopee-uploader-operator`](../../skills/shopee-uploader-operator/SKILL.md) routes inspection, preparation, hidden publication, and recovery.
- [`shopee-uploader-handoff`](../../skills/shopee-uploader-handoff/SKILL.md) keeps public handoffs concise and prevents private evidence from being published.

## Verification and claims

- Full isolated run `run-1bwVTX` on 2026-10-01 passed **2740/2740 unit/integration, 7/7 legacy, and 1/1 intake browser**, plus typecheck, repository skill validation, and TypeScript/web builds.
- **7/7 workspace browser cases** passed separately, covering navigation/Back, exact shop selection, scoped isolation, partial resource failures, archive routing, unavailable database counts, and mobile/keyboard use. These results are not additional cases in the full run.
- The intake browser used the real local UI, API, import worker, and isolated PostgreSQL. External Shopee responses and shop metadata were fixtures. No live platform, every-shop, or 24-hour acceptance follows from this result.
- `npm run test:eval` exercises deterministic harness fixtures and records that no model accuracy or Shopee write was measured.
- `node scripts/verify.mjs` is the repository/CI entry point. On an operating machine, use `node scripts/verify-internal.mjs --browser` with its strict isolated configuration; it must not target the operating database.
- Fixture, sandbox, and local preparation results do not prove production publication.
- Upload acknowledgements and HTTP success do not prove listing correctness.
- An unknown write outcome must be reconciled through readback before any retry.

## Known limits

- One visible historical preparation references four source listings whose preparation files are missing. Preserve its paused state; obtain the exact source files before recovery. Do not fabricate evidence or automatically resume it.
- Deployment completion, final release identity, and restored-data checks must be recorded after their receipts exist. The selected backup scope does not prove every historical private artifact, offsite retention, or a 24-hour backup policy.
- The deterministic assistant review is not an autonomous production agent.
- Current platform behavior still depends on each partner, shop, category, brand, logistics channel, and API capability at execution time.
- Some categories require size charts, certifications, video, or other metadata that cannot be invented by the application.
- Production readiness has not been generalized to every shop, category, update type, or continuous 24-hour operation.

## Continuation checklist

1. Read this handoff and the relevant operator runbook.
2. Select one management mode and build its corridor.
3. Confirm repository, runtime, shop scope, source revision, and durable operation state.
4. Query the Shopee knowledge base when behavior depends on platform rules.
5. Preserve unresolved values instead of filling them speculatively.
6. Run the checks proportional to the change and record only the evidence actually observed.
7. Complete backup/restore checks and migration readiness before restarting the operating build; keep unresolved preparations paused and reconcile unknown outcomes before any retry.
