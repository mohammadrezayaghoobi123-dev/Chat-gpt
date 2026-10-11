# Master Brain — Offline CTP Code Review
**Date:** 2026-10-11  
**Branch:** `master-brain/integrated-mvp`  
**Scope:** Read-only review of the recovered standalone CTP prototype archive. No OpenClaw environment or original project workspace was accessed or modified.

## 1. Reproducible checks
- Archive SHA-256: `38c778b2006a87de17275aeb5b467526d9ca71b566366fc95476afeb6c3957e9`.
- ZIP has 13 entries.
- Internal `MANIFEST.sha256`: 9/9 listed files match.
- `python -m py_compile ctp_engine.py`: exit code 0.
- `python -m unittest discover -s tests -v`: 31 tests passed, 0 failed.
- CLI `demo`: exit code 0; output labels itself `FIXTURE_ONLY_NOT_LIVE_EVIDENCE`.
- CLI `analyze fixtures/claims_example.json`: exit code 0; result is candidate conflict analysis only.
- CLI `suite`: exit code 0; all 21 MB-PROOF-002A cases explicitly remain `NOT_RUN` against `recovered_live_master_brain`.
- The Python runtime emitted a spreadsheet-warmup traceback to stderr before these commands, but each command itself returned exit code 0 and the expected output was parseable. Treat this as environment noise requiring isolation if strict CI output cleanliness is later required, not as a CTP test failure.

## 2. What the prototype actually does
- Validates caller-supplied claim records and compares claims only when they share a supplied `proposition_id`; context fields are expected to be normalized by the caller.
- Labels opposite-polarity claims under matching supplied context as a *candidate* contradiction, not a truth determination.
- Provides conservative verdict gates for partial support, counterexamples, formal proof, empirical replication, independent confirmation, and real-world validation.
- Provides a test-priority heuristic and an in-memory hash-linked audit ledger.
- Uses the Python standard library and does not contain live provider/model orchestration in this package.

## 3. Limitations to preserve in future work
1. **No semantic claim normalization.** The caller must provide proposition IDs, polarity, scope, definitions, conditions, quantifier and time scope. Surface-language equivalence and natural-language contradiction are not detected.
2. **Evidence trust is caller-asserted.** Flags such as `verified`, `independent_ground_truth`, `proof_checker_passed`, `counterexample_validated` and source-family identifiers are data fields; this package does not authenticate the people, sources, environments or truth behind them.
3. **No live execution of the proof suite.** The 21 MB-PROOF-002A rows are registry/specification records, not executed tests of the recovered Master Brain.
4. **Audit ledger is not durable storage.** It is in-memory; JSONL export uses create-only file mode but is not an immutable store, authenticated event log or external timestamp. The hash chain is tamper-evident only relative to a trusted prior digest.
5. **Run metadata validation is structural.** Hash strings and numeric metrics are checked, but the class cannot establish that the supplied hashes correspond to the actual code/config/data or that timestamps/environment claims are true.
6. **No production security boundary.** The prototype is not a permission gateway, multi-tenant service, secrets manager, durable evidence database or controlled self-repair executor.

## 4. Review disposition
**Keep as a verified experimental component; do not promote it to production or treat it as the recovered Master Brain.** Its strongest value is as a small, deterministic specification aid for conservative verdict gating and test design.

## 5. Next engineering order
1. Continue source recovery through accessible artifacts and historical records; original ~3,000-line implementation remains `INACCESSIBLE / RECOVERY PENDING`, not confirmed lost.
2. When the original becomes accessible under the existing no-live-reconnection constraint, snapshot and hash before inspection.
3. Build a source-to-architecture map before merging or replacing any module.
4. Only then adapt CTP interfaces to the recovered contracts, add tests for the actual integration points, and run MB-PROOF-002A with independently governed ground truth.

**Preservation:** No source edits, resets, deletions, credential revocations, or live environment changes were performed.
