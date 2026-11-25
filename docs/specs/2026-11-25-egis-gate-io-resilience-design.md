# EGIS Gate I/O Resilience — Atomic Design v2

**Revision:** 2  
**Date:** 2026-11-25  
**Target:** PR #475, branch `verification/egis-verification-gate-v1.1.1-2026-11-25`  
**Design status:** Scope approved; this revised execution contract requires user review before implementation  
**Frozen code baseline:** `78020c75cee7767ab2a892a03bb9e085e41b1606`  
**Current documentation branch head before this revision:** `619c48a8671267f01d87145e59ff3542b6f22d3d`

## 0. Why revision 2 is required

Revision 1 grouped too many responsibilities into two increments. That made the transaction boundaries, failure ordering, ownership, and independently falsifiable acceptance criteria insufficiently precise.

Revision 2 decomposes the work into five implementation atoms. Each atom receives its own test-only RED commit and one bounded implementation GREEN commit. No implementation commit may include the next atom's behavior.

The current code facts motivating this design are:

- `run_command()` uses `subprocess.run()`, catches `FileNotFoundError` and `TimeoutExpired`, but not other process-related `OSError`.
- A blanket `OSError` catch around `subprocess.run()` would be incorrect: an OS error may occur after the child has started while communicating with it. Start and communicate phases must be distinguishable.
- The TLC config is read and parsed after the TLC process returns. Invalid UTF-8 or unavailable config can therefore be detected too late.
- `Path.is_file()` can collapse inspection errors into a false result; the gate needs explicit stat/open error classification.
- `output` is not checked against module/config/JAR aliases.
- `atomic_write_json()` does not guarantee cleanup of its temporary file after all ordinary failure paths and has no typed persistence error.
- A green mocked test suite does not establish real SANY/TLC execution or parser compatibility.

## 1. Scope and non-negotiable invariants

Only these files may change in the five atoms:

- `verification/formal/egis/tools/egis_tla_gate.py`
- `verification/formal/egis/tests/test_tla_gate.py`

The design document may be updated as a separate documentation-only commit. The EGIS workflow is not changed unless the test runner demonstrably fails to trigger for either allowed path; that would require a separately reviewed scope change.

Protected files and resources:

- TLA module;
- TLC configuration;
- approved TLA+ tool JAR;
- pre-existing evidence output;
- `main`, Rulesets, secrets, credentials, deployment and local workstation state.

Invariants:

- **I-01 Status integrity:** no missing, unreadable, malformed, timed-out, conflicting, or unpersisted evidence may yield PASS.
- **I-02 Stage ordering:** no Java/SANY/TLC process starts until required path checks, input reads, configuration decoding and invariant-inventory validation complete.
- **I-03 SANY dependency:** TLC starts only after SANY returns PASS.
- **I-04 Start/result distinction:** failure to create a child is distinct from failure to collect a started child's result.
- **I-05 Input immutability:** an evidence output path may never alias or replace module/config/JAR.
- **I-06 Evidence persistence:** an evidence write either atomically replaces the destination or raises a typed persistence error; it never reports a persisted result after a failed write.
- **I-07 Old evidence preservation:** before successful `os.replace`, a failed write must leave any prior destination file unchanged.
- **I-08 Cleanup:** every ordinary temporary-file failure path attempts cleanup; cleanup failure is separately represented and must not mask the primary failure.
- **I-09 Exception discipline:** do not catch `BaseException`, `KeyboardInterrupt`, `SystemExit`, or unrelated programming errors at the top level.
- **I-10 No false durability claim:** atomic visibility and crash durability are separate; this scope promises no fsync-based crash durability.
- **I-11 No real-tool claim:** mocked process tests do not establish TLA+ tool provenance, SANY/TLC execution, or real-output compatibility.
- **I-12 Project epistemics:** `UNKNOWN` is not success or failure; gate statuses `PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN` retain their documented meanings.

## 2. Required execution state machine

The gate must follow this sequence. A stage may only transition forward; a failed prerequisite prevents every later stage that depends on it.

| Order | Stage | PASS condition | Failure disposition | Later process allowed? |
|---:|---|---|---|---|
| 0 | Resolve root and path arguments | Root and normalized paths are usable | BLOCKED or typed output-path error | No |
| 1 | Output/input alias guard | Output is distinct from module/config/JAR | Typed output-path conflict; no evidence written to conflicting path | No |
| 2 | Input metadata/read preflight | Required inputs are regular readable files; module/config are within repository root | Missing/unavailable → BLOCKED; invalid config encoding/inventory → FAIL or BLOCKED as specified below | No |
| 3 | Source identity | Git metadata available, clean tree, expected commit matches | Metadata unavailable → BLOCKED; dirty/mismatch → FAIL | No |
| 4 | Content identity | Module/config/JAR hashes match their required inputs/pin | Missing/unavailable → BLOCKED; digest mismatch → FAIL | No |
| 5 | SANY | Child starts, exits zero, complete result captured | Start unavailable → BLOCKED; timeout/nonzero → FAIL; result capture unavailable → BLOCKED | TLC only on PASS |
| 6 | TLC | Child starts, exits zero, complete output captured | Start unavailable → BLOCKED; timeout/nonzero → FAIL; result capture unavailable → BLOCKED | Validator only with captured output |
| 7 | TLC output validation | One valid ordered completion sequence and expected invariant count | Violation/nonzero/inconsistent counts → FAIL; missing/ambiguous evidence → BLOCKED | No further process |
| 8 | Evidence persistence | JSON serialization, temp write/close and replacement complete | Typed persistence failure; CLI exits nonzero and makes no persisted-evidence claim | No PASS claim |
| 9 | CLI result | Evidence persistence succeeded | Print result JSON and return 0 only for overall PASS; otherwise return documented nonzero | End |

**Ordering correction:** the configuration bytes must be read, UTF-8 decoded, and converted into the expected invariant inventory before SANY starts. The same in-memory decoded text/inventory is then used by the output validator. Do not reopen and parse the configuration after TLC.

## 3. Explicit failure taxonomy

| Failure point | Classification | Required stable reason |
|---|---|---|
| Executable absent at process creation | BLOCKED | `process_executable_missing` |
| Other `OSError` during `Popen` creation | BLOCKED | `process_start_unavailable` |
| Child started; output communication raises `OSError` | BLOCKED | `process_result_unavailable` |
| Child exceeds timeout | FAIL | `process_timed_out` |
| Child exits nonzero | FAIL | `process_nonzero_exit` |
| Required input missing | BLOCKED | `input_missing` |
| Input stat/open/hash raises `OSError` | BLOCKED | `input_io_unavailable` |
| Module/config resolves outside checkout root | BLOCKED | `repository_input_path_escape` |
| TLC config is not valid UTF-8 | FAIL | `config_encoding_invalid` |
| No explicit INVARIANT inventory can be derived | BLOCKED | `invariant_inventory_unavailable` |
| Duplicate or syntactically invalid explicit invariant names | FAIL | `invariant_inventory_invalid` |
| Output aliases module/config/JAR | Typed fatal path error | `evidence_output_input_alias` |
| Evidence serialization/write/replace fails | Typed persistence error | one of the writer reason codes in Atom 5 |
| Temporary cleanup fails after a writer error | Preserve primary error plus `cleanup_failed=true` | `evidence_temp_cleanup_failed` |

Diagnostics must not include raw exception reprs, absolute local paths, or environment values. For process-start errors, preserve the exception class and errno when available, but not the filename/path fields. Command identity remains in the established structured evidence fields; do not add secrets or environment contents.

## 4. Five atomic implementation atoms

Each atom has exactly two commits: **RED** (tests only) and **GREEN** (the minimal implementation for those tests). The next atom cannot start until the preceding GREEN commit has exact-head CI evidence and its hostile review has no unresolved high-severity defect.

### Atom A1 — Process lifecycle adapter

**Responsibility:** distinguish process creation from communication with a started process.

**Design:** replace the opaque `subprocess.run()` boundary with a narrow `Popen` lifecycle inside `run_command()`:

1. Construct `Popen` with the existing command, cwd, environment snapshot and stdout/stderr pipes; use byte streams and the existing safe UTF-8 replacement decoder.
2. Catch `FileNotFoundError` as a specific process-start BLOCKED result.
3. Catch other `OSError` only around `Popen` construction as process-start BLOCKED.
4. After successful construction, call `communicate(timeout=...)`.
5. On timeout, kill and reap the child, capture bounded/safely decoded output, and keep status FAIL.
6. If communication raises `OSError` after process start, attempt terminate/kill and reap. Return BLOCKED with `process_result_unavailable`; never validate missing/partial output as success.
7. If cleanup cannot be confirmed, report a cleanup substatus and do not start another dependent process.

Do not blanket-catch OSError around the entire function. Preserve the existing result keys `status`, `exit_code`, `stdout`, `stderr`, `command`; only add stable, documented reason/phase/error metadata.

**RED-only tests:** PermissionError at Popen; generic OSError with and without errno; absent executable; communication OSError after child creation; TimeoutExpired with kill/reap; nonzero exit; successful output; KeyboardInterrupt/SystemExit and unrelated programming exception propagation; path-redacted diagnostics; JSON serialization.

**GREEN acceptance:** all targeted tests pass; existing timeout/nonzero/missing-executable semantics do not regress; no child is left running in injected timeout/communication-failure tests where the platform test harness can verify reaping.

**Files:** the two allowed files only.

### Atom A2 — Gate state propagation

**Responsibility:** map command results into source-identity, SANY, TLC and overall statuses without status laundering.

**Required transitions:**

- Git metadata unavailable or unobservable → source identity BLOCKED and no Java process.
- Dirty source or expected-commit mismatch → FAIL and no Java process.
- SANY BLOCKED → TLC BLOCKED with `SANY_not_passed`; overall BLOCKED; evidence written if output is safe/writable.
- SANY FAIL → TLC BLOCKED with `SANY_not_passed`; overall FAIL.
- TLC BLOCKED → TLC output validation BLOCKED; overall BLOCKED.
- TLC FAIL/timeout/nonzero → output validation cannot promote the gate; overall FAIL.
- Process result unavailable → no parser call on partial/missing output.

**RED-only tests:** inject each transition separately; assert exact status and exact call count; assert no Java execution after Git metadata block; assert no TLC after every non-PASS SANY result; assert no TLC parser PASS from partial stdout.

**GREEN acceptance:** state table and tests agree exactly; existing top-level JSON shape remains compatible except explicitly documented additive reason metadata.

**Files:** the two allowed files only.

### Atom B1 — Required-input and TLC-config preflight

**Responsibility:** make every required input observable and validate config before process execution.

**Required behavior:**

- Resolve root strictly; module and config canonical paths must remain beneath root after resolution. An escaping symlink is BLOCKED.
- The approved JAR may be outside root, but must be a regular readable file and must match its pinned SHA-256.
- Use explicit `stat`/open operations, not `is_file()` as the sole failure discriminator.
- Distinguish missing file from non-missing metadata/read errors.
- Read bytes and compute module/config/JAR digests from the bytes read. Do not silently reclassify permission/metadata errors as missing.
- Decode config bytes using strict UTF-8 before SANY. Invalid UTF-8 is FAIL.
- Derive invariant names from the already decoded text once. Empty/unavailable inventory is BLOCKED; duplicate/invalid explicit names are FAIL.
- Pass this validated inventory to the TLC output validator; do not reread the config after TLC.
- Preserve the current pin-mismatch behavior as FAIL and missing JAR as BLOCKED.

**RED-only tests:** missing module/config/JAR; stat and open PermissionError/OSError for each input class; module/config path escape via symlink; invalid UTF-8 config with assertion that Popen is never called; empty inventory; duplicate/invalid invariant identifiers; stable hashes over the exact bytes read.

**GREEN acceptance:** no child process starts until all required preflight checks pass; exact config bytes and inventory used for final validation are the preflight values.

**Files:** the two allowed files only.

### Atom B2 — Output path identity guard

**Responsibility:** prevent the evidence destination from aliasing protected input bytes.

**Required behavior before any subprocess or evidence write:**

1. Resolve the output parent and normalize the candidate destination with non-strict resolution so a not-yet-created final file can be checked.
2. Compare normalized output candidate against normalized module/config/JAR paths.
3. If output exists, reject a final symlink and reject directory/non-regular targets.
4. Use filesystem identity comparison (`samefile`/device+inode semantics) to detect hard-link aliases for existing protected files.
5. If an existing output cannot be inspected due to a non-ENOENT OS error, fail closed with a typed path-validation error.
6. A conflict is fatal before execution: do not write evidence to the conflicting path and do not claim a JSON artifact exists.
7. A distinct existing regular evidence file may be atomically replaced by Atom B3.

Parent-directory symlinks are resolved to their canonical target; the design does not claim protection against a hostile process concurrently swapping path components after validation. This residual TOCTOU assumption must be recorded.

**RED-only tests:** exact path equality for each protected input; relative-vs-absolute aliases; final symlink to each protected input; hard link to each protected input where supported; unrelated existing evidence file allowed; output directory rejected; inaccessible output path inspection blocks; assert protected bytes remain identical and no process runs on conflict.

**GREEN acceptance:** all alias cases reject before any command/write; supported hard-link/symlink tests run rather than silently skip without recording platform capability.

**Files:** the two allowed files only.

### Atom B3 — Evidence writer and CLI failure contract

**Responsibility:** make writing all-or-nothing from the caller's perspective, with accurate failure signaling.

**Required behavior:**

1. Serialize the entire payload before creating a temp file; use strict JSON serialization (`allow_nan=false`).
2. Create the parent directory if required; classify parent creation failure.
3. Create a uniquely named temporary file in the destination directory and record its path immediately.
4. Write UTF-8 JSON plus one trailing newline; close the stream before replacement.
5. Replace destination using `os.replace` on the same filesystem.
6. On any ordinary serialization/write/close/replace failure, attempt temp cleanup. Preserve the old destination if replacement did not complete.
7. Expose a typed `EvidencePersistenceError` with a stable reason code and a cleanup-failure flag; never propagate raw path-bearing OS exception text to CLI output.
8. The CLI catches only the typed persistence/path-validation exceptions, writes one bounded sanitized diagnostic to stderr and returns nonzero. It does not print JSON evidence or claim a persisted gate status when persistence failed.
9. Do not add file or directory fsync in this increment; document atomic replacement/visibility only, not crash durability.

**RED-only tests:** NaN/non-serializable payload; parent mkdir failure; temp creation failure; partial write failure; close failure; replace failure; cleanup failure; old destination preserved before replace; temp path is same directory; temp cleanup attempted; successful JSON roundtrip; CLI captures sanitized stderr, returns nonzero, and emits no success JSON on persistence failure; KeyboardInterrupt/SystemExit not swallowed.

**GREEN acceptance:** old output remains unchanged for every pre-replace failure; no temp residue when cleanup succeeds; CLI makes no persisted-evidence claim after any writer failure; successful replace yields parseable JSON.

**Files:** the two allowed files only.

## 5. Per-atom transaction protocol

For every atom in the order A1 → A2 → B1 → B2 → B3:

1. Re-fetch PR metadata and branch ref; record exact starting HEAD and expected parent.
2. Create only the RED test commit on that branch using a non-force update with `expected_sha`.
3. Verify the RED workflow failed for the intended assertion(s), not import, syntax, environment, or unrelated CI errors.
4. Create exactly one GREEN implementation commit as a direct child; no opportunistic refactor or next-atom code.
5. Re-fetch the ref and exact commit; compare changed paths and full diff.
6. Run compileall, focused tests, full EGIS unit workflow and applicable Gitleaks checks on exact GREEN HEAD.
7. Inspect logs and test counts; do not infer status from workflow labels alone.
8. Perform the atom's hostile tests and mutation checks; register findings and disposition in #475.
9. Verify the next HEAD is exactly the GREEN commit; stop on unexpected branch movement, path expansion, missing CI, or failed lease.

The temporary RED commit is intentionally expected to fail tests. The corresponding GREEN commit must restore the branch to all-green for the applicable unit suite. No merge/squash/rebase is allowed during this sequence; each test/fix pair remains inspectable in ancestry.

## 6. Failure and rollback rules

- Never force-update the branch. If `expected_sha` fails, re-read the branch and review the intervening commit; never retry against a stale base.
- If a GREEN implementation cannot satisfy its RED tests, stop at that exact commit. Do not start the next atom.
- If unrelated files change, revert only by a new reviewed forward commit; do not rewrite history.
- If CI is unavailable, status is UNKNOWN/NOT_VERIFIED; do not infer success.
- If Gitleaks finds anything in the new diff, stop and do not suppress or redact away the result.
- No merge, PR retarget, main mutation, Ruleset/secret/permission change, artifact acquisition, build, real SANY/TLC execution, deployment, or local workstation modification is authorized by this design.

## 7. Explicit residual risks

- The caller-controlled output directory is assumed not to be concurrently manipulated by a hostile process. Path-swap TOCTOU resistance is not claimed.
- Input files could be modified concurrently after their bytes are hashed but before SANY/TLC reopens them. This design records the limitation; it does not claim filesystem snapshot isolation.
- Output captured by child processes remains subject to the existing memory-size behavior; output-size limiting is outside this narrowly approved scope and should be a separate design if required.
- Atomic replace is not crash-durable without file and directory fsync. No durability claim is made.
- An OS/process cleanup failure may leave a child process state uncertain; the evidence must expose this and block dependent execution.
- Artifact provenance, Java/JDK provenance, real SANY/TLC execution, real TLC output grammar compatibility, source-build reproducibility and evidence attestation remain separate blocked gates.
- The full-history Gitleaks scan's 13 historical findings remain a separate failing security gate. No suppression, history rewrite or credential rotation is part of this work.

## 8. Completion criteria

The I/O resilience work is not complete merely because the five atoms have green unit CI. Completion requires:

- all five RED/GREEN pairs with intended failure evidence and exact-head green evidence;
- complete per-atom changed-path and hostile-review records;
- no unresolved high-severity defect introduced by these changes;
- exact final-head CI evidence;
- separate closure or explicitly retained disposition for the 13 historical Gitleaks findings;
- independent human review and the existing TLA+ provenance/execution gates.

Until those conditions are met, PR #475 remains DRAFT / NOT_VERIFIED / NO-MERGE.
