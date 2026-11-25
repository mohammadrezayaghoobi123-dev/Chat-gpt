# EGIS-FM-007 — TLC Output Validator Hostile Review v1.1.1

**Status:** Candidate / exact-head mocked CI verified; real TLC compatibility NOT_ESTABLISHED  
**Date:** 2026-11-25  
**Scope:** TLC text-output validator and its integration into the EGIS verification gate  
**Parent:** PR #475; stacked on EGIS operation-composition v1.1.0

## Contract under review

The validator rejects PASS unless the TLC process exits zero without timeout, the configured invariant inventory is non-empty/unique/valid, exactly one invariant-check marker matches its size, exactly one completion summary exists, exactly one state-count summary exists, and the evidence markers occur in this order:

`invariant-check < completion-summary < state-count-summary`

Generated states must be greater than or equal to distinct states, queued states must be zero, and no recognized error/violation/deadlock/counterexample marker may occur.

## Implementation

- `verification/formal/egis/tools/egis_tlc_output_validator.py`
- Gate integration in `egis_tla_gate.py`
- Hostile fixtures in `test_tla_gate.py`
- CI compile coverage for both modules.

The validator distinguishes unavailable executable (BLOCKED), timeout (FAIL), and non-zero exit (FAIL). Invalid inventory and malformed numeric fields fail closed.

## Hostile findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-065 | High | TLC textual output varies by release; no real fixture from the pinned release is available. | Open; acquire and pin a real fixture. |
| FMH-066 | High | Count validation does not independently recover each invariant name from TLC output. | Residual limitation; no per-name proof claim. |
| FMH-067 | High | Text output can be forged or replaced; parser success is not artifact authenticity. | Open; signed/attested execution evidence and immutable retention required. |
| FMH-068 | Medium | Config inventory extraction accepts one identifier per exact INVARIANT line. | Fail-closed; unsupported formats block. |
| FMH-069 | Medium | Text parsing is heuristic and may reject valid output or miss novel error markers. | Open; version-pinned fixtures and mutation corpus required. |
| FMH-070 | Medium | Mocked subprocess tests do not prove actual TLC output grammar or trace retention. | Open; controlled real-tool execution required. |
| FMH-071 | Medium | Missing TLC executable was classified FAIL rather than BLOCKED. | Fixed; unavailable process is BLOCKED, timeout/non-zero exit remain FAIL. |
| FMH-072 | High | The parser accepted success and state-count markers in an impossible order. | Fixed in candidate; enforce invariant-check < completion < state-count and add hostile tests. |
| FMH-073 | Medium | Invalid inventory entries and oversized numeric fields could cause unsafe behavior. | Fixed in candidate; validate identifier type/syntax before uniqueness and fail closed on numeric conversion errors. |

## Test evidence and TDD record

- Previous exact head `84de51d1cca8cfe3d3462175236875f7f1e4a02d`: compileall PASS; 25/25 tests PASS.
- Adversarial tests were added on `a8b1b252f254dab235dfb098d48197a7aedc552f` for marker ordering, malformed inventories, and oversized numeric fields.
- The validator was then changed to enforce strict marker ordering and validate inventory entries before uniqueness checks.
- The oversized-number conversion is guarded and returns FAIL rather than propagating an exception.
- CI for the final remediation commit is pending; no final red/green claim is made until exact-head CI completes.

## Verification boundaries

- Tests use synthetic TLC output and mocked subprocess calls; they are not SANY/TLC execution.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Real TLC release fixture compatibility: NOT_ESTABLISHED.
- Mutation/differential testing beyond committed hostile fixtures: NOT_RUN.
- Evidence attestation: NOT_IMPLEMENTED.
- Java/runtime provenance: NOT_IMPLEMENTED.
- Implementation conformance: NOT_ESTABLISHED.
- Historical Gitleaks scan on prior head `84de51d1cca8cfe3d3462175236875f7f1e4a02d`: PR-diff PASS; full-history FAIL with 13 unclassified generic-api-key findings. Exact-head Gitleaks run `45553843545`: PR-diff scan PASS (1 commit, 498 bytes, no leaks); full-history scan FAIL (5,200 commits, 15.89 MB, 13 findings). Findings remain unclassified; no suppression or credential changes performed.

## Promotion decision

**NOT READY FOR MERGE OR PROMOTION.** The validator is an additional fail-closed guard for the formal-model runner, not formal proof. It cannot authenticate logs or prove model-to-implementation conformance.

## Required next atomic increment

1. Confirm CI on the corrected exact head and resolve failures.
2. Acquire a real, independently verified TLC output fixture from the exact pinned tool release.
3. Add version-pinned trace/error mutation cases and verify trace capture.
4. Add Java/TLC runtime provenance and signed/attested evidence.
5. Classify historical Gitleaks findings against exact source content; do not suppress without evidence.

## Safety boundary

Draft candidate only. No merge, deployment, runtime, main branch, secrets, bindings, permissions, branch retargeting, or laptop changes.
