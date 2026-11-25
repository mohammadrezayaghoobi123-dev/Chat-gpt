# ReservationStore Contract-to-Test Traceability Matrix

## Status and evidence boundary

**Status:** static traceability artifact; not an implementation qualification, test result, or approval to select a backend.

**Reviewed source snapshot:** branch `verify/9router-reservation-conformance-run9-2026-11-25`, HEAD `7a42adaecc4b56c7a4b3a4fc6f4f9dd00391b190`, base `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`.

**Inputs inspected:**
- `tools/9router-review/conformance/RESERVATION_STORE_CONTRACT.md` — abstract production contract and RS-01–RS-22 fault-injection requirements.
- `tools/9router-review/conformance/reservation-adapter.contract.test.mjs` — executable reference-oracle tests T01–T56.
- `tools/9router-review/conformance/reference-adapter.mjs` — in-memory reference implementation.
- `tools/9router-review/OPERATIONS.md` — historical protocol, state, recovery and audit decisions.

The T01–T56 suite exercises only the in-memory reference oracle. The production interface in the contract is design pseudocode and is not implemented or type-checked. Mapping a test to a requirement means its title and assertions appear relevant; it does not prove complete semantic coverage or production conformance.

## Coverage vocabulary

- **DIRECT** — test assertions substantially exercise the stated invariant in the reference oracle.
- **PARTIAL** — related behavior is exercised, but at least one fault, boundary, actor, backend, or evidence condition from the requirement is absent.
- **GAP** — no current T01–T56 test directly exercises the requirement in the reference oracle.
- **ORACLE ONLY** — all results are limited to the in-memory test adapter; no durable, cross-process, multi-region, provider, or GitHub behavior is established.

A row may be DIRECT for the reference oracle and still ORACLE ONLY for production qualification.

## A. Test-to-contract traceability (T01–T56)

| Test | Executable test intent (condensed from source) | Contract area / operation | RS mapping | Reference-oracle assessment |
|---|---|---|---|---|
| T01 | 64 concurrent claims; exactly one owner | Claim arbitration; `claim` | RS-01 | DIRECT / ORACLE ONLY |
| T02 | Policy/runtime mismatch does not create second reservation | Immutable policy/runtime attributes; `claim` | — | DIRECT for digest mismatch; not a tuple-digest collision test |
| T03 | Expired pre-attempt lease takeover increments generation; old owner fenced | Lease takeover; fencing; `claim` | RS-03, RS-04, RS-19 | DIRECT in one process; independent-client backend behavior unproven |
| T04 | MODEL boundary rejected without durable ledger INTENT | `beginModelAttempt`; write-ahead ordering | — | DIRECT for missing INTENT; crash between two stores not simulated |
| T05 | MODEL attempt is single-use and requires acknowledgements | `beginModelAttempt`; boundary receipt | RS-05, RS-09 (partial) | DIRECT for single-use; transaction-abort and process-crash paths incomplete |
| T06 | MODEL completion requires generation, attempt, version and ledger outcome | `completeModelAttempt`; fencing | RS-03, RS-10 (partial) | DIRECT for stale/mismatched completion; crash after provider call not simulated |
| T07 | MODEL_ATTEMPTED cannot be reclaimed after lease expiry | No retry after MODEL boundary | RS-05 | DIRECT / ORACLE ONLY |
| T08 | MODEL UNKNOWN cannot be reconciled as COMMENT | `markUnknown`; stage isolation | RS-10 (partial) | DIRECT for state isolation; provider-call crash window not simulated |
| T09 | Completed model continuation increments generation without rerunning model | `resumeCompletedModel` | RS-09 (partial) | DIRECT for oracle continuation; lost process/response recovery not fully modeled |
| T10 | Stale continuation owner cannot consume COMMENT attempt | `beginCommentAttempt`; fencing | RS-03, RS-19 (partial) | DIRECT for stale owner in oracle |
| T11 | COMMENT boundary requires ledger INTENT and snapshot binding | `beginCommentAttempt`; snapshot validation | RS-11 | DIRECT for prerequisite validation |
| T12 | COMMENT attempt is single-use and not reclaimable | COMMENT boundary and retry prohibition | RS-11 | DIRECT / ORACLE ONLY |
| T13 | PUBLISHED requires validated positive EffectLedger outcome | `completeCommentAttempt`; publication evidence | RS-12 (partial) | DIRECT for positive outcome gate; lost GitHub response not simulated |
| T14 | Zero/incomplete comment evidence does not prove non-publication | `reconcileComment`; evidence lattice | RS-13, RS-16 (partial) | DIRECT for tested zero/incomplete cases; real pagination consistency unproven |
| T15 | Multiple distinct positive markers produce DUPLICATE_ACCEPTED | `reconcileComment`; duplicate classification | RS-14 | DIRECT for distinct markers |
| T16 | Abort-before-model and close-after-model remain distinct | `abortBeforeModel`; `closeWithoutPublish` | — | DIRECT for tested state distinctions; production authorization paths unproven |
| T17 | Recovery lock blocks new external-effect permits | Global `RECOVERY_LOCKED`; begin MODEL/COMMENT | RS-16, RS-22 (partial) | DIRECT for oracle permit blocking; cross-vendor outage not modeled |
| T18 | Identical ledger INTENT is idempotent; changed payload rejected | EffectLedger append/idempotency | RS-20, RS-21 (partial) | DIRECT for tested intent identity; backend durability not established |
| T19 | Recovery unlock requires complete independent ledger inventory | Restore gate; trusted anchor and inventory | RS-15, RS-16, RS-22 (partial) | DIRECT for oracle inventory checks; real independent backup/restore not exercised |
| T20 | One exact positive comment is sufficient despite later page unavailability | Positive evidence precedence; `reconcileComment` | RS-13 (partial) | DIRECT for oracle evidence precedence; remote API pagination behavior unproven |
| T21 | HMAC key rotation does not change marker identity | Stable marker derivation and key rotation | — | DIRECT for tested marker derivation; live key-management rotation not exercised |
| T22 | COMMENT UNKNOWN resolves only with positive authenticated evidence | `reconcileComment`; recovery evidence | RS-12 (partial) | DIRECT for oracle positive-evidence rule; real GitHub response ambiguity untested |
| T23 | Lease expiry uses adapter server clock | `claim`; lease evaluation | RS-04 | DIRECT for injected oracle clock; backend clock skew/failover untested |
| T24 | Stale record version cannot renew current lease | `renew`; version CAS | RS-03, RS-19 (partial) | DIRECT for oracle version check |
| T25 | Ledger receipt for another immutable reservation key rejected | Receipt binding; `appendOutcome` | RS-02 (partial only) | DIRECT for cross-key receipt rejection; T54 separately covers injected digest collision in the reference oracle |
| T26 | Positive pre-model marker prevents model dispatch | Preflight reconciliation before MODEL | — | DIRECT for oracle short-circuit; actual `runReview()` integration absent |
| T27 | CLOSED_NO_PUBLISH is terminal and cannot consume COMMENT permit | `closeWithoutPublish`; terminal state | — | DIRECT for oracle terminal-state rule |
| T28 | Outcome identity is immutable for committed attempt | EffectLedger outcome idempotency | RS-20, RS-21 (partial) | DIRECT for tested outcome ID conflict; cross-store duplicate delivery not tested |
| T29 | Changed marker ID for same reservation key is hard conflict | Stable marker identity; reservation integrity | — | DIRECT for oracle marker conflict |
| T30 | COMMENT UNKNOWN remains UNKNOWN without positive evidence | `reconcileComment`; fail-closed absence | RS-13 | DIRECT for oracle no-positive-evidence path |
| T31 | COMMENT deadline expiry becomes UNKNOWN and never retries | COMMENT attempt deadline; retry prohibition | RS-11, RS-12 (partial) | DIRECT for oracle deadline state; real POST crash window absent |
| T32 | Same remote comment on overlapping pages is not a duplicate | Marker pagination de-duplication | RS-14 (partial) | DIRECT for oracle repeated-ID de-duplication; real paginated API untested |
| T33 | RECOVERY_LOCKED blocks reconciliation transitions | Global recovery gate; `reconcileComment` | RS-16 | DIRECT / ORACLE ONLY |
| T34 | Unlock requires independently supplied trusted anchor | Recovery authorization and anchor | RS-15 | DIRECT for oracle trust-anchor requirement |
| T35 | Anchor watermark mismatch rejects unlock | Recovery anchor validation | RS-15 | DIRECT / ORACLE ONLY |
| T36 | Anchor covers complete cross-key ledger inventory | Global inventory completeness | RS-15 | DIRECT for oracle inventory scope; external inventory source unproven |
| T37 | Tampered event rejects unlock even with original anchor | Ledger integrity validation | RS-15 | DIRECT / ORACLE ONLY |
| T38 | Non-contiguous global sequence rejects unlock | Ledger sequence continuity | RS-15 | DIRECT / ORACLE ONLY |
| T39 | Duplicate immutable event IDs reject unlock | Ledger event uniqueness | RS-15 | DIRECT / ORACLE ONLY |
| T40 | Every event digest is verified before anchor acceptance | Ledger digest validation | RS-15 | DIRECT / ORACLE ONLY |
| T41 | Wrong watermark anchor cannot unlock | Anchor-to-inventory binding | RS-15 | DIRECT / ORACLE ONLY |
| T42 | Failed recovery validation never clears lock | Fail-closed recovery | RS-15, RS-16 | DIRECT / ORACLE ONLY |
| T43 | Ordinary mode setter cannot downgrade RECOVERY_LOCKED | Recovery lock privilege boundary | RS-16 | DIRECT for oracle mode guard; external admin separation untested |
| T44 | Recovery lock blocks completion writes | `completeModelAttempt` / `completeCommentAttempt` | RS-16 | DIRECT / ORACLE ONLY |
| T45 | Recovery lock blocks all non-recovery reservation mutations | Global mutation gate | RS-16 | DIRECT / ORACLE ONLY |
| T46 | MODEL INTENT rejects COMMENT-stage outcome | Stage-bound EffectLedger validation | RS-17 (partial only) | DIRECT for stage mismatch; revoked key/authority rotation not tested |
| T47 | COMMENT INTENT rejects MODEL-stage outcome | Stage-bound EffectLedger validation | RS-17 (partial only) | DIRECT for stage mismatch; revoked key/authority rotation not tested |
| T48 | OUTCOME cannot append before authoritative boundary acknowledgement | Receipt-gated ledger append | — | DIRECT for absent boundary receipt; backend transaction abort not tested |
| T49 | OUTCOME requires exact non-transferable committed boundary receipt | Receipt integrity, key/stage/attempt binding | RS-17 (partial) | DIRECT for receipt mutation/replay; live revocation/authority change not tested |
| T50 | Lost boundary ACK recovers same receipt without new permit | `readAttemptBoundaryReceipt` | RS-06, RS-09 | DIRECT for oracle lost-response simulation; durable process restart not proven |
| T51 | COMMENT OUTCOME requires exact COMMENT boundary receipt | COMMENT receipt validation | RS-11, RS-17 (partial) | DIRECT for oracle stage-bound receipt |
| T52 | MODEL helper forwards exact committed receipt to matching outcome | Helper/ledger integration seam | — | DIRECT for helper argument propagation; production `runReview()` integration absent |
| T53 | Different full tuple with one changed immutable SHA creates an independent reference reservation | Canonical full-tuple identity; `claim` and authoritative read | — | DIRECT for full-tuple separation in the reference oracle; no digest collision is injected |
| T54 | Forced digest collision returns `INTEGRITY_CONFLICT`; original tuple retains digest-index ownership; alternate tuple has no hidden record | Digest-index collision detection; `claim` and authoritative read | RS-02 | DIRECT / ORACLE ONLY for injected collision semantics; no production SHA-256 or durable index qualification |
| T55 | Pre-commit MODEL boundary abort: no permit/receipt, unchanged record/ledger, same-intent retry starts sequence 1 | `beginModelAttempt`; pre-commit abort seam and boundary receipt sequence | RS-07 | DIRECT / ORACLE ONLY for pre-write abort; does not simulate rollback after a partial write or durable transaction abort |
| T56 | Pre-commit COMMENT boundary abort: no permit/receipt, unchanged record/ledger, same-intent retry uses next unconsumed sequence | `beginCommentAttempt`; pre-commit abort seam and boundary receipt sequence | RS-07 | DIRECT / ORACLE ONLY for pre-write abort; does not simulate rollback after a partial write or durable transaction abort |

## B. Requirement-to-test coverage (RS-01–RS-22)

| Requirement | Current mapping | Coverage | Missing evidence / falsification still required |
|---|---|---|---|
| RS-01 Independent clients claim one absent key | T01 | PARTIAL | T01 is one in-memory adapter/process. Add two independent clients/processes against the candidate backend and race at a barrier. |
| RS-02 Same digest, different full tuple | T54 forces one digest for two distinct full tuples and proves `INTEGRITY_CONFLICT`, retained original digest-index ownership, unchanged original record/ledger, and no hidden second record; T53 and T25 provide adjacent identity/receipt evidence | PARTIAL | The injected digest callback and index are in-memory reference-oracle mechanisms only. The default is explicitly non-cryptographic. Implement and test the production SHA-256 canonical digest, persistent unique digest index, atomic full-tuple comparison/write, restart behavior, and independent-client collision handling. |
| RS-03 Stale owner after takeover | T03, T06, T10, T24 | PARTIAL | Independent process and backend restart; stale writes across every mutation method, not only sampled paths. |
| RS-04 Lease expiry before any attempt | T03, T23 | PARTIAL | Backend server time under clock skew/failover and concurrent expiry/renew races. |
| RS-05 Lease expiry after MODEL boundary | T05, T07 | PARTIAL | Process crash and competing client after committed boundary; assert no second provider permit. |
| RS-06 Boundary commits but response is dropped | T50 | PARTIAL | Actual durable store, process termination between commit and response, then independent-client receipt recovery. |
| RS-07 Boundary transaction aborts | T55 and T56 inject pre-commit aborts in MODEL and COMMENT respectively; prove no permit/receipt, unchanged reservation/ledger state, and no consumed boundary sequence | PARTIAL | Evidence is limited to the reference oracle's abort hook before the first reservation write. Add a production-store transaction that aborts after each write stage; prove atomic rollback of record, receipt/index, sequence and ledger linkage under backend errors, process loss, and restart. No durable backend transaction has been qualified. |
| RS-08 Crash between ledger INTENT and reservation boundary | T57.1–T57.9 exercise process death/reopen, terminal tombstone + Ledger disposition, inter-store crash, fencing, incomplete reads, existing-boundary recovery, repeated reopen, attempt-start race, and forged evidence in a local SQLite harness | PARTIAL — TEST HARNESS ONLY | Implement the same protocol in selected production ReservationStore/EffectLedger authorities; prove durable receipt/ACK trust, cross-store fencing and idempotency, crash/power-loss and restore behavior, independent failure domains, external-effect interlocks, and `runReview()` integration. No production backend is qualified. |
| RS-09 Crash after boundary ACK, before model call | T05, T09, T50 | PARTIAL | Kill/restart independent process after boundary commit; prove exact receipt recovery and no duplicate permit/inference. |
| RS-10 Crash after provider call, before OUTCOME ACK | T06, T08 | GAP | Fault-inject provider success then process death before OUTCOME; prove MODEL UNKNOWN and no retry. |
| RS-11 Crash after COMMENT boundary, before POST | T11, T12, T31, T51 | PARTIAL | Kill/restart after boundary ACK but before POST; prove no second COMMENT permit. |
| RS-12 GitHub accepts POST, client loses response | T13, T22, T31 (adjacent only) | GAP | Fake GitHub server accepts exactly once then drops response; recovery must reconcile marker evidence and never issue second POST. |
| RS-13 Incomplete marker listing with zero matches | T14, T20, T30 | DIRECT for oracle evidence lattice | Candidate adapter plus realistic paginated/rate-limited GitHub listing; verify zero incomplete results stay UNKNOWN. |
| RS-14 Two distinct exact valid markers | T15, T32 | DIRECT for oracle classification | Validate marker authenticity and distinct remote comment identity under real pagination. |
| RS-15 Reservation restore behind ledger watermark | T19, T34–T42 | PARTIAL | Real backup restore/rollback drill with independent monotonic anchor and full inventory; no production restore evidence exists. |
| RS-16 Ledger unavailable or incomplete | T14, T17, T19, T33–T45 | PARTIAL | Simulate ledger outage, truncated inventory, stale reads and unavailable trust root across independent services. |
| RS-17 Signing key revoked or authority identity changed | T46, T47, T49, T51 (adjacent only) | GAP | Key revocation, authority rotation, trust-root rollover and replay tests; stage mismatch alone is not revocation evidence. |
| RS-18 Provider quota/backend rate limit exhausted | — | GAP | Exhaust/quota-deny each dependency before boundary; prove fail-closed behavior and zero external effects. |
| RS-19 Delayed stale request after generation increment | T03, T10, T24 | PARTIAL | Delay and replay each operation request across real client/process boundaries and confirm fencing at commit time. |
| RS-20 Identical operation ID and payload retry | T18, T28 | PARTIAL | Contract's operation-ID idempotency is not yet mapped to every ReservationStore write; test every method and durable restart. |
| RS-21 Same operation ID, changed payload | T18, T28 | PARTIAL | Cover every operation type, canonicalization, concurrent duplicate submissions and persisted conflict result. |
| RS-22 Cross-vendor outage or partial restore | T17, T19, T33–T45 (adjacent only) | GAP | Exercise independent failure domains and split-brain restore; preserve UNKNOWN/RECOVERY_LOCKED until complete reconciliation. |

## C. Contract method coverage and explicit untested seams

| Production-contract operation | Nearest reference test(s) | Assessment |
|---|---|---|
| `claim` | T01–T03, T23, T26, T53–T54 | Broad oracle coverage; T54 exercises injected collision rejection only; no production interface adapter or durable digest index |
| `renew` | T23–T24 | Oracle-only; server-time and version semantics not distributed |
| `beginModelAttempt` | T04–T05, T48–T50, T55 | Oracle-only; T55 covers pre-commit abort only; durable rollback after partial writes and receipt atomicity remain unqualified |
| `beginCommentAttempt` | T11–T12, T31, T51, T56 | Oracle-only; T56 covers pre-commit abort only; durable rollback after partial writes and remote POST boundary not qualified |
| `readAttemptBoundaryReceipt` | T50, T55–T56 | Oracle-only; abort returns NOT_FOUND in memory; no durable restart or multi-client read |
| `completeModelAttempt` | T06, T08–T09, T44 | Oracle-only; production EffectLedger outcome acknowledgement contract not compiled |
| `completeCommentAttempt` | T13–T15, T20, T22, T32, T44 | Oracle-only; actual GitHub response and pagination evidence absent |
| `resumeCompletedModel` | T09–T10 | Oracle-only; recovery authorization in proposed interface not implemented in reference oracle |
| `abortBeforeModel` | T16 | Oracle-only |
| `markUnknown` | T08, T22, T30–T31 | Oracle-only; recovery authorization in proposed interface not implemented as specified |
| `closeWithoutPublish` | T16, T27 | Oracle-only; dual fence/recovery authorization policy needs exact precedence tests |
| `reconcileComment` | T14–T15, T20, T22, T30, T32–T33 | Oracle-only; listing consistency and remote evidence authenticity not qualified |
| `read` | Read helpers throughout T01–T56 | No explicit production consistency/read-after-write conformance suite |

## D. Hostile review findings against this matrix

1. **No false production-green inference:** the 56 tests are a reference-oracle tranche, not production backend conformance. The matrix labels all such evidence ORACLE ONLY.
2. **Digest alias qualification:** T54 now directly exercises a forced digest collision and full-tuple conflict in the reference oracle. It improves RS-02 from GAP to PARTIAL, but does not prove production SHA-256 indexing, durable uniqueness, or transactional atomicity.
3. **Crash-window and rollback boundary:** T55/T56 demonstrate only pre-commit abort in the in-memory oracle. They do not simulate a transaction abort after any durable write or process death. RS-07 is PARTIAL for oracle pre-commit behavior but remains production-unqualified; RS-08, RS-10 and RS-12 remain GAP.
4. **Trust-root gap:** stage mismatch and receipt mutation are not equivalent to signing-key revocation or authority identity change. RS-17 remains GAP.
5. **Quota gap:** no test proves quota exhaustion fails closed before the provider or GitHub side effect. RS-18 remains GAP.
6. **Cross-vendor gap:** in-memory recovery-lock tests do not qualify independent failure domains, partial restores or cross-vendor reconciliation. RS-22 remains GAP.
7. **False-positive requirement mapping:** T04 (no INTENT), T48 (no boundary receipt), and T52 (receipt propagation) remain adjacent evidence only and do not simulate abort or crash between stores. T55/T56 separately cover MODEL/COMMENT pre-commit aborts in the reference oracle; they do not close durable rollback or RS-08's crash window.
8. **API mismatch:** the proposed production interface has operation IDs, typed ACKs, signed recovery authorization, and explicit ledger acknowledgement types that the reference adapter API does not yet implement as an identical interface. Do not claim interface conformance from behaviorally related tests.
9. **Integration gap:** T26 tests a reference preflight behavior; current `runReview()` still lacks durable reservation integration. No production claim is authorized.

## D2. Additional hostile-review clarification

10. **T53 scope restriction:** T53 demonstrates separation of two distinct full canonical tuples; it remains adjacent evidence only and does not inject a digest collision.
11. **T54 collision-test boundary:** T54 injects a constant digest through a test-only callback and verifies `INTEGRITY_CONFLICT`; while that digest remains active, it confirms the original tuple still owns the index and the alternate remains conflicted. It then switches to a unique diagnostic namespace to detect a hidden alias record. This directly tests collision handling in the in-memory oracle. It does not implement SHA-256, persistence, database uniqueness, or multi-process atomicity; RS-02 remains PARTIAL until those production properties are tested.
12. **T55/T56 abort-test boundary:** both tests inject a pre-commit abort before the first reservation write. They prove the in-memory record, receipt registry, ledger inventory, and boundary sequence remain unchanged and that a known-aborted attempt can retry using the same INTENT. They do not test rollback after partial writes, an actual storage-engine transaction abort, crash recovery, or external calls. RS-07 is PARTIAL and remains a production gate.

## E. Next implementation gate (not authorized by this artifact)

Before any provider adapter is written:
1. Resolve or explicitly defer each production qualification GAP with an accepted risk owner and a falsification plan. RS-08 now has T57.1–T57.9 local SQLite harness evidence (PARTIAL only); RS-08 remains a production qualification blocker. RS-10, RS-12, RS-17, RS-18 and RS-22 remain GAP. RS-02 and RS-07 have reference-oracle PARTIAL evidence but remain production-qualification blockers until durable SHA-256 uniqueness and transactional rollback are proven.
2. Define a canonical operation-ID/idempotency envelope and error-precedence table shared by ReservationStore and EffectLedger.
3. Align the abstract method signatures with the existing reference adapter and T01–T56 harness, or version the conformance contract before implementation.
4. Add production-shaped fault-injection for the missing crash, revocation, quota, durable digest-index collision, and cross-vendor cases. Preserve the original duplicate-publication RED test unchanged.
5. Run two independent clients/processes against a disposable test backend, including restart and restore drills.
6. Obtain an independent hostile review of the adapter, migration, trust-root model, threat model, rollback and evidence.
7. Keep reviewer disabled; do not create resources, change secrets, deploy, merge, or modify `main` without separate explicit authorization.

**Disposition:** TRACEABILITY BASELINE AUTHORED / STATIC SOURCE MAPPING ONLY / MULTIPLE BLOCKING GAPS IDENTIFIED / NO PROVIDER QUALIFIED.


## F. RS-08 hostile-review checkpoint — AR-65

The current reference oracle cannot honestly execute a process-restart test: its reservation records, digest index, ledger INTENT/OUTCOME maps, and boundary receipt registry are process-local Maps allocated inside `createReferenceSystem()`. There is no durable-store injection/reopen API and no orphan-INTENT recovery method. Reconstructing another oracle or copying Maps would not prove persistence, crash recovery, or independent-process behavior.

**Do not treat a missing method/type error as a valid RED test.** Before T57, the protocol must define: globally unique operation/attempt identity and immutable tuple/stage/request binding; an authoritative way to distinguish definitely absent boundary from ambiguous acknowledgement; append-only/idempotent orphan disposition (abandon versus continue); proof that no permit/external effect occurred before continuation; fail-closed behavior for unavailable/stale/incomplete reads; concurrent recovery fencing; and durable read-after-write/reopen guarantees for both stores.

**Safety rule:** no receipt found in a process-local cache, timeout, or unavailable store is not evidence of non-commit. Ambiguous state remains quarantined; recovery must not authorize model/provider execution or GitHub publication.

**T57 acceptance gate (not implemented):** durable INTENT ACK → terminate before boundary invocation → reopen both stores in an independent process → recover the same operation identity → prove one idempotent orphan disposition and no boundary/permit/external effect → repeat concurrently and after restart → verify no duplicate ledger terminal event and no mutation on incomplete reads.

RS-08 remains **GAP**. No test result or production qualification is claimed. This checkpoint is a protocol/design gate, not a substitute for T57.


## G. RS-08 Orphan-INTENT recovery protocol draft — AR-66 (historical checkpoint; superseded by AR-67)

Design contract: `tools/9router-review/conformance/ORPHAN_INTENT_RECOVERY_CONTRACT.md`.

- Contract status is **PROPOSED / NOT RATIFIED / NOT IMPLEMENTED**. It defines immutable operation identity, durable evidence interfaces for both stores, recovery states, read-only reconciliation, monotonic fencing, idempotent append-only dispositions, fail-closed handling of incomplete/ambiguous evidence, failure semantics, T57 independent-process acceptance criteria, and fault-injection cases.
- The conservative proposal quarantines ambiguous evidence. For a definitively absent boundary, it intentionally does not choose automatic abort or automatic continuation. Both are externally observable policy decisions and remain subject to explicit user ratification.
- Static hostile review checked all 12 contract sections, absence of TBD/TODO/FIXME placeholders, quarantine on unknown/incomplete reads, no automatic permit/external effect, and independent writer/recovery/recovery-after-lost-ack process sequence.
- The current reference oracle remains process-local and cannot satisfy T57. No process restart, durable backend, independent process, or RED/GREEN test was run. This is design evidence only.
- **RS-08 remains GAP.** T57 is not implemented. No production qualification is implied.


## H. RS-08 terminal orphan-INTENT abort decision — AR-67

Decision record: [ADR-001](ADR-001-ORPHAN-INTENT-TERMINAL-ABORT.md). Status: **ACCEPTED POLICY / IMPLEMENTATION NOT YET VERIFIED**.

- A definitively absent boundary is terminally aborted; ambiguous or incomplete evidence remains quarantined; a committed boundary is reconciled by returning its exact existing receipt.
- The deny-side ReservationStore tombstone MUST commit before the unique append-only EffectLedger ORPHAN_INTENT_ABORTED terminal event. The tombstone permanently blocks the exact operation/attempt ID from obtaining a permit. Recovery after a crash between stores appends the same ledger event idempotently.
- This policy does not authorize resume/retry of the same attempt ID, provider dispatch, or GitHub publication.
- T57 is staged as: durable INTENT + process death/reopen; terminal tombstone + ledger event; crash between stores; two-process fencing; incomplete-read quarantine and late-permit rejection; repeated restart and exact-head regression.
- The durable implementation, independent-process evidence, and full T57 acceptance run are pending. RS-08 remains **GAP**; no production backend is qualified.


## I. T57 staged execution ledger — AR-69 (supersedes AR-68 status table)

| Test | Required assertion | Observed evidence | Harness status |
| --- | --- | --- | --- |
| T57.1 | Durable INTENT ACK survives writer process termination and independent-process reopen; no boundary call occurred | Two file-backed SQLite databases; writer exited after ACK with injected exit code 73; independent reader verified exact event ID, operation ID, payload and SHA-256 digest, plus zero boundaries | PASS |
| T57.2 | Terminal tombstone and final Ledger event are unique; exact attempt cannot receive a late permit; repeat recovery preserves IDs | Separate worker processes; exactly one tombstone and one `ORPHAN_INTENT_ABORTED`; late `beginAttempt` rejected | PASS |
| T57.3 | Crash after tombstone commit and before final Ledger append converges idempotently after reopen | Recovery worker terminated with injected exit code 74 after tombstone ACK; next independent process appended exactly one final event bound to the same tombstone | PASS |
| T57.4 | Stale recovery fencing generation cannot mutate after takeover | One process held generation 1; stale recovery expected generation 0 and was rejected; current worker acquired generation 2; original stale process could not append its delayed tombstone | PASS |
| T57.5 | Incomplete ReservationStore and EffectLedger reads quarantine without any mutation | Both incomplete-read paths returned `RECOVERY_QUARANTINED`; tombstone, ledger events, fence and counts remained unchanged | PASS |
| T57.6 | If boundary is already committed, recover exact receipt and do not abort | Existing test permit/receipt returned identically; tombstone count and final abort event stayed zero | PASS |
| T57.7 | After a second independent reopen, terminal identity and ledger watermark remain unchanged | Same tombstone ID, final event ID/digest, one INTENT, one final event, same high-water mark, zero permit/boundary | PASS |
| T57.8 | Independent process attempt-start and orphan-abort race yields exactly one terminal outcome | Two worker processes raced; SQLite write serialization and boundary re-check yielded either permit+boundary with no tombstone/event, or tombstone+terminal event with no permit/boundary | PASS — see RED→GREEN note |
| T57.9 | Forged tombstone ACK, altered immutable tuple and changed request payload fail closed | Forged receipt digest rejected without ledger mutation; same operation ID with altered tuple or request digest returns integrity conflict | PASS |

**Fresh execution evidence:** the complete T57.1–T57.9 suite ran three consecutive times under Node.js `v22.16.0`; each run observed **9 tests / 9 passed / 0 failed**. Four source files passed `node --check`. T57.8 additionally passed 10 consecutive focused race probes after the snapshot fix. These are isolated local SQLite harness results, not hosted Actions evidence.

### T57.8 RED→GREEN record

The initial adversarial runs exposed:
1. Missing `receipt_json` in the boundary-race SELECT projection, which caused recovery to fail to return a committed receipt.
2. Reissuing WAL mode configuration on each open, which caused `database is locked` under simultaneous worker startup.
3. A fractured read: boundary existence and permit counts came from separate autocommit snapshots, allowing a concurrent commit to be misclassified as `INTEGRITY_CONFLICT`.

The corrections add the receipt column to the race SELECT, configure WAL only if not already active, set busy timeout before mode inspection, and read boundary/count evidence in one SQLite read transaction. Ledger history and its high-water mark are also read within one snapshot. No test assertion was removed or weakened.

### Production evidence boundary

All nine results are **PARTIAL / TEST-HARNESS ONLY**:
- The adapter uses two local SQLite files on the same runner and does not qualify the eventual selected ReservationStore or EffectLedger.
- Its receipt and evidence hashes are not signatures, independent attestations, or trust-root proofs.
- Its fence is a generation-CAS model; worker authentication, lease expiry and real recovery authority are not qualified.
- Its permit is a test-only row; no model/provider call, GitHub POST, or production external effect is wired.
- No machine/power-loss test, independent backup/restore, cross-vendor outage, production quota/failover or `runReview()` integration is included.
- Hosted workflow results for the push commit were not available through the retrieved workflow/status interface.

Consequently RS-08 has moved from no direct crash-window tests to **PARTIAL test-harness evidence**, but remains a **PRODUCTION QUALIFICATION GAP**. No backend is qualified.

The full reviewer regression’s known deterministic duplicate-publication race remains a separate RED and was neither edited nor suppressed.
