# Reservation Contract Conformance Harness

This directory contains a non-production reference oracle and the expanded executable conformance tranche.

- The reference adapter is an executable specification only. It is in-memory and is not durable.
- Passing these tests validates the contract harness against the reference model; it does not qualify Cloudflare Durable Objects, R2, Supabase, or any deployed backend.
- The candidate adapter must later run the same contract suite in an isolated environment with independent clients, process restarts, fault injection, and restore drills.
- No provider credentials, model calls, GitHub API calls, comments, or deployments are performed by this test suite.
- The committed attempt-boundary receipt design is specified in [ATTEMPT_BOUNDARY_RECEIPT_CONTRACT.md](./ATTEMPT_BOUNDARY_RECEIPT_CONTRACT.md). The reference oracle now models receipt issuance, exact capability admission, and read-only recovery with a private in-memory registry and deterministic non-cryptographic test token. This is not a cryptographic signer/verifier, durable journal, distributed authority, or production backend.

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
| T48 | I34 | Missing attempt-boundary receipt is rejected without ledger mutation |
| T49 | I35 | Receipt field mutations are rejected; exact committed receipt is accepted |
| T50 | I36 | Lost boundary acknowledgement recovers the exact durable receipt without another permit |

This is not the A01–A42 backend qualification suite. T32–T42 extend the in-memory reference oracle's reconciliation and recovery-validation coverage; they do not qualify a real provider adapter. The coverage map deliberately marks partial coverage. A02's controlled read-before-insert schedule, A03's forced tuple/hash-collision case, independent-process concurrency, backend failover, storage restore, R2 conditional writes, quota exhaustion, and the remaining matrix cases are still NOT_EXECUTED.

## Observed evidence

T46–T47 were observed RED on the initial test-only revision and GREEN after the reference-oracle correction. Hosted run 45511958154 reports T01–T47 47/47 PASS. The full reviewer regression remains intentionally non-green because the preserved duplicate-publication race still produces two POSTs. This does not qualify any persistent provider adapter.

Hosted run 45552431713 on revision `fb3650530704fabc239ec8977bd39386de230422` observed T48, T49, and T50 RED. T49 specifies mutation rejection for reservation key, stage, attempt ID, request digest, generation, committed record version, boundary event ID, schema version, authority identity, and signature; execution stops at the missing-receipt assertion, so individual mutations and exact-receipt acceptance remain unexercised. T50 genuinely discards the boundary-call response, then asserts recovery returns a receipt bound to authoritative record version, repeated recovery is stable, and a repeated begin call cannot issue another permit. It fails because `readAttemptBoundaryReceipt` is absent; recovery semantics are not yet exercised. No adapter correction has been applied. Do not treat this tranche as GREEN or production qualification.

The design-only receipt contract was added at commit `220c956c0151711a7bdd64cef4296463bad6c3bf` and its hostile test-design review was recorded at `b29a81cbb4b1994a52109e1df02092251c552e3d`. The T49 test was corrected at `f419216336a1c910362eb5cf68231608fcd93a42` to mutate the exact canonical fields `reservation_key_digest` and `receipt_schema_version`, add protocol/authority/key/time/purpose/signature mutations, and test cross-key receipt replay. The mutation and cross-key replay branches remain unexecuted until a receipt is issued; the test still stops at the explicit missing-receipt assertion. The cross-key replay assertion snapshots the global ledger event count and watermark before/after, because `readComplete` returns the complete ledger inventory rather than a key-filtered subset. This test refinement is at `70c3eb6f86a1a59694bcd74294b3d7766402885d`. No adapter correction has been applied.


## T57 terminal orphan-INTENT recovery — staged harness evidence

The accepted terminal-abort policy is specified in [ADR-001](./ADR-001-ORPHAN-INTENT-TERMINAL-ABORT.md). Under that policy, only complete authoritative evidence that the exact attempt boundary was never committed can lead to abort. The ReservationStore tombstone is committed first and blocks the exact attempt ID; only after its durable acknowledgement is the final `ORPHAN_INTENT_ABORTED` EffectLedger event appended. Committed boundaries recover their exact receipt. Unknown, incomplete, stale, unavailable, or conflicting evidence remains quarantined.

### Focused command

From `tools/9router-review`, run:

`npm run test:orphan-recovery`

This invokes the two T57 test files on Node.js 22. The default `npm test` also discovers these `*.test.mjs` files.

### T57 test matrix

| Test | Assertion | Latest observed result |
| --- | --- | --- |
| T57.1 | Durable INTENT ACK survives writer termination; independent process reopens both SQLite files and verifies the event/digest and no boundary | PASS in isolated harness |
| T57.2 | One tombstone plus one final ledger event; late permit denied; repeat recovery returns identical IDs | PASS in isolated harness |
| T57.3 | Process terminates after tombstone but before final ledger append; a new process appends the same final event without duplicate tombstone | PASS in isolated harness |
| T57.4 | Stale recovery fence is rejected; takeover worker succeeds; stale worker cannot mutate after takeover | PASS in isolated harness |
| T57.5 | Incomplete ReservationStore or EffectLedger reads quarantine without mutation | PASS in isolated harness |
| T57.6 | Existing committed boundary returns the exact prior receipt and is not aborted | PASS in isolated harness |
| T57.7 | Second independent reopen preserves one tombstone, one final event, stable IDs and ledger watermark | PASS in isolated harness |
| T57.8 | Independent processes race attempt start against orphan abort; permit wins only before fence, otherwise transient `RECOVERY_FENCED` is followed by terminal `ORPHAN_ABORTED` after recovery; exactly one terminal outcome exists | PASS after transient-fence expectation correction |
| T57.9 | Forged tombstone ACK and same-ID tuple/request conflicts fail closed | PASS in isolated harness |
| T57.10 | No attempt permit is issued without an exact matching durable Ledger INTENT | PASS in hosted focused suite |
| T57.11 | An active recovery fence blocks new attempt-start until terminal disposition or recovery takeover | PASS in hosted focused suite |

### RED → GREEN evidence for T57.8

Hostile repeated execution found three harness defects before the final stable run:

1. The boundary-race branch selected `identity_json` without `receipt_json`; when the attempt-start transaction won, recovery could not return the exact committed receipt.
2. Each new connection reissued `PRAGMA journal_mode=WAL`, which could contend with a concurrently opening worker and produce `database is locked`.
3. Boundary existence and permit counters were read in separate autocommit snapshots. During a concurrent commit, the test reader could observe an old boundary view and a newer permit count, falsely classifying a valid committed boundary as `INTEGRITY_CONFLICT`.

Corrections:
- the race branch now selects both identity and receipt;
- WAL is configured only when a database is not already in WAL mode, with busy timeout set before mode inspection;
- `readAttemptBoundary` reads boundary and side-effect counters within one SQLite read transaction; recovery-history events and watermark are also read from one snapshot.

The failure was retained as observed test evidence; no assertion was removed or weakened. After correction, T57.8 passed 10 consecutive isolated race probes. The T57.1–T57.9 suite previously passed **three consecutive runs**, each **9 tests / 9 passed / 0 failed** on Node.js `v22.16.0`. T57.10 and T57.11 were then added test-first; both failed on the initial implementation because `beginAttempt` returned `PERMIT` without INTENT and while a recovery fence was active. Syntax checks for the four T57 source files also exited successfully.

### Exact source identities

Git blob identities used for the byte-identical local test run:
- T57.1 test: `eb55f2ab523611711d30da96223c0427f59985c6`
- SQLite test adapter: `c1d9a8d578ccecd91c044f39f6f4b73f32376d79`
- Independent worker: `6ecf70cd46fad12fed95750d6278d3171d072b78`
- T57.2–T57.9 tests: `1cdd41754a5800d823e45fccc2d0f2842bf441e6`

### Evidence limits

The SQLite adapter is explicitly **TEST-ONLY**:
- it uses two local SQLite files on the same runner/filesystem, not independent production services or failure domains;
- the digest values are integrity checks, not signatures, MACs, trusted timestamps, or proof from an independent authority;
- recovery fencing models generation CAS but does not authenticate worker identity, model lease expiry, or a production trust root;
- `beginAttempt` is a fake permit gate and does not invoke a provider or external effect;
- it is not wired into `runReview()`, the reviewer workflow, Cloudflare, R2, Supabase, or any deployed ReservationStore/EffectLedger;
- it does not prove machine/power-loss durability, independent backup/restore, multi-region recovery, backend quota/failover, or production security.

Therefore, all nine T57 tests are **GREEN ONLY IN THE LOCAL SQLITE CONFORMANCE HARNESS**. The complete RS-08 production requirement remains **GAP / NOT QUALIFIED**. The preserved duplicate-publication race remains a separate known RED in the full reviewer regression; it was not changed by this work.

Hosted Actions status for the push commits was not available from the retrieved workflow/status interface. Do not infer hosted CI success from the isolated executions.

 
The existing read-only `.github/workflows/9router-reservation-conformance.yml` now has a dedicated `if: always()` step for `npm run test:orphan-recovery`. This isolates the T57 result from the full reviewer-regression step, whose known duplicate-publication race remains separately RED. The workflow is limited to verification-branch pushes/manual dispatch and uses `contents: read`; it does not enable the reviewer workflow or require provider credentials. A hosted run for the latest commit remains unverified until an Actions result is retrieved.

 
## T57.10–T57.11 RED→GREEN and hosted verification — AR-71

### Newly discovered permit-boundary defects

The test-first additions exposed two unsafe behaviors:
- T57.10 observed `beginAttempt` return `PERMIT` despite no durable EffectLedger INTENT for the exact operation.
- T57.11 observed `beginAttempt` return `PERMIT` while a recovery fence was already committed for the operation.

The expected outcomes were `LEDGER_NOT_ACKNOWLEDGED` and `RECOVERY_FENCED`, respectively. Both RED results were observed in GitHub Actions on commit `5c456c60b0583eaca056f2572c03ec0be7084594`; focused suite: **9 passed / 2 failed**. The unchanged full regression additionally retained the existing duplicate-publication failure.

### Corrective implementation

`beginAttempt` now:
1. reads the durable INTENT from the test EffectLedger and requires exact canonical operation equality before proceeding;
2. fails closed on missing or integrity-conflicted INTENT;
3. in the same ReservationStore `BEGIN IMMEDIATE` transaction, checks terminal tombstone first, then active recovery fence, then existing boundary;
4. only then writes the attempt boundary and permit rows.

The tombstone retains precedence so an already-aborted attempt returns `ORPHAN_ABORTED`, not the weaker temporary `RECOVERY_FENCED`.

### Hosted verification

- Corrective commit: `3ad3aa7bc2f2a9a24fba1117f38596db38e4278e`
- GitHub Actions run: [45583104765](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45583104765)
- Job: `conformance`; isolated T57 step: **11 tests / 11 passed / 0 failed**.
- Reference-oracle tranche: **56/56 passed**.
- Full reviewer regression: **203/204 passed**; the sole failure remains `deterministic concurrent duplicate-publication red test`, which observed 2 POSTs where the invariant permits at most 1. It was not changed or suppressed.
- Expected Node.js experimental `node:sqlite` warning was emitted; the focused suite itself completed successfully.

### Evidence classification

T57.10 and T57.11 are behavioral evidence for the SQLite test harness only. They do not qualify production ReservationStore/EffectLedger APIs, signatures, independent trust roots, external provider interlocks, backup/restore, or reviewer integration. RS-08 remains **PARTIAL / TEST-HARNESS ONLY / PRODUCTION GAP OPEN**.



### T57.8 recovery-fence ordering clarification — AR-72

The later addition of the begin-time recovery-fence gate exposed that the original race assertion expected only `ORPHAN_ABORTED` when the recovery worker won. A valid interleaving exists in which the recovery fence has committed but the terminal tombstone has not yet committed; a concurrent start must then return `RECOVERY_FENCED`, not pretend the tombstone already exists. T57.8 now accepts either:
- `PERMIT` with a committed boundary/receipt, followed by recovery returning that exact receipt and no tombstone; or
- `RECOVERY_FENCED` or `ORPHAN_ABORTED` for the racing start, followed by terminal recovery, then an explicit late-start probe that MUST return `ORPHAN_ABORTED`, with exactly one tombstone and terminal ledger event and zero permits/boundaries.

The test asserts final durable state after the terminal outcome, not the transient interleaving label. No production code or safety assertion was weakened. The previous hosted run showed T57.8 failure solely because the expected transient state was too narrow; T57.9–T57.11 still passed and the focused 11-test tranche passed 11/11. The corrected test is now on the verification branch; a fresh exact-head Actions result is required before calling this revision GREEN.