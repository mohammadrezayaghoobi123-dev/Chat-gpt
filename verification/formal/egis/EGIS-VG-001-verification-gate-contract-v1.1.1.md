# EGIS-VG-001 — Formal Verification Gate Contract v1.1.1

**Status:** Candidate / NOT_VERIFIED  
**Evidence schema:** 1.2  
**Date:** 2026-11-25

## Purpose

Provide a reproducible fail-closed runner for SANY parsing and TLC model checking of the EGIS TLA+ model. This gate is a formal-model gate only; it does not verify runtime implementation conformance.

## Required inputs

- Repository checkout root.
- Expected Git commit SHA; checkout must be clean.
- Exact TLA+ module and TLC configuration files.
- TLA+ tool jar path and caller-supplied SHA-256 digest.
- Java executable available in PATH or configured by JAVA environment variable.
- Output evidence path and bounded timeout.

No dependency download or tool installation is performed by the gate.

## Status semantics

- PASS: source identity and cleanliness pass, tool digest matches, SANY exits zero, TLC exits zero, and the independent TLC output validator confirms one unambiguous completion summary, the expected invariant-check count, internally consistent completed state counts, and the required marker order.
- FAIL: expected commit mismatch, dirty tree, tool digest mismatch, command non-zero, timeout, invariant-count mismatch, TLC error/violation marker, invalid numeric fields, or inconsistent state counts.
- BLOCKED: source metadata, required inputs, tool jar, or executable unavailable; TLC blocked if SANY has not passed; malformed/ambiguous evidence without a confirmed violation. A command may have gate status BLOCKED with process_outcome UNKNOWN if the child started but complete output/exit status could not be captured. This must not be interpreted as NOT_STARTED, PASS, or model FAIL. Git source identity records contain sanitized `commands.rev_parse` and `commands.status` lifecycle summaries. The status command is NOT_RUN if `rev_parse` did not complete successfully. If `rev_parse` completes but status cannot be obtained, the known commit is retained while source identity remains BLOCKED.
- NOT_RUN: an execution/validation stage was not invoked because its required predecessor result was unavailable or failed. A status may never be promoted to PASS based on missing evidence.

## TLC output validation

The parser requires exactly one marker of each type and enforces this order:

1. Invariant check marker with count equal to the configured inventory.
2. TLC completion summary: `Model checking completed. No error has been found.`
3. State-count summary with generated states >= distinct states and zero queued states.

Configured invariant names must be non-empty, unique identifiers. Unknown config syntax yields an empty inventory and BLOCKED. Numeric conversion errors fail closed. The validator checks the invariant count, not independent per-name execution evidence.

This is a version-sensitive textual parser. The marker grammar and ordering have not yet been validated against a real output fixture from the exact pinned TLC release. Therefore, synthetic tests are only parser regression tests, not operational compatibility evidence.

## Evidence schema

The JSON evidence contains schema version, UTC timestamp, gate identity, expected source commit, module/config paths and digests, tool path and expected/actual digest, source identity status, command arguments, exit codes, stdout/stderr, per-check statuses, TLC output-validation result, expected invariant inventory, checked invariant count, generated/distinct/queued state counts, and overall status.

Schema 1.2 command records preserve the existing `status`, `exit_code`, `stdout`, `stderr`, and `command` keys and add `reason`, `phase`, `error_type`, `errno`, `process_started`, `process_outcome`, and `process_cleanup`. `process_outcome` is one of `NOT_STARTED`, `UNKNOWN`, `EXIT_ZERO`, `EXIT_NONZERO`, or `TIMED_OUT`. `process_cleanup` is one of `NOT_STARTED`, `REAPED`, or `UNKNOWN`. `REAPED` requires both a confirmed child wait/reap and closure of parent-owned stdout/stderr pipe handles; a wait timeout, wait error, or pipe-close failure yields `UNKNOWN`. Error diagnostics are bounded and omit raw exception messages and filename/path fields. Process-start failures map to BLOCKED; communication failures after process start map to BLOCKED with `process_outcome=UNKNOWN`; timeout and nonzero exit remain FAIL.

Evidence is written to a temporary file in the target directory and then replaced atomically. This does not establish artifact authenticity or tamper resistance after creation.

## Command

From repository root, use the exact commit and approved tool digest:

```bash
python verification/formal/egis/tools/egis_tla_gate.py \
  --root . \
  --jar /approved/path/tla2tools.jar \
  --sha256 <approved-64-hex-digest> \
  --expected-commit <exact-40-hex-commit> \
  --module verification/formal/egis/EGIS_OperationComposition_v1_1_0.tla \
  --config verification/formal/egis/EGIS_OperationComposition_v1_1_0.cfg \
  --output artifacts/egis-tla-gate.json
```

The expected tool digest and source commit must come from independently approved provenance. Do not copy a digest from an untrusted artifact or use a mutable latest-release tag.

## Unit-test command

From repository root:

```bash
PYTHONPATH=verification/formal/egis/tools python -m unittest discover -s verification/formal/egis/tests -p 'test_tla_gate.py' -v
```

The suite mocks Popen process execution and tests synthetic TLC output fixtures; it verifies process lifecycle classification, gate control flow and parser rejection conditions, not real SANY/TLC behavior. The gate invokes the TLC output validator only when TLC has a complete PASS process result (`process_started=true`, `process_outcome=EXIT_ZERO`, `process_cleanup=REAPED`). A TLC BLOCKED/UNKNOWN result leaves validation NOT_RUN; a process that never started leaves validation BLOCKED; a TLC FAIL leaves validation NOT_RUN and overall FAIL.

## Current verification status

- First hardening attempt exposed a regex escaping defect (7/29 tests failed); corrected and passed 29/29 on the earlier code head.
- FMH-074 test-only run exposed an uncaught 5,000-digit invariant-count conversion; parser fix catches the conversion and returns FAIL.
- Latest exact PR-head CI run `45554166694` on `de853df55bd863cf818fddb055feb8d63e7210b1`: compileall PASS; 30/30 tests PASS.
- Latest exact PR-head Gitleaks run `45554157983`: PR-diff PASS; full-history FAIL with 13 unclassified findings across 5,214 commits.
- TLA+ tool availability: NOT_ESTABLISHED.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Real TLC output fixture compatibility: NOT_ESTABLISHED.
- Mutation/differential tests beyond committed hostile fixtures: NOT_RUN.
- Evidence attestation: NOT_IMPLEMENTED.
- Java/runtime provenance: NOT_IMPLEMENTED.

## Promotion decision

**NOT READY FOR MERGE OR PROMOTION.** The gate remains NOT_VERIFIED until real SANY/TLC execution succeeds with an independently pinned tool, real output compatibility is established, and evidence integrity is independently addressed.

## Safety boundary

Draft candidate only. No merge, deployment, runtime, main branch, secrets, bindings, permissions, branch retargeting, or laptop changes.
