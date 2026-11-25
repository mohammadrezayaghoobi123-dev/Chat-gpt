# EGIS-FM-021 — B1a Input Discovery and Read-Snapshot Implementation Hostile Review

**Date:** 2026-11-25  
**Target:** PR #475 — EGIS Verification Gate  
**Reviewed HEAD:** `c980fb38e6297f969bf792b7b92a6127912eed18`  
**Atom:** B1a — Required-input discovery and initial read snapshot  
**Verdict:** B1a implementation ACCEPTED WITH EXPLICIT RESIDUAL LIMITATIONS. Gate promotion remains NOT_VERIFIED.

## 1. Exact-head verification

- EGIS TLA Gate Unit Tests — Push run `45686376569`: SUCCESS.
- EGIS TLA Gate Unit Tests — Pull Request run `45686388617`: SUCCESS.
- Compileall passed.
- Gate tests: **66/66 PASS**.
- JUnit report preflight tests: **17/17 PASS**.
- Full-history Gitleaks — Push run `45686376581`: FAILURE, 13 historical findings.
- Full-history Gitleaks — Pull Request run `45686388615`: FAILURE, same known historical exception set. This remains an independent merge blocker.

## 2. B1a implementation properties verified

- Strict repository-root resolution; root missing/non-directory/unavailable states are BLOCKED.
- Module and config canonical paths are contained under the resolved repository root; external JAR is permitted.
- Required files must be regular files.
- Stat/open/fstat/read I/O failures are classified and do not escape as raw exceptions.
- SHA-256 is computed from bytes read through the same opened descriptor.
- Pre-stat, descriptor metadata before/after reading, post-read stat, and canonical path before/after reading are compared.
- Evidence schema 1.3 contains input snapshots for module/config/tool JAR, canonical path, SHA-256 and identity tuple; no input bytes are emitted.
- Tool pin mismatch fails closed.
- Git metadata and Java are not invoked until all three input snapshots are accepted.
- Symlink escapes for both module and config are blocked.
- External JAR and missing-JAR cases are covered.
- Persistent symlink-target drift is detected.

## 3. Falsification coverage

| Adversarial condition | Expected disposition | Exact-head coverage |
|---|---|---|
| Missing required input | BLOCKED / input_missing | PASS |
| Stat PermissionError/OSError | BLOCKED / input_io_unavailable | PASS |
| Open/read PermissionError/OSError | BLOCKED / input_io_unavailable | PASS |
| Directory supplied as input | BLOCKED / input_not_regular | PASS |
| Module/config symlink escapes repository | BLOCKED / repository_input_path_escape | PASS |
| External pinned JAR | Accepted | PASS |
| Missing JAR | BLOCKED / input_missing | PASS |
| Persistent symlink target drift | FAIL / input_changed_during_read | PASS |
| Digest does not match approved JAR pin | FAIL | PASS |
| Snapshot identity unavailable | BLOCKED | Contracted; test expansion remains recommended |
| Concurrent ABA replacement | Not guaranteed detected | OPEN residual |

## 4. Hostile residual findings

| Finding | Severity | Status |
|---|---|---|
| FMH-130 — Snapshot checks are observations, not immutable snapshots | HIGH | OPEN: persistent changes are checked; transient ABA remains possible |
| FMH-131 — SANY/TLC reopen paths after preflight | HIGH | OPEN until B1c checkpoint integration; current B1a alone cannot bind execution to the exact hashed bytes |
| FMH-132 — Evidence output path may alias an input path | HIGH | OPEN; B2 output-path identity guard must reject collisions before any write |
| FMH-133 — Filesystem identity tuple is platform/filesystem-dependent | MEDIUM | OPEN; zero/unavailable inode identity blocks, but metadata is not authenticity proof |
| FMH-134 — Approved JAR digest does not independently establish artifact provenance | HIGH | OPEN; independent acquisition/provenance remains NOT_ESTABLISHED |

## 5. Counterexample and epistemic boundary

A hostile writer may replace an input after a checkpoint and restore it before the next checkpoint. A child process can reopen the path and consume bytes not identical to the descriptor hashed by preflight. The current implementation cannot prove execution consumed the exact hashed snapshot. B1c checkpointing reduces persistent-change exposure but cannot exclude transient ABA. The caller must provide a read-only stable snapshot; where concurrent hostile writers are in scope, immutable snapshot capability is a promotion prerequisite.

## 6. Decision

B1a is accepted as an atomic implementation stage based on exact-head CI and hostile tests. This is **not** an acceptance of the entire gate or formal verification stack. B1b/B1c, B2 output collision guard, B3 evidence hardening, independent tool provenance, real SANY/TLC execution, full-history Gitleaks resolution, and independent human review remain incomplete or blocked.

No merge, retarget, deployment, Ruleset, main, secret, local workstation, or tool acquisition action was performed.
