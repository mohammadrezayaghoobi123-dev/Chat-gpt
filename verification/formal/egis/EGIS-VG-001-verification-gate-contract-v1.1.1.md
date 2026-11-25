# EGIS-VG-001 — Formal Verification Gate Contract v1.1.1

**Status:** Candidate / NOT_VERIFIED  
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

- PASS: source identity and cleanliness pass, tool digest matches, SANY exits zero, TLC exits zero, and the independent TLC output validator confirms one unambiguous completion summary, the expected invariant-check count, and internally consistent completed state counts.
- FAIL: expected commit mismatch, dirty tree, tool digest mismatch, command non-zero, timeout, invariant-count mismatch, TLC error/violation marker, or inconsistent state counts.
- BLOCKED: source metadata, required inputs, tool jar, or executable unavailable; TLC blocked if SANY has not passed.
- NOT_RUN: initial/unexecuted state only. A status may never be promoted to PASS based on missing evidence.

## Evidence schema

The JSON evidence contains schema version, UTC timestamp, gate identity, expected source commit, module/config paths and digests, tool path and expected/actual digest, source identity status, command arguments, exit codes, stdout/stderr, per-check statuses, TLC output-validation result, expected invariant inventory, checked invariant count, generated/distinct/queued state counts, and overall status.

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

The suite mocks subprocess tool execution and tests synthetic TLC output fixtures; it verifies gate control flow and parser rejection conditions, not real SANY/TLC behavior. The parser is intentionally version-sensitive and must be validated against an independently acquired output fixture from the pinned TLC release before operational reliance.

## Current verification status

- Gate implementation: registered candidate, static inspection only.
- Gate unit tests: authored; execution NOT_RUN.
- TLA+ tool availability: NOT_ESTABLISHED.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Mutations/differential tests: NOT_RUN.
- Evidence attestation: NOT_IMPLEMENTED.\n- Real TLC output fixture compatibility: NOT_ESTABLISHED.\n- Validator checks invariant count from the configured inventory; it does not independently recover each invariant name from TLC output.
