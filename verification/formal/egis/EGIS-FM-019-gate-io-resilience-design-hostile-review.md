# EGIS-FM-019 — Atomic Gate I/O Design Hostile Review

**Status:** Written-spec review complete with one OPEN input-stability residual; implementation NOT_STARTED pending user review
**Date:** 2026-11-25
**Target:** PR #475, EGIS Gate I/O Resilience Atomic Design v2
**Reviewed baseline:** fc31619f3bec26fae3fd82c6e4f1257f5998ce6c
**Scope:** Five atomic TDD stages A1, A2, B1, B2 and B3

## 1. Decision

Revision 2 materially improves engineering control: it decomposes the work into five independently testable atoms, limits executable scope to the gate and its tests, requires RED/GREEN commit pairs, moves config and invariant validation before Java execution, protects evidence paths, defines typed persistence failures, and keeps the EGIS workflow, runtime, main branch and local workstation outside the implementation boundary.

Hostile review found an ambiguous process outcome representation, a high-severity input hash-to-use residual, and an inconsistent documentation/schema commit boundary. The current spec has been amended to add explicit process_started/process_outcome metadata, pre/post input identity/digest checks and a read-only snapshot assumption, and to make EGIS-VG-001 update atomic with the A1 schema bump. FMH-120 remains OPEN.

## 2. Findings

| ID | Severity | Finding | Required control | Disposition |
|---|---|---|---|---|
| FMH-120 | High | Module/config/JAR bytes are hashed before Java reopens them by path. Concurrent mutation between hashing and consumption can make evidence hashes describe bytes different from those actually parsed. | Record initial identity/digests, recheck before each Java launch and after execution; persistent mutation prevents PASS. Explicitly state that checks do not exclude transient ABA changes. Hostile concurrent writers require immutable snapshot support before PASS. | OPEN residual retained in design |
| FMH-121 | High | A child may start, then result capture can fail. A gate BLOCKED status without separate command outcome metadata may be misread as the child never having run. | Add process_started and process_outcome fields. For post-start result-capture failure, gate status remains BLOCKED but process_outcome is UNKNOWN and phase=communicate. Never claim no execution, success or model failure. | Corrected in revised spec |
| FMH-122 | Medium | Cleanup was previously bounded without a fixed upper limit. | One total cleanup deadline of five seconds; record cleanup state and do not start dependent processes if reaping is unconfirmed. | Corrected in revised spec |
| FMH-123 | Medium | B3 described the EGIS-VG contract update as a separate docs-only commit, conflicting with A1's requirement to update schema 1.2 and the contract atomically. | A1 GREEN updates gate code, tests and EGIS-VG-001 in one commit; B3 does not change schema; the design document remains docs-only. | Corrected in revised spec |
| FMH-124 | Low | B3 repeated list numbers 9 and 10 after the typed CLI failure contract. | Renumber the final fsync/schema clauses sequentially. | Corrected in revised spec |

## 3. Cross-atom hostile checks

- Process creation OSError is distinct from post-start communication OSError.
- Post-start result capture failure keeps gate status BLOCKED but records process_started=true and process_outcome=UNKNOWN; this is not treated as not-started, PASS or model FAIL.
- Cleanup is bounded by a total five-second deadline; uncertain reaping blocks dependent stages.
- Input identity/digests are checked before each Java launch and after execution. Persistent mutation prevents PASS; transient ABA is not excluded.
- EGIS-VG schema 1.2 is updated atomically with A1 GREEN; no intermediate schema/documentation mismatch is permitted.
- Output alias checks precede Git metadata and Java subprocesses.
- Typed path and persistence errors carry stable reason codes and errno metadata only; raw paths and exception reprs are excluded.

## 4. Residual and user-review gate

FMH-120 remains OPEN. Pre/post file identity and digest checks detect persistent mutation but do not prove immutable snapshot isolation against transient ABA changes. PASS is conditional on a caller-provided read-only stable snapshot for the entire invocation. If hostile concurrent input writers are in scope, immutable snapshot support is required before promotion.

Revision 2 explicitly requires user review before implementation. This hostile review and its documentation corrections do not authorize starting A1. After user approval, execute A1 through B3 in order, each with its own test-only RED commit, bounded GREEN commit, exact-head Python 3.11 CI, hostile review and no force updates.

No implementation code was changed in this review. No Ant/JDK acquisition, build, JAR creation, real SANY/TLC execution, runtime operation, deployment, merge, main-branch change or local workstation change was performed.
