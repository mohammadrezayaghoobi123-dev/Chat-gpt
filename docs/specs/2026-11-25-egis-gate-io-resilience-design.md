# EGIS Gate I/O Resilience Design

**Date:** 2026-11-25  
**Target:** PR #475, branch `verification/egis-verification-gate-v1.1.1-2026-11-25`  
**Design status:** User-approved two-increment scope; written-spec review required before implementation  
**Baseline HEAD:** `78020c75cee7767ab2a892a03bb9e085e41b1606`

## 1. Purpose and boundaries

Harden the EGIS TLA gate's process-launch classification and evidence-file boundary without changing the formal model, TLA+ tool acquisition policy, security allowlists, workflow permissions, or runtime deployment behavior.

The work is split into two independently reviewable increments:

- **A — Process launch classification:** classify process-creation `OSError` as `BLOCKED`, preserve fail-closed state transitions, and retain evidence when the output destination is writable.
- **B — Evidence path and I/O integrity:** prevent output/input aliasing, classify input-read failures, and make temporary-file cleanup and evidence-write failure behavior explicit.

No increment may change `UNKNOWN`, `BLOCKED`, or `FAIL` into `PASS` without positive evidence.

## 2. Increment A — process-launch failure classification

### 2.1 Contract

`run_command()` will retain its specific handling order:

1. `FileNotFoundError` → `BLOCKED`.
2. `subprocess.TimeoutExpired` → `FAIL`.
3. Other `OSError` raised while starting the child process → `BLOCKED`.
4. A started process with exit code zero → `PASS`; non-zero → `FAIL`.

For the generic `OSError` path, the result will contain:

- `status=BLOCKED`;
- `exit_code=null`;
- empty stdout;
- a stable reason code;
- exception class and numeric errno when present;
- a bounded diagnostic derived from the OS error message, excluding path/filename fields.

Do not catch `BaseException`, `KeyboardInterrupt`, `SystemExit`, or unrelated programming exceptions. Do not expose unbounded exception reprs or raw file paths in the diagnostic.

### 2.2 Gate propagation

- If SANY cannot be launched, SANY is `BLOCKED`, TLC is `BLOCKED` with `SANY_not_passed`, and overall status is `BLOCKED`.
- TLC must not be attempted after SANY is not `PASS`.
- If TLC cannot be launched after SANY passes, TLC and TLC output validation are `BLOCKED`; overall remains `BLOCKED`.
- If Git metadata commands cannot be launched, source identity remains `BLOCKED`; the gate must not execute Java tools.
- Non-zero process exit and timeout continue to be `FAIL`.

### 2.3 Increment A tests

Red tests first, then implementation and green verification:

- `PermissionError` and representative generic `OSError`, including missing errno.
- Structured result is JSON-serializable, bounded and path-redacted.
- SANY launch failure writes parseable evidence JSON when the destination is writable and proves TLC was not invoked.
- Git metadata launch failure blocks before Java execution.
- Missing executable remains `BLOCKED`; timeout and non-zero exit remain `FAIL`.
- `KeyboardInterrupt`, `SystemExit`, and unrelated non-OS exceptions propagate.

## 3. Increment B — output path and evidence I/O integrity

### 3.1 Output/input alias protection

Before any tool execution or evidence replacement, reject an output path that aliases any protected input:

- TLA module;
- TLC configuration;
- TLA+ tool JAR.

Use canonical resolved paths and filesystem identity checks for existing targets (including symlink and hard-link cases where supported). A conflict must not overwrite or replace the protected input. The CLI reports a stable nonzero failure and explicitly does not claim a persisted evidence file for this conflict.

The threat model assumes the output directory is controlled by the caller and is not concurrently modified by a hostile process. Defending against concurrent path-swap attacks with platform-specific directory-handle primitives is out of scope for this increment and must not be implied.

### 3.2 Input-read and configuration preflight

- Use explicit filesystem metadata/open operations so an inaccessible path is not silently collapsed into a generic `is_file() == false` result.
- Missing required inputs remain `BLOCKED`; input read/hash `OSError` becomes `BLOCKED` with a stable reason, exception class and errno. Persist evidence if the output destination remains writable.
- Read and UTF-8-decode the TLC configuration and derive its configured invariant inventory **before invoking SANY or TLC**. Invalid text encoding is `FAIL`; an unavailable/unreadable config is `BLOCKED`. Neither case may launch Java.
- An empty or invalid invariant inventory retains the existing fail-closed contract and must not lead to a TLC `PASS`.
- Hash mismatches and existing source/tool integrity failures retain their current `FAIL` / `BLOCKED` meanings.

### 3.3 Evidence writer contract

- Create the temporary file in the destination directory so replacement remains same-filesystem.
- Track the temporary path immediately after creation.
- On serialization, write, close, or replace failure, attempt cleanup of the temporary file on every ordinary exception path.
- Do not catch process-control exceptions.
- Surface evidence persistence failure as a typed, stable error. The CLI writes a bounded, sanitized diagnostic to stderr and exits nonzero; it must not claim that JSON evidence was persisted.
- Atomic replacement defines atomic visibility only. This design does **not** claim crash durability because file and parent-directory fsync are not included.
- Parent-directory creation failure is an evidence persistence failure, not a successful gate result.

### 3.4 Increment B tests

- Exact output/module, output/config and output/JAR path conflicts are rejected before any mutation.
- Symlink alias and hard-link alias are rejected where the platform supports their creation.
- Missing and unreadable module/config/JAR paths are distinguished and classified without PASS.
- Invalid UTF-8 configuration and empty/invalid invariant inventories fail closed before Java invocation.
- Injected serialization, file-write and replace failures surface the typed persistence error.
- Temporary files are removed after every tested ordinary failure.
- CLI persistence failure returns nonzero, emits only a sanitized diagnostic, and makes no claim that a JSON evidence artifact exists.
- Successful replacement remains same-directory and atomically visible.

## 4. Cross-increment invariants

- No broad `except Exception` or `except BaseException` around the gate's full execution path.
- No suppression or reinterpretation of tool non-zero exits/timeouts.
- No TLC execution unless SANY is `PASS`.
- No Java process execution until required source/config/input preflight has completed.
- No PASS on missing, malformed, conflicting, or unpersisted required evidence.
- No changes to TLA modules, TLC configs, JAR acquisition, Java provenance, Gitleaks policy, GitHub permissions, branch rules, `main`, or deployment.
- Real SANY/TLC execution remains a separate provenance-gated requirement; mocked tests do not establish formal verification.

## 5. Verification and hostile review protocol

For each increment independently:

1. Freeze and record the exact starting HEAD.
2. Add test-only regressions and demonstrate RED on that exact code.
3. Implement only the bounded increment.
4. Run focused tests and the complete EGIS gate test workflow on the resulting exact HEAD.
5. Inspect the actual changed-file set and full diff.
6. Perform hostile checks against status laundering, path aliasing, temp-file leakage, error-message disclosure, and accidental TLC invocation.
7. Record exact run IDs, test counts, exit statuses, and remaining limitations in PR #475.
8. Stop if any unrelated file changes, ancestry moves unexpectedly, the branch lease fails, or any check is unavailable.

Do not merge, retarget, force-push, rewrite history, modify `main`, change Rulesets/secrets/permissions, acquire tools, or deploy.

## 6. Explicit non-goals and residual limitations

- No proof of real SANY/TLC parser compatibility.
- No TLA+ artifact download, build or execution.
- No claim of crash-durable evidence persistence.
- No defense against an attacker concurrently replacing entries in the caller-controlled output directory.
- No change to the separate full-history Gitleaks failure; its 13 historical findings remain a separate security gate and must remain visible as a failure until independently resolved.

## 7. Acceptance decision

Increment A is accepted only when its RED/GREEN evidence and hostile regression checks pass on its exact commit. Increment B is accepted only after A's exact-head state is the parent and B independently meets its own tests and hostile checks. The combined PR remains Draft / NOT_VERIFIED / NO-MERGE until all existing security, provenance, formal-verification and human-review gates are separately satisfied.
