# EGIS-FM-020 — Input Preflight and Snapshot-Stability Design Hostile Review

**Date:** 2026-11-25  
**Target:** PR #475 — EGIS verification gate v1.1.1  
**Reviewed code baseline:** `968bf4ded0ad9a17adede1810ad85062130398ac`  
**Design revision:** Seven-atom EGIS Gate I/O Resilience plan  
**Disposition:** Design decomposition accepted for implementation planning; no executable code changed in this record.

## 1. Trigger and baseline observations

Static review of `egis_tla_gate.py` at the reviewed HEAD found three coupled responsibilities still grouped inside the planned B1 atom:

1. input path discovery, filesystem error classification and hashing;
2. TLC config decoding and invariant inventory parsing;
3. input identity/digest revalidation around SANY/TLC execution.

Keeping these in one RED/GREEN transaction would make it difficult to isolate whether a failure came from path discovery, config semantics, or the time-of-check/time-of-use boundary. B1 is therefore decomposed into B1a, B1b and B1c. No behavior or code is changed by this decomposition.

## 2. Hostile findings

| Finding | Severity | Evidence in baseline | Required falsification test | Design disposition |
|---|---|---|---|---|
| FMH-125 — `Path.is_file()` conflates missing and inspection errors | Medium | Current gate checks `all(path.is_file() ...)`; this can collapse permission/metadata failures into a false result | Inject FileNotFoundError separately from PermissionError/OSError for module, config and JAR | B1a: explicit stat/open taxonomy |
| FMH-126 — config read occurs after TLC | High | Current `run_gate` reads config and extracts invariants after TLC returns | Invalid UTF-8/empty/malformed config must prevent every Java process | B1b: strict decode and inventory before SANY; retain in-memory config |
| FMH-127 — content hash is not bound to tool consumption | High | Current module/config/JAR digests are calculated before child processes reopen paths | Persistent mutation before SANY, between SANY/TLC, and after TLC must block or fail at the correct boundary | B1c: filesystem identity+digest checkpoints |
| FMH-128 — malformed invariant directives may be silently ignored | Medium | Existing inventory extractor returns names for matching lines and can ignore malformed lines beginning with INVARIANT | Malformed explicit directive and duplicate name must fail; no directive must block | B1b: strict directive grammar |
| FMH-129 — snapshot metadata may overstate assurance | High | Pre/post metadata and digest checks cannot exclude a transient ABA replacement between checkpoints | A design review must identify the ABA counterexample and prohibit claims of snapshot isolation | Explicit caller-supplied read-only stable snapshot assumption; FMH-120 remains OPEN |

## 3. Seven-atom decomposition

The execution order is now:

`A1 → A2 → B1a → B1b → B1c → B2 → B3`.

- **B1a** owns strict root/path resolution, file type and I/O classification, same-descriptor hashing, identity metadata, initial snapshots, and schema 1.3.
- **B1b** owns strict UTF-8 decoding and invariant inventory parsing before Java.
- **B1c** owns pre-launch and post-execution snapshot revalidation and process evidence integrity mapping.
- B2 and B3 remain unchanged and cannot start before B1c's exact-head Green and hostile review.

Only the two existing executable files are modified during each behavior atom. B1a GREEN updates EGIS-VG-001 in the same commit as schema 1.3. B1b/B1c do not introduce another schema increment.

## 4. Input snapshot contract

Each module/config/JAR record stores canonical path, SHA-256 and identity tuple:

- device;
- inode;
- size;
- modification time in nanoseconds;
- change time in nanoseconds.

The same opened descriptor is used for byte hashing; fstat is checked before/after reading and path stat is compared after reading. Initial missing input is BLOCKED; initial inspection I/O error is BLOCKED; persistent mutation during preflight is FAIL. A JAR outside the repository is permitted only when it is a regular readable file and matches the approved SHA-256 pin.

Module and config must resolve beneath the strict repository root. Escaping symlinks are BLOCKED. This is path containment, not proof of source authenticity.

## 5. Execution-integrity semantics

Pre-launch snapshot mismatch is FAIL and prevents the process. A mismatch or inspection failure discovered after a child starts blocks overall acceptance and marks that execution's input-integrity result UNKNOWN, preserving the actual process exit/result separately. TLC is never started after SANY input-integrity uncertainty. The TLC output validator is never invoked after TLC input-integrity uncertainty.

No result may be promoted to PASS because an input could not be re-inspected.

## 6. Residual counterexample — transient ABA

A hostile concurrent writer can replace an input with different bytes after one checkpoint and restore the original bytes before the next checkpoint. Path identity and pre/post digest checks may see the original metadata and digest at both observations. Therefore, these checks only detect persistent mutations observable at checkpoints.

The design expressly does not claim to detect ABA or provide snapshot isolation. PASS is conditional on a caller-provided read-only stable snapshot for the full invocation. If hostile concurrent writers are within the threat model, immutable snapshot support must precede formal-gate promotion. FMH-120 remains OPEN.

## 7. Review conclusion

The B1 decomposition is technically coherent and independently falsifiable. The three sub-atoms have non-overlapping responsibilities and explicit status/error boundaries. The remaining ABA threat is recorded as a promotion limitation, not misrepresented as solved.

**Status:** READ-ONLY DESIGN REVIEW. No code, workflow, branch policy, main, secrets, deployment, or local workstation was modified.
