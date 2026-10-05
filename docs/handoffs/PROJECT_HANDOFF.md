# Current project handoff

Updated: 2026-10-05

## ListingStudio integration

The operating fixes and the internal upgrade were merged at `2ba212d` on `feat/internal-app`, with `be4e5d6` and `b232204` as parents. The application is running locally: API/database readiness and source-worker heartbeat verified. ListingStudio has four primary tasks: **Tổng quan**, **Bộ listing**, **Đăng hàng**, **Shop**; advanced tools remain in **Công cụ**. Start with the [integration review](../reviews/2026-10-01-product-integration.md).

The deployed version includes paginated library summaries, compact seller-knowledge projections, exact shop isolation, configurable callback/return locations, authorization recovery, and revision-bound source/mapping/price guards. Migrations 001–046 retain their raw bytes; 047–051 were rehearsed offline, then applied. The verified backup of selected roots contains 9,793 files / 5,397,090,009 bytes, including the database dump; configuration and keys are protected separately. Offline restore preserved all 88 original tables and opened 16 encrypted credential values without external requests. Business rows, connections, paused executions and 1,620 source files stayed unchanged after deployment; only migration history and worker heartbeat changed. Listing writes, copying, repair, automatic batch resume and connection maintenance remain paused. No new AI feature or Shopee write was included in acceptance.

## Portable installation and transfer

Start at [START_HERE](../onboarding/START_HERE.md). [CODEX_FIRST_RUN](../onboarding/CODEX_FIRST_RUN.md) gives the receiving maintainer a scoped setup request; [ACCEPTANCE](../onboarding/ACCEPTANCE.md) defines what to check before use.

- Windows entry points are `SETUP_LISTINGSTUDIO.cmd`, `START_LISTINGSTUDIO.cmd`, and `STOP_LISTINGSTUDIO.cmd`. Setup can install the pinned portable Node runtime and verifies its official checksum. Node is `>=24.20.0 <25`; PostgreSQL is pinned to 17.11 with Docker Compose v2.
- Setup plans before applying, uses the npm lockfile, creates owned configuration and a separate database, and refuses existing configuration, unowned volumes or occupied ports. Starting the app does not enable production writes, automatically renew connections, or resume old work.
- [TRANSFER_AND_RECOVERY](../onboarding/TRANSFER_AND_RECOVERY.md) covers database, application files and decryption-key transfer with verify/plan/apply receipts. Restored work stays held for review. The receiving installation retains its own database password and ports.
- GitHub contains application source, fixtures and instructions. Database, shop credentials, encryption keys, customer source files, private receipts and the reference-document library are delivered separately; cloning the repository does not restore them. Saved shop credentials still need an authorized online validity check.
- The source package was verified against the working tree on 2026-10-02. Publishing the source does not refresh that dated private data snapshot. Prepare a new private transfer if the receiving machine needs subsequent operating changes.

Installation and restore were rehearsed in isolated checkouts/databases on the operating computer. A physical second computer and continuous production operation have not been accepted.

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

- The packaging run on 2026-10-02 passed **2844/2844 unit/integration tests**, **7/7 legacy tests**, typecheck, repository skill validation and TypeScript/web builds in isolation. **38/38 Node onboarding tests** and **51/51 onboarding Vitest cases** passed; the latter overlap the full unit suite.
- **1/1 intake browser case** passed with the real local UI, API, worker and isolated PostgreSQL, using external platform fixtures. Cold startup opened the three owned application roles and passed 17 environment checks without altering its configuration.
- Offline restore preserved 88 application tables and four sequences alongside the receiving migration ledger, decrypted 24 credential values, relocated 826 application blobs and opened four read-only UI pages. All 89 target tables remained unchanged after review, and old work stayed held. No Shopee requests were made during that rehearsal.
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
- Deployment, the final release identity and offline restore checks have been recorded in their local receipts and the integration review. The selected backup scope does not prove every historical private artifact, offsite retention, or a 24-hour backup policy.
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
