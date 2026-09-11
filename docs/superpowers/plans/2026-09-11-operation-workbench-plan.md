# Operation Workbench Implementation Plan

> For agentic workers: use subagent-driven-development; root integrates contracts, routes, validation and evidence.

**Goal:** A workbench centered on prepared sources and shop-specific tasks, with a verifiable direct sandbox update/readback slice.

**Architecture:** Reuse immutable sources and drafts. Add versioned work orders referencing an exact draft and connection, a structured handoff format, classified exceptions and sandbox operation intents with readback. No source regeneration or production writes.

**Tech Stack:** Existing Node 24.20.0, TypeScript, Nest/Fastify, PostgreSQL and React/Vite.

**Spec:** `docs/superpowers/specs/2026-09-11-operation-workbench-design.md`.

## Global constraints

- Existing Lamy local revision remains unchanged unless a concrete source edit is requested. Real sandbox testing reuses item803934364/shop227418363; no duplicate create.
- Source text/SKU/labels/order/bytes remain exact. Mock fixtures are marked and isolated from business data and external writes.
- Sandbox connection secrets stay encrypted at server, never exposed in UI/chat/log. Live shops remain read-only.
- New user-facing actions reflect supported code paths, with failed/unknown outcomes separated from verified success.

## Tasks

- [x] Root: add WorkOrderConfig/WorkOrderView contract, migration005 work_orders/revisions, CAS+idempotent order persistence, classified readiness and `/v1/workbench` + `/v1/work-orders` routes. Tests cover exact-source selection, concurrent edits, duplicate targets, missing vs unsupported and no default stock.
- [x] Frontend agent: replace home with workbench and focused detail panel; source intake/settings secondary; explicit shop/create-update/item/field selection, issue grouping, batch creation of local work orders and direct sandbox review controls. Preserve source edit/receive flows and display failures truthfully. Desktop/mobile and keyboard checks.
- [x] Handoff agent: structured prepared-source handoff JSON import/export with source references, path-scoped images, exact SKU/price tuple and original content; explicit reuse of productKey for source revisions. Fixtures represent varied data without generating business facts. Tests prove no rewriting and rejection of ambiguous or conflicting mappings.
- [x] Sandbox agent: source-backed Product gateway reads and narrow selected-field updates, migration006 durable operation intents/checkpoints, drift checks, outcome reconciliation and raw evidence without secrets. Gateway failures and isolated DB tests cover retry safety and item/scope invariants.
- [x] Root integration: wire handlers/UI contracts, apply migrations, restart dev safely; run full checks and local UI acceptance. Use live direct sandbox read first; run only permitted supported writes after exact review. If credential/permission blocks, report actual response and keep unaffected work complete.
- [x] Root delivery: update guidance/ledger with supported capabilities and concrete limits, preserve sources and private artifacts, commit/push tested code and verify CI. Code commit `2b8f1f3`; push and pull-request checks both passed on GitHub. PR remains Draft.

## Acceptance checkpoint — 11/09/2026

Local checks: 240 unit/integration + 7 legacy + 43 browser E2E passed. The live update was acknowledged and selected fields matched, but the gallery request exposed a cover replacement side effect. The original cover was restored separately; Shopee remapped its ID. Strict readback remains `unknown / COVER_READBACK_REVIEW`. Therefore the live pilot is **not fully verified** and B4 remains in progress. The gallery preservation patch and diagnostic-only handling have regression coverage; no automatic image equivalence or manual acceptance workflow has been implemented.
