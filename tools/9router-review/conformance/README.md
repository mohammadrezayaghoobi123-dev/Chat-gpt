# Reservation Contract Conformance Harness

This directory contains a non-production reference oracle and the first executable conformance tranche.

- The reference adapter is an executable specification only. It is in-memory and is not durable.
- Passing these tests validates the contract harness against the reference model; it does not qualify Cloudflare Durable Objects, R2, Supabase, or any deployed backend.
- The candidate adapter must later run the same contract suite in an isolated environment with independent clients, process restarts, fault injection, and restore drills.
- No provider credentials, model calls, GitHub API calls, comments, or deployments are performed by this test suite.

Run with Node.js 22 from tools/9router-review:

`node --test conformance/reservation-adapter.contract.test.mjs`

## Coverage map

| Reference test | Contract matrix relation | Scope |
|---|---|---|
| T01 | A01, partial A02 | Concurrent claim arbitration in one process |
| T02 | A27 | Policy/runtime digest mismatch fails closed |
| T03 | A04, A07 | Expired claim takeover and generation fencing |
| T04 | A08, A26 | No model permit without acknowledged effect-ledger intent |
| T05 | A08, A09 | Single-use model attempt boundary |
| T06 | A11 | Model completion fencing and durable ledger outcome |
| T07 | A09, A10 | Model-attempt lease expiry never authorizes retry |
| T08 | A10, A36 | Model-stage UNKNOWN cannot be reconciled through comments |
| T09 | A12, A31, A35 | Continuation-only recovery from MODEL_COMPLETED |
| T10 | A05, partial A13 | Stale continuation owner is fenced |
| T11 | A13, partial A26 | Comment attempt requires snapshot and ledger evidence |
| T12 | A13, A14 | Comment attempt is single-use and non-reclaimable |
| T13 | A15, A16 | PUBLISHED requires validated response outcome evidence |
| T14 | A18, A37, A38 | Incomplete listing never proves absence |
| T15 | A20 | Duplicate positive evidence escalates to DUPLICATE_ACCEPTED |
| T16 | Contract transition completeness | ABORTED and CLOSED_NO_PUBLISH are distinct |
| T17 | A41 | RECOVERY_LOCKED blocks external-effect permits |
| T18 | I26 | Effect-ledger intent is idempotent and payload-bound |
| T19 | A41 | Recovery unlock requires complete independent inventory |

This is not the A01–A41 backend qualification suite. The coverage map deliberately marks partial coverage. A02's controlled read-before-insert schedule, A03's forced tuple/hash-collision case, independent-process concurrency, backend failover, storage restore, R2 conditional writes, quota exhaustion, and the remaining matrix cases are still NOT_EXECUTED.
