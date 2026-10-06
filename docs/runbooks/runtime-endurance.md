# Runtime endurance and fault acceptance

Run in a separate checkout with the isolated environment configured and migrated using `internal-development.md`. The script rejects the operating database and runs its own API on an ephemeral loopback port; publishing, maintenance and platform writes remain disabled. It does not resume any batch.

With Node 24.20 on PATH:

```powershell
$env:TSX_TSCONFIG_PATH = (Resolve-Path apps/api/tsconfig.json).Path
node --expose-gc --conditions=development --import tsx scripts/runtime-endurance.mts --seconds 300 --concurrency 20
```

Options: `--seconds 1..86400`, `--concurrency 1..100`, `--interval-ms 20..60000`. Defaults are five minutes, twenty concurrent readers and a 150ms interval per reader. Longer acceptance can use `--seconds 86400`; completing a shorter run does not prove a 24-hour result.

Each run writes a private, unique `.local/internal/endurance/run-*/result.json` with measured duration, failure counts, approximate latency percentiles, event-loop delay, bounded memory samples and pool pressure. Latency uses a fixed histogram rather than retaining every request; percentile resolution is 10ms, values above 10 seconds occupy the final bucket. Any HTTP/timeout failure produces nonzero exit status. Requests cover readiness, overview, shop connections and a product page. Dataset size is the existing fixture; representative large datasets and production Shopee traffic require separate acceptance.

Fault coverage is separate: `tests/integration/database-runtime-recovery.test.ts` checks idle connection termination, statement deadline and pool exhaustion on the guarded test database. Import deadline tests cover parser isolation and lease fencing; supervisor tests cover process ownership, retry ceiling and manual stop. A successful health response does not prove a remote write or a suspended worker completed.

Never run integration tests against the operational database. Keep the measured receipt and report actual duration, dataset and remaining limitations when handing over.
