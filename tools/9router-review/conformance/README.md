# Reservation Contract Conformance Harness

This directory contains a non-production reference oracle and the expanded executable conformance tranche.

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
| T20 | A18, A19 | Positive marker evidence remains sufficient despite incomplete later pagination |
| T21 | I20 | HMAC key rotation does not change persisted marker identity |
| T22 | A15, A19 | Comment-stage UNKNOWN resolves only from positive evidence |
| T23 | A25 | Lease expiry uses backend/server clock, not caller clock |
| T24 | I15 | Stale record version cannot renew lease |
| T25 | I26 | Effect-ledger receipt cannot cross immutable reservation keys |
| T26 | A19 | Positive pre-model reconciliation prevents model dispatch |
| T27 | I16 | CLOSED_NO_PUBLISH is terminal for publication |
| T28 | I26 | Effect-ledger outcome is immutable per attempt ID |
| T29 | I14 | Marker ID mismatch is a hard reservation conflict |
| T30 | A18 | Zero evidence does not resolve comment-stage UNKNOWN |
| T31 | A15, A16 | Comment deadline expiry becomes UNKNOWN and never authorizes retry |
| T32 | A18, A19 | Duplicate pagination evidence for one remote comment is deduplicated |
| T33 | A41 | RECOVERY_LOCKED blocks reconciliation state mutation |
| T34 | A41 | Recovery unlock requires a separately supplied trusted anchor |
| T35 | A41 | Recovery unlock rejects a watermark mismatch |
| T36 | A41, I26 | Recovery anchor covers the complete cross-key ledger inventory |
| T37 | A41, I26 | Recovery unlock rejects tampered event payloads |
| T38 | A41, I26 | Recovery unlock rejects non-contiguous event sequences |
| T39 | A41, I26 | Recovery unlock rejects duplicate event identifiers |
| T40 | A41, I26 | Recovery unlock verifies each immutable event digest |
| T41 | A41 | A stale or foreign anchor cannot authorize recovery |
| T42 | A41 | Failed recovery validation preserves the global lock |
| T43 | A41 | Ordinary mode setter cannot bypass anchor-verified recovery unlock |
| T44 | A41 | Recovery lock blocks model-completion writes |
| T45 | A41 | Recovery lock blocks all non-recovery reservation mutations |
| T46 | A11, A12 | MODEL intent rejects COMMENT_ACCEPTED as a stage-incompatible outcome |
| T47 | A11, A12 | COMMENT intent rejects MODEL_RESULT_STORED as a stage-incompatible outcome |
| 

This is not the A01–A42 backend qualification suite. T32–T42 extend the in-memory reference oracle's reconciliation and recovery-validation coverage; they do not qualify a real provider adapter. The coverage map deliberately marks partial coverage. A02's controlled read-before-insert schedule, A03's forced tuple/hash-collision case, independent-process concurrency, backend failover, storage restore, R2 conditional writes, quota exhaustion, and the remaining matrix cases are still NOT_EXECUTED.


T46–T47 add stage-to-outcome binding checks for the append-only effect ledger.


Latest stage-bound outcome checkpoint: T46–T47 were observed RED on the initial test-only revision and GREEN after the reference-oracle correction. Hosted run 45511958154 reports T01–T47 47/47 PASS. The full reviewer regression remains intentionally non-green because the preserved duplicate-publication race still produces two POSTs. This does not qualify any persistent provider adapter.

| T48 | I34 | Outcome append rejects a missing authoritative attempt-boundary receipt without advancing the ledger sequence |
| T49 | I35 | Outcome append rejects receipt mutations across reservation key, stage, attempt ID, request digest, generation, or committed record version; exact receipt is accepted |
| T50 | I36 | Lost boundary acknowledgement recovers the same durable receipt without issuing another permit |

Hosted run 45552193719 on revision `522166def70bf9b0cd7b286d01a33840761b50e5` observed T48, T49, and T50 RED. T49 stopped at the missing-receipt assertion, so its mutation matrix and positive exact-receipt path remain unexecuted. T50 failed its explicit API-presence assertion because `readAttemptBoundaryReceipt` is absent; recovery semantics are not yet exercised. No adapter correction has been applied. Do not treat this tranche as GREEN or production qualification.
