# EGIS-FM-007 — TLC Output Validator Hostile Review v1.1.1

**Status:** Candidate / CI verification pending  
**Date:** 2026-11-25  
**Scope:** TLC text-output validator and its integration into the EGIS verification gate  
**Parent:** PR #475; stacked on EGIS operation-composition v1.1.0

## Contract under review

The validator must reject a TLC run as PASS unless all of the following are present and unambiguous:

1. TLC process exit code is zero and the run did not time out.
2. A non-empty, unique expected invariant inventory is extracted from the supplied TLC configuration.
3. Exactly one invariant-check marker exists and its count equals the configured inventory size.
4. Exactly one explicit TLC completion/no-error summary exists.
5. Exactly one state-count summary exists.
6. Generated states are not fewer than distinct states and queued states are zero.
7. No known TLC error, invariant violation, deadlock, or counterexample marker is present.

The gate includes validator status in the aggregate result; process exit code alone is insufficient.

## Implementation added

- `verification/formal/egis/tools/egis_tlc_output_validator.py`
- Gate integration in `egis_tla_gate.py`
- Hostile fixtures in `test_tla_gate.py`
- CI compile coverage for the validator module.

The validator returns structured status/reason and extracted counts. Missing or ambiguous evidence is BLOCKED; explicit violations, non-zero exit, timeout, count mismatch, or inconsistent counts are FAIL.

## Hostile findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-065 | High | TLC textual output format can vary by TLC release; no real fixture from the pinned release is available. | Open; obtain and pin a real output fixture before operational reliance. |
| FMH-066 | High | The validator cross-checks the number of checked invariants against the config inventory, but does not independently recover each invariant name from TLC output. | Residual limitation; bind the exact config by digest and command evidence; do not claim per-name proof. |
| FMH-067 | High | Text output can be forged or replaced after process execution; parser success is not artifact authenticity. | Open; signed/attested execution evidence and immutable retention required. |
| FMH-068 | Medium | Config inventory extraction accepts only one invariant name per exact INVARIANT line. Unsupported formatting yields an empty inventory and BLOCKED, not PASS. | Fail-closed by design; broaden only with fixtures and tests. |
| FMH-069 | Medium | The summary parser is a textual heuristic and may reject valid TLC output or miss a novel error marker. | Open; version-pinned fixtures, mutation corpus, and differential parser review required. |
| FMH-070 | Medium | Mocked subprocess tests do not prove the actual TLC executable emits the assumed marker grammar or that trace artifacts are retained. | Open; controlled real-tool execution and trace-capture verification required. |

## Test evidence and TDD record

- The first CI run after adding the validator tests executed 24 tests: 23 passed, 1 failed.
- The failure was in the test fixture: the configuration sample encoded literal backslash-n sequences instead of real line breaks. The parser correctly returned an empty inventory.
- The fixture was corrected to a true multiline configuration string; the assertion was retained.
- The follow-up CI run on the corrected exact head is pending at report creation.
- Because the initial test failure was a fixture defect rather than a demonstrated production-code defect, no claim is made that the validator implementation itself completed a red-green production fix cycle.

## Verification boundaries

- Unit tests use synthetic TLC output. They do not constitute SANY/TLC execution.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Real output fixture compatibility: NOT_ESTABLISHED.
- Mutation/differential parser testing: NOT_RUN.
- Evidence attestation: NOT_IMPLEMENTED.
- Implementation conformance: NOT_ESTABLISHED.

## Promotion decision

**NOT READY FOR MERGE OR PROMOTION.** The validator is an additional fail-closed guard for the formal-model runner, not formal proof. It cannot independently authenticate logs or prove that the model corresponds to the deployed implementation.

## Required next atomic increment

1. Confirm CI on the corrected exact head and resolve any failures.
2. Acquire a real, independently verified TLC output fixture from the exact pinned tool release.
3. Add mutation cases for missing/truncated/duplicated summaries, fabricated success markers, invariant-count drift, and trace/error markers.
4. Add Java/TLC runtime provenance and signed/attested evidence.
5. Re-run full hostile review and preserve the unclassified historical Gitleaks findings.

## Safety boundary

Draft candidate only. No merge, deployment, runtime, main branch, secrets, bindings, permissions, or laptop changes.
