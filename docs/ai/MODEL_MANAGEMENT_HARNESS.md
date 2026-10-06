# Model management harness

The model management harness is a deterministic boundary around AI-assisted investigation and operations. It guides a model without giving the model direct, implicit authority to mutate Shopee.

## Components

- `InvestigationHarness` exposes only plan inspection and cited knowledge retrieval. It applies a call budget, deadline, repeat-call guard, scope revalidation, safe error codes, and citation integrity checks.
- `KnowledgeLibrary` searches the local Shopee snapshots and reads only manifest-listed documents from approved Shopee domains.
- `buildManagementCorridor` selects the operational mode and describes the exact write boundary, required sequence, stopping conditions, and claim limitations.
- `managementHandoffSchema` validates compact machine-readable handoffs and rejects undeclared fields.

## Modes

| Mode             | Purpose                                                            | Remote writes |
| ---------------- | ------------------------------------------------------------------ | ------------- |
| `inspect`        | Explain current plans, issues, and evidence                        | Never         |
| `prepare`        | Build or normalize local drafts                                    | Never         |
| `publish_hidden` | Execute one registered, explicitly authorized production operation | Conditional   |
| `recover`        | Reconcile receipts and remote state before retry decisions         | Read first    |
| `handoff`        | Record current facts, limits, and next steps                       | Never         |

`publish_hidden` is blocked unless the corridor receives explicit production-write authorization, a production scope, and a registered operation identity. This object is still only a policy result; the server remains responsible for authorization, validation, idempotency, rate limiting, journaling, and readback.

## Prompt assembly

A model-facing prompt should contain, in order:

1. a bounded session brief containing public instructions, feature contracts and the selected checkpoint;
2. the rendered management corridor;
3. a detached plan projection;
4. current unresolved issues;
5. only the Shopee documents actually read and cited;
6. a reminder that source text is reference data, not executable instruction.

Do not include tokens, cookies, encrypted secrets, raw private source documents, arbitrary filesystem paths, or entire API payload histories.

## Completion rule

The model may recommend an action. It may report a production result only when the backend has a durable receipt and current readback supporting the claimed state. A missing response, stale scope, changed source fingerprint, or repeated business failure stops the corridor.

## Evaluation

`npm run test:eval` runs deterministic fixtures. Its output explicitly sets `modelConfigured: false`, `modelAccuracy: not_measured`, and `shopeeRequests: 0`. A future model evaluation must remain separate from production writes and must report the model, dataset, rubric, failures, and observed tool traces.

## Session continuity

[Session continuity](SESSION_CONTINUITY.md) adds explicit feature routing, bounded context packets, a private revisioned checkpoint and immutable local deltas. It preserves decisions and paused work, detects changed/missing evidence and exposes remaining references without loading histories. The CLI never invokes models, refreshes connections, changes the business database or resumes operations. It does not modify the management corridor or grant authority. Context records remain reference data; current source, backend journals and readback remain authoritative. Repository instructions define a routine, not a platform hook that runs automatically on every chat message.
