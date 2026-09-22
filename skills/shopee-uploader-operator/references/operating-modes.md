# Operating modes

## Inspect

Confirm the current branch/commit, active shop scope, connection and capability revisions, source revision, plan fingerprint, durable job state, and newest handoff. Prefer read-only APIs and database queries. Report facts, inferences, and unknowns separately.

## Prepare

Bind every listing to its input folder or workbook row, image roles, price profile, SKU mapping, target shop, and unresolved issues. Keep ambiguous values unresolved. A locally complete draft is not a publishable listing until server preflight validates current shop metadata.

## Publish hidden

The write boundary opens only for the exact targets explicitly authorized by the user. Use a registered operation and idempotency identity. Persist each request receipt, rate-limit state, and response. Read the item and model list after creation; compare SKU, price, stock, image order, category, brand, logistics, and hidden status before reporting success.

## Recover

Start from durable operation and request IDs. If the request may have reached Shopee, read remote state before retrying. Classify the result as verified, failed before write, transient failure safe to retry, or unknown. Never convert unknown to failed merely to unblock the queue.

## Stop and escalate

Stop when scope or source identity changed, the source is ambiguous, a required category field has no supported value, the shop no longer exposes the required capability, a business error repeats, or readback differs from the intended SKU/image structure.
