# EGIS-FM-005 — Verification Gate Hostile Review v1.1.1

**Status:** Draft candidate; verification execution NOT_RUN  
**Scope:** `egis_tla_gate.py`, gate unit tests, evidence contract  
**Date:** 2026-11-25

## Disposition

The gate is designed to fail closed and avoid downloading dependencies. It requires a clean Git checkout at an expected commit, an explicitly SHA-256-pinned TLA+ tool jar, exact model/config inputs, and sequential SANY then TLC execution. Evidence is atomically replaced as JSON.

No actual SANY or TLC run is claimed. The Python unit tests were authored but execution in the repository environment remains NOT_RUN; they rely on mocked Git identity and mocked tool command outcomes.

## Hostile findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| FMH-046 | Critical | A PASS could previously be detached from the intended source revision or dirty working tree | Fixed in candidate: expected commit and clean-tree identity required |
| FMH-047 | High | A tool jar could be substituted without provenance | Fixed in candidate: mandatory SHA-256 pin and actual digest recorded |
| FMH-048 | High | Evidence lacked module/config content digests | Fixed in candidate: SHA-256 digests recorded for both inputs |
| FMH-049 | High | SANY failure could otherwise allow TLC or a combined PASS | Fixed: TLC is BLOCKED unless SANY returns PASS |
| FMH-050 | High | Missing inputs/tool and unavailable executable could be misclassified as success | Fixed by explicit BLOCKED/FAIL statuses and exit code checks |
| FMH-051 | High | Tool timeout must never become PASS | Fixed: timeout maps FAIL |
| FMH-052 | Medium | Evidence could be partially written on interruption | Mitigated: temp-file write followed by replace; filesystem atomicity assumptions remain |
| FMH-053 | Medium | Gate output can be forged or replaced after execution | Open: CI artifact attestation/signing and immutable retention are not implemented |
| FMH-054 | Medium | Tool/runtime version provenance is digest-only for jar; Java runtime identity is not captured | Open: record Java version and execution environment metadata |
| FMH-055 | High | Mocked unit tests are not real tool runs and do not establish gate/model validity | Open/blocking: execute tests on exact commit; execute SANY/TLC on exact commit |
| FMH-056 | High | TLC exit status alone is not an independent proof artifact; trace completeness and invariant list must be inspected | Open: parse TLC summary, require explicit expected invariants, archive complete output and states |
| FMH-057 | High | No independent evaluator, mutation testing, or differential comparison is included | Open: separate follow-on verification stage |\n| FMH-058 | High | Static inspection detected invalid Python line-continuation escaping in the first test draft | Fixed in candidate: replaced multi-context line continuations with nested context managers; execution remains NOT_RUN |\n| FMH-059 | Medium | Mocked SANY failure fixture had an incorrect stdout key | Fixed in candidate: corrected fixture key; tests still NOT_RUN |

## Test design

The unit tests cover source commit mismatch, dirty source, tool hash mismatch, missing tool/input, SANY failure blocking TLC, successful mocked SANY+TLC, TLC failure, timeout, evidence digests, and atomic evidence replacement.

Test execution: NOT_RUN. Mutations: NOT_RUN. SANY/TLC: NOT_RUN.

## Promotion rule

Gate result PASS means only that the gate recorded a clean expected source commit, matched the caller-pinned jar hash, and both tool commands returned zero. It must not be interpreted as production implementation conformance, independent verification, cryptographic artifact attestation, or distributed exactly-once semantics.

Do not merge or promote until exact-source gate tests run, SANY/TLC complete on the exact pinned commit, output is independently inspected, mutation/differential tests are executed, and the artifact-attestation gap is addressed or explicitly accepted by an authorized reviewer.
