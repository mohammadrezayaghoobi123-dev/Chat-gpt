# Gitleaks Legacy Allowlist Necessity Matrix — Design Specification v1

**Status:** PROPOSED — implementation not yet authorized by this specification  
**Scope:** PR #477 child branch only; no changes to `main`, repository settings, secrets, credentials, or deployed resources  
**Parent:** PR #473, `security/gitleaks-allowlist-integrity-atomic-2026-11-25`  
**Purpose:** Determine whether each of the 15 inherited legacy Gitleaks allowlist entries is necessary, redundant, or unresolved without relying on Python-regex approximations as a substitute for Gitleaks/RE2 execution.

## 1. Problem statement

The current child PR validates 30 allowlist entries (15 inherited legacy entries, 13 newly pinned line exceptions, and 2 separately governed synthetic fixtures). Its existing necessity scan removes the 13 new entries and expects their 13 finding tuples. That does not establish the necessity or non-masking behavior of the 15 inherited entries.

A prior source-level preflight reported 43 unique candidate tuples and no cross-group tuple or commit overlap. That result used Python `re`, not Gitleaks/RE2. It is useful as a candidate oracle only; it is not detector-execution evidence.

## 2. Non-goals and safety invariants

- Do not change `.gitleaks.toml`, expand or weaken any allowlist, rewrite history, rotate credentials, or classify a finding as harmless merely because it is redacted.
- Do not print, upload, persist, or expose secret values, unredacted reports, full source lines, or generated diagnostic TOML.
- Preserve the ordinary full-history scan and its existing redaction and exit-status behavior.
- Generate all temporary configs and reports under `$RUNNER_TEMP`, set `umask 077`, and remove every temporary file through an EXIT trap whose cleanup status is checked; cleanup failure must force a non-zero result without masking the original failure.
- Use the exact Gitleaks binary/version already provisioned by the workflow. No network fetch or floating tool version is permitted in the matrix step.
- Every scan must use the same checked-out commit graph and fetched refs. A missing ref, incomplete history, changed HEAD, timeout, malformed report, or budget exhaustion is a hard failure / UNKNOWN.
- Never convert an UNKNOWN or failed scan into PASS.

## 3. Oracle contract

Before matrix execution, construct a redacted, independently reviewable source-tuple manifest for the 15 legacy entries. Each canonical Finding identity is the full coordinate tuple:

`(Commit, File, RuleID, StartLine, StartColumn, EndLine, EndColumn)`

The independent source manifest additionally records the exact source commit, repository-relative path, rule, and source coordinates. The full identity and multiset rules in Section 10.2 are mandatory.

The manifest must:
1. Be derived from the exact pinned source commits and paths in the trusted `origin/main` baseline.
2. Record the exact source line number and `generic-api-key` rule ID, but never store or print the source line or any matched value.
3. Reject missing commits, missing paths, invalid line numbers, duplicate descriptions, duplicate tuple identities, and non-unique source provenance.
4. Be reviewed independently against the 15 baseline entries before it is used as an oracle.
5. Be immutable during a matrix run and bound to the exact workflow commit and baseline blob identity.

The previously observed candidate count of 43 is a hypothesis, not a hard-coded truth. If fresh reconstruction does not produce the same manifest, stop and classify the result UNKNOWN pending reconciliation. Do not regenerate the expected manifest from Gitleaks output. The source manifest must be versioned, exact-commit-bound, include full coordinates where reconstructable, and inventory all effective suppressors as specified in Section 10.3.

Let (E_i) be the independently reviewed tuple set for legacy entry (i), and (U = \bigcup_{i=1}^{15} E_i). The matrix is valid only when the tuple sets and their overlap relationships are explicitly represented; no assumption of disjointness may be inferred from counts alone.

## 4. Required Gitleaks/RE2 matrix

Run exactly 16 diagnostic scans after the ordinary full-history scan:

### A. All-out control (one scan)

Create a temporary config by removing exactly the 15 legacy entries from the current 30-entry config. Retain all 13 new line exceptions and both special fixtures without changing their parsed TOML values or order. Textual formatting may change during serialization; reparsing must yield exact semantic equality apart from the deliberately removed entries.

Expected redacted report multiset: the exact Finding identities exposed by disabling only the 15 target legacy entries while every other effective suppression mechanism remains active. The oracle must include inherited defaults and every other active suppressor. The earlier `U − N` shorthand is permitted only if independently proven equivalent under the pinned effective configuration; otherwise Section 10.1 controls and any unresolved attribution is UNKNOWN.

### B. One-out variants (15 scans)

For each legacy entry (i), create a temporary config from the original current config by removing exactly entry (i). Preserve every other top-level setting and allowlist object at the parsed TOML data-model level; formatting-only changes are acceptable only if reparsing yields exact semantic equality.

Expected redacted report multiset: the exact Finding identities exposed by disabling only entry `i`, with every other legacy entry and every non-target suppression mechanism still active. Compute this from the independently reviewed effective-suppression oracle, not from set subtraction unless equivalence is proven. Shared or masked findings cannot establish unique necessity. Any overlap, unexpected delta, or unresolved suppressor is DISPUTED/UNKNOWN; do not label an entry redundant or overbroad automatically. Compare full-coordinate multisets.

### C. Isolated attribution (conditional; not part of the 16-scan baseline)

If any one-out result indicates masking, an unexpected tuple, or ambiguous attribution, stop the baseline matrix. A separately specified and reviewed diagnostic may isolate the implicated entry while disabling competing entries. Do not silently add unbounded scans to the baseline budget.

## 5. Per-scan execution contract

For every scan:
- Invoke the pinned Gitleaks binary with explicit temporary config, `--redact`, JSON report output, and the same full-history Git log scope.
- Capture process exit status without disabling shell fail-fast behavior globally.
- Require a report file that exists, has non-zero byte length, and parses as a JSON array. An empty array is valid only when the independently computed expected multiset is empty and the confirmed CLI exit code is the clean-scan code.
- Require the confirmed Gitleaks finding exit code when expected cardinality is positive; verify the exact exit-code contract against the pinned CLI/wrapper before implementation. Any status/cardinality mismatch or unexpected exit code is an execution failure.
- Validate exact report field types and all canonical coordinates; reject Boolean values where integer coordinates are required.
- Compare full-coordinate Finding multisets, not only counts or set cardinalities.
- Emit only scan identifier, duration, exit status, expected count, observed count, and comparison disposition. Never emit report contents.

## 6. Resource and cost controls

- Per-scan timeout: 30 seconds.
- Aggregate matrix wall-clock budget: 180 seconds, measured with a monotonic clock.
- Maximum diagnostic scans: 16 in the baseline matrix.
- Any timeout, retry, missing scan, malformed report, clock/budget breach, or incomplete cleanup fails closed as UNKNOWN.
- No automatic retry. A retry requires a new workflow run and a fresh exact-head evidence record.
- Keep the workflow's existing overall job timeout as an outer safety bound.

## 7. TDD and adversarial acceptance tests

Before enabling the matrix in the workflow, implement and link the complete uniquely identified acceptance suite `MAT-001` through `MAT-022` in Section 10.8. The earlier abbreviated checklist is superseded; no test may be omitted or treated as satisfied by a neighboring test.

The RED test must fail for the intended missing behavior; setup, import, or syntax errors do not count as RED. GREEN evidence must be from the exact resulting commit.

## 8. Decision semantics

Each legacy entry receives one of these evidence labels:
- `NECESSARY_FOR_DETECTION_POLICY`: all-out and corresponding one-out results exactly match the independently reviewed oracle, with no unresolved overlap or attribution issue.
- `REDUNDANT_CANDIDATE`: evidence suggests no unique contribution, but this label is not a deletion authorization; require isolated attribution and separate policy review.
- `DISPUTED`: observed behavior conflicts with the oracle or another entry may mask the result.
- `UNKNOWN`: incomplete evidence, execution failure, timeout, budget breach, or unresolved provenance.

A matrix PASS establishes only detector-behavior necessity under the tested commit graph, Gitleaks version, configuration, and tuple oracle. It does not establish credential authenticity, ownership, revocation, exposure impact, or harmlessness. Those remain separate security investigations.

## 9. Merge and release gate

This specification alone does not authorize merge or deployment. Implementation may begin only after this design is reviewed and approved. The PR must remain Draft until:
- the exact-head TDD suite passes;
- all 16 matrix scans pass within budget;
- ordinary full-history and PR-diff secret scans pass;
- temporary-file cleanup and redaction are independently verified;
- the final diff and dependency ancestry are re-fetched and hostile-reviewed;
- required repository review and branch-protection checks are satisfied.

No merge to `main` is authorized by this document. No deployment is in scope for this security-policy-only change.


---

## 10. Normative engineering amendment v2 — supersedes conflicting clauses above

This amendment is part of v1 and is normative. If an earlier clause conflicts with this amendment, this amendment controls. It changes design requirements only; it does not authorize matrix implementation.

### 10.1 Complete effective suppression universe

The phrase "current 30-entry config" is insufficient as a description of the detector's effective behavior. Because the project config sets `[extend].useDefault = true`, the experiment MUST model the effective configuration after Gitleaks default-config inheritance, not just the project's explicit `[[allowlists]]`.

Before any matrix scan, produce a redacted suppression-source inventory with a stable identifier and source class for every active suppression mechanism, including at minimum:

1. The 15 target legacy project allowlist entries under test.
2. The 13 newer project line exceptions.
3. The two separately governed synthetic fixtures.
4. Every inherited default global allowlist.
5. Every inherited default rule-level allowlist, including rule-specific allowlists that can affect `generic-api-key`.
6. Inline ignore directives (for example, `gitleaks:allow`) present in the scanned history, if supported by the pinned Gitleaks version.
7. Repository ignore files such as `.gitleaksignore`, if present and honored by the pinned version/invocation.
8. Any baseline, fingerprint, CLI ignore option, path exclusion, or other suppression/exclusion mechanism actually active in the workflow.

Do not assume that a mechanism is absent: prove absence against the exact checkout and invocation. Do not count a path/rule exclusion as an allowlist; classify it separately because it changes the scan universe.

Define:
- `L = {L_1 ... L_15}`: the 15 target legacy project entries.
- `P`: all other active suppression mechanisms, including the 13 new exceptions, two fixtures, inherited defaults, inline ignores, ignore files, and any other active suppressor.
- `S_P`: the independently reconstructed set of candidate Finding identities suppressed by `P` in the exact scan universe.
- `E_i`: independently reconstructed Finding identities attributable to legacy entry `L_i` when evaluated against the exact source commit/path/rule/line provenance.
- `E_i` is a set of canonical Finding identities attributable to entry `L_i`. Preserve the many-to-many attribution relation from each identity to every suppressor that matches it; do not duplicate one detector Finding merely because multiple allowlist entries suppress it.
- `U = union(E_1 ... E_15)` is the unique candidate identity universe; retain per-entry overlap in the attribution relation separately. The observed Gitleaks report is compared as a multiset in which each expected identity occurs exactly once; duplicate report records are rejected.

The all-out expectation is the Finding multiset exposed by disabling only `L`, with `P` left unchanged. It MUST be derived from the independent source/provenance oracle and the effective suppression inventory; it MUST NOT be approximated by `U - N` unless the oracle proves that this set subtraction is equivalent under the pinned Gitleaks matching semantics. The one-out expectation MUST likewise account for every remaining legacy entry and every member of `P`. Any suppressor whose exact effect cannot be independently reconstructed makes the affected attribution UNKNOWN and blocks a PASS.

For each source class, record: identifier, exact config/source location, rule scope, matching condition/target, commit/path/line or applicable scope, whether it is inherited, and the method used to establish presence/absence. Do not copy secrets, matches, source lines, or unredacted report fields into the inventory.

### 10.2 Complete Finding identity and multiset semantics

The four-field identity `(commit, path, StartLine, RuleID)` is not sufficient: two distinct findings can occupy the same line and rule. The canonical redacted identity MUST include all available stable coordinates and context fields emitted by the pinned Gitleaks version:

`(Commit, File, RuleID, StartLine, StartColumn, EndLine, EndColumn)`

Requirements:
- Validate the exact JSON field names/types against the pinned Gitleaks version's report schema.
- Require positive integer line/column coordinates; reject booleans, nulls, strings, zero, and negative values.
- Normalize repository-relative path representation only by a documented deterministic rule; reject absolute paths, traversal components, and ambiguous separators.
- Preserve multiplicity. Compare sorted canonical identity arrays or counted multisets, never plain sets or counts alone.
- Reject exact duplicate records only when the full canonical identity is identical and the report contract says a duplicate is impossible. Do not reject two distinct same-line findings merely because their four-field prefix collides.
- Do not use Gitleaks' built-in fingerprint as the sole identity; its documented fields do not distinguish all same-line collisions.
- `Secret`, `Match`, `Line`, author metadata, and other unnecessary sensitive fields MUST be redacted/omitted before persistence. No unredacted diagnostic fallback is allowed.

If the pinned Gitleaks report cannot provide a required coordinate, record that limitation and classify the affected comparison UNKNOWN; do not silently downgrade identity precision.

### 10.3 Exact independent manifest schema for N and legacy provenance

The manifest MUST be a versioned, machine-parseable artifact reviewed independently before use. Each record MUST contain:

- `manifest_version`
- `source_class` (one of `legacy_allowlist`, `new_exception`, `synthetic_fixture`, `inherited_default_global`, `inherited_default_rule`, `inline_ignore`, `ignore_file`, `baseline_or_cli`, `other`)
- stable `source_id` unique within the manifest
- exact `config_blob_sha` or source-file blob identity where applicable
- exact source commit SHA
- repository-relative path
- rule ID
- start/end line and start/end column when a Finding can be reconstructed
- exact non-secret matching predicate identity (for example, a stable predicate ID and its source location); never store the matched literal or source line
- provenance method and independent reviewer disposition
- whether the source is inherited from Gitleaks default config and the exact Gitleaks version/default-config identity
- canonical Finding identity and multiplicity, where applicable

For each of the 13 new exceptions and two fixtures, the manifest MUST identify the exact historical commit, path, rule, source coordinates, and predicate provenance. If a fixture is represented by multiple components/lines, enumerate each component separately without persisting its secret-like literal. The 13-exception proof MUST continue to assert its exact expected Finding multiset; it cannot be inferred from the legacy matrix.

For each of the 15 legacy entries, bind the stable entry ID to its exact parsed TOML object and baseline `.gitleaks.toml` blob SHA. Descriptions alone are not identifiers. Duplicate descriptions are a validation error, but distinct entries with duplicate descriptions MUST still be distinguishable by their stable object index plus canonical object digest; no entry may be silently dropped.

If any required manifest field is unavailable, source provenance is non-unique, or a source tuple cannot be reconstructed without exposing a secret, the result is UNKNOWN and the matrix MUST NOT run.

### 10.4 Baseline full-history scan is a hard precondition

The ordinary full-history scan MUST complete before the 13-exception proof and before all 16 legacy matrix scans. It must use the exact production-intended config, exact pinned Gitleaks binary, complete intended refs/history, and redacted report handling.

Proceed only when:
- process exit code is exactly the configured clean-scan code (normally 0);
- report is valid JSON and contains zero unallowlisted findings;
- no timeout, truncation, missing ref, shallow/incomplete history, scan error, or cleanup error occurred;
- exact HEAD, fetched-ref manifest, Gitleaks binary/version identity, and config identities match the pinned experiment snapshot.

If the ordinary full-history scan returns findings (including exit code 2), any non-zero unexpected status, malformed/incomplete output, or uncertainty about scan coverage, stop immediately. Do not feed baseline findings into the matrix, do not subtract them heuristically, and classify the run UNKNOWN/FAIL. Existing 13-exception necessity proof remains a separate mandatory gate and must pass independently.

### 10.5 Correct scan count and exit/report contract

The complete workflow scan sequence is explicitly:
1. One ordinary full-history scan using the production-intended config.
2. One existing 13-exception removal proof, independently asserting the exact expected 13-Finding multiset.
3. Sixteen legacy matrix scans: one all-out plus fifteen one-out variants.

Thus the workflow contains 18 scan invocations in this design. The 16-scan matrix budget applies only to item 3; the ordinary scan and existing 13-exception proof have their own separately declared budgets and cannot be omitted or counted as matrix cells.

Every matrix report file MUST exist, have non-zero byte length, parse as a JSON array, and satisfy the report schema. An empty array `[]` is valid only when the independently computed expected Finding multiset is empty and the process exit code is 0. A non-empty array is required when expected cardinality is positive and must correspond to the configured Gitleaks finding exit code (normally 2). The exact exit-code contract MUST be confirmed against the pinned Gitleaks CLI and wrapper before implementation; do not infer it from generic convention. Any status/cardinality mismatch is a failure. Never treat a missing/zero-byte report as an empty array.

### 10.6 Snapshot pinning and drift detection

Before the first scan, capture and persist a redacted snapshot containing:
- exact checkout HEAD SHA and tree SHA;
- exact `origin/main` SHA and tree SHA;
- exact `.gitleaks.toml` blob SHA and parsed semantic digest;
- exact workflow file blob SHA(s);
- exact Gitleaks version, executable path, executable SHA-256, and provenance source;
- exact fetched refs manifest (ref names and object SHAs), plus shallow/partial-clone status;
- exact ignore/baseline file identities and presence/absence;
- manifest version and SHA-256.

Revalidate the snapshot immediately before each scan and after the final scan. Any mismatch, unresolvable identity, ref movement, unexpected file, or incomplete fetch is UNKNOWN/fail-closed. A single workflow commit SHA alone is not a sufficient snapshot.

### 10.7 Resource controls, process cleanup, and feasibility

- Temporary workspace MUST be a unique private directory beneath `$RUNNER_TEMP`, created with restrictive permissions after `umask 077`; reject symlinked roots and path escapes.
- Every subprocess MUST have a hard per-scan timeout and be terminated/reaped on timeout. Record whether the process was started, terminated, reaped, and its final outcome.
- Use a monotonic clock for the aggregate budget.
- An EXIT handler MUST attempt cleanup on every path, verify that the private workspace no longer exists, and return a cleanup failure without overwriting the original non-zero process status. If the scan otherwise passed but cleanup failed, the overall result is failure.
- Test forced termination, timeout, process-reap failure, cleanup failure, pre-existing temp path, symlink/path escape, and original-failure-plus-cleanup-failure combinations.
- The current 30-second per-scan and 180-second matrix aggregate limits are provisional hard ceilings, not evidence of feasibility. Before implementation, measure a representative full-history run on the same runner class and exact ref scope. If the required 16 scans cannot fit within the ceiling, do not raise the budget silently; submit a separately reviewed budget change with measured p50/p95 durations, runner cost, and a bounded upper limit. No retry is automatic.

### 10.8 Corrected, uniquely traceable acceptance suite

The acceptance list is continuous and each test has a stable ID:

1. `MAT-001` Effective configuration inventory includes inherited default global and rule-level allowlists.
2. `MAT-002` Presence/absence of inline ignores, ignore files, baselines, CLI suppressors and scan exclusions is proven against the exact checkout/invocation.
3. `MAT-003` Every legacy entry is uniquely bound to a canonical parsed object and baseline blob identity.
4. `MAT-004` The 13 new exceptions and two fixtures have exact, independently reviewed provenance manifests.
5. `MAT-005` All-out config removes exactly the 15 target legacy entries and preserves all other effective configuration semantics.
6. `MAT-006` Each one-out config removes exactly one target legacy entry and preserves every other effective configuration semantic.
7. `MAT-007` Canonical Finding identity includes all required coordinates and detects same-line distinct findings.
8. `MAT-008` Multiset comparison is order-independent and multiplicity-sensitive.
9. `MAT-009` Missing, extra, duplicate, malformed, wrong-rule, wrong-commit, wrong-path, wrong-line, wrong-column, and wrong-end-coordinate records fail closed.
10. `MAT-010` Empty JSON array, missing report, zero-byte report, truncated report, malformed JSON, and non-array JSON are classified distinctly.
11. `MAT-011` Gitleaks exit codes and report cardinality are consistent for empty and non-empty expected results.
12. `MAT-012` Ordinary full-history scan failure prevents all downstream proof/matrix cells from running.
13. `MAT-013` Existing 13-exception necessity proof runs separately and exact-multiset asserts all 13 expected findings.
14. `MAT-014` Snapshot drift in HEAD/tree, main SHA, config blob, workflow blob, binary identity, refs, ignore files, or manifest fails closed.
15. `MAT-015` Per-scan timeout, aggregate timeout, process termination/reap, and scan omission fail closed.
16. `MAT-016` Cleanup succeeds on every path; cleanup failure preserves original failure and forces non-zero status.
17. `MAT-017` All temporary paths are private, unique, contained under `$RUNNER_TEMP`, and resistant to symlink/path traversal.
18. `MAT-018` Unsupported/unknown TOML fields and types are rejected rather than dropped during round-trip.
19. `MAT-019` A Python-derived or static candidate-manifest mismatch against the independent manifest is UNKNOWN, never silently accepted.
20. `MAT-020` A failure in any cell prevents a green aggregate result and no retry occurs within the same run.
21. `MAT-021` No secret value, source line, unredacted Finding, generated diagnostic TOML, or sensitive report content appears in logs/artifacts.
22. `MAT-022` A genuine RED test fails for the intended missing behavior; GREEN tests pass on the exact commit under test.

The implementation MUST link each test ID to its test name/file and exact evidence run. A setup/import/syntax failure is not a valid RED result.

### 10.9 Decision semantics and interpretation

The labels `NECESSARY_FOR_DETECTION_POLICY`, `REDUNDANT_CANDIDATE`, `DISPUTED`, and `UNKNOWN` remain evidence labels, not authorization to delete or retain credentials. A legacy entry may be classified only if its full effective suppression interactions and Finding multisets are resolved. Any unmodeled suppressor or coordinate ambiguity forces UNKNOWN.

### 10.10 Approval boundary

This amended specification is a design candidate only. No matrix code, workflow integration, allowlist edit, runtime change, merge, or deployment is authorized by the amendment. The next gate is a fresh exact-HEAD engineering review followed by a separate hostile review. Only after both reports show no unresolved P1 blocker should the design be presented for user approval. Implementation remains prohibited until that approval is explicit.
