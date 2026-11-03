# TEST_MATRIX
| Suite | Target head | Result | Source | Independent? |
|---|---|---|---|---|
| Connector node tests (12 files) | RC 7e4d24e | 206/206 pass | local run 2026-11-03 | YES (this session) |
| Python unittest (tests/) | RC 7e4d24e | 1414 OK (196 s) | local run | YES |
| Connector Durable Object tests (vitest + workerd, real SQLite) | RC 7e4d24e | CI success (13 runs / 8 families) | GitHub check-runs | NO — npm registry unreachable here; CI only |
| Wrangler dry-run Production/Staging | RC | CI success | check-runs | NO |
| Full-history secret scan | RC | CI success | check-runs | NO |
| Live Staging HTTP/auth/MCP/DO acceptance | Staging worker | claimed success by other session (#117 comments, runs 41408633702 etc.) | issue comments | NO — NOT_VERIFIED here |
Negative/positive Staging cases (idempotency replay, concurrency, retention boundary, UNKNOWN backlog fail-closed) exist as DO tests in `cloudflare-test/write-control*.test.js` (CI-verified).
