# Database runtime: deadline and recovery

API and source worker construct their pools through `createRuntimePool` in `packages/persistence/src/runtime-pool.ts`. Do not replace that with an unguarded `new Pool` in long-lived entry points.

- Acquiring/connecting defaults to 5 seconds; PostgreSQL statements and idle transactions default to 120 seconds.
- Client `query_timeout` is the statement deadline plus 5 seconds (125 seconds by default). Server cancellation alone cannot settle a request when the socket remains open but its replies are lost.
- An error from an idle pooled connection is handled with a fixed, rate-limited log. pg removes that failed client; the next caller obtains a fresh connection. No query or mutation is replayed by this handler.
- A failed transaction attempts rollback, preserves the original exception even when rollback fails, and destroys the checked-out connection on release. A successful transaction returns its client normally.
- A missing response is not proof a write failed. Client timeout does not undo a committed database/Shopee operation. Re-read the journal and operation identity before any decision to resend.
- These are per-query bounds, not an overall operation deadline. A rollback attempted after a response timeout can consume another query deadline. API readiness does not certify a background job, remote result, or full system health.

Targeted regression tests: `tests/unit/runtime-pool.test.ts`, `database-response-recovery.test.ts`, `database-response-api.test.ts`, and `tests/integration/database-runtime-recovery.test.ts`. Run integration only on the guarded fixture database at port 5443 according to `internal-development.md`.

Changing source does not replace the running processes. Deploy only after confirming owned PIDs, job state, backup and the intended maintenance scope. Keep publication/copy holds; never treat recovery or startup as permission to resume work.
