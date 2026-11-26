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


### 10.11 Hostile integration audit of the current PR implementation

The design above was checked against the actual files on PR #477 head `988585084604fbe99e91d5676d9e7ddfdc35939b`, including workflow blob `889abf609c05385c1a7f2b09e7560c14f526deb3` and validator blob `f44a7558a371ba27fdad46533a358329e87d4731`. The following are observed implementation gaps, not hypothetical design concerns:

- `INT-P1-001` — The ordinary full-history scan accepts both exit status 0 and 2, then proceeds to generate and execute the 13-exception necessity scan. It exits with the original status only after that second scan. This violates the hard-precondition rule in Section 10.4: any baseline finding must stop downstream attribution immediately.
- `INT-P1-002` — The ordinary full-history report is not checked for existence, non-zero size, JSON validity, array shape, or zero findings before the next scan. A clean-looking process status alone is not a sufficient report-integrity assertion.
- `INT-P1-003` — The current 13-exception report validator compares only `(Commit, File, StartLine, RuleID)`. It does not validate StartColumn, EndLine, or EndColumn, so it does not satisfy the canonical identity and same-line collision requirements in Section 10.2.
- `INT-P1-004` — The EXIT trap runs `rm -f` on three fixed filenames but does not check cleanup success, preserve/compose original and cleanup statuses, or verify that the workspace is gone. This does not satisfy the checked cleanup contract.
- `INT-P1-005` — Temporary files are placed directly under fixed `$RUNNER_TEMP` names rather than a unique private per-run directory. `umask 077` is present, but uniqueness, directory containment, symlink resistance, and cleanup verification are not established.
- `INT-P1-006` — The current validator serializes a reduced config by manually writing only `title`, `minVersion`, `extend`, and `allowlists`. The current config happens to be narrow, but this is not a general semantic-preservation proof for unknown/future TOML fields. The matrix implementation must use a lossless supported model or fail closed on every unrecognized key/type.
- `INT-P1-007` — The current necessity workflow has two invocations (ordinary full-history and the 13-exception proof); the 16 legacy matrix invocations are not implemented. Do not describe the 16-cell matrix as executed or verified.
- `INT-P1-008` — The 13-exception report check requires status 2 and a non-empty file, but its report is only checked against four fields and the workflow does not yet verify the complete redacted report schema or a pinned binary digest.
- `INT-P2-001` — The current workflow hardcodes a Gitleaks path/version string but does not capture executable SHA-256, fetched-ref manifest, config semantic digest, or before/after snapshot drift evidence.
- `INT-P2-002` — The 30-second per-scan and 180-second aggregate matrix ceilings have not been benchmarked against the exact runner/ref scope. Feasibility is NOT_ESTABLISHED.
- `INT-P2-003` — The current PR change-range scan is delegated to the pinned Gitleaks Action; its exact effective command/config/report behavior must be included in the evidence review rather than inferred from environment variables alone.

Disposition: `CHANGES_REQUIRED`. These gaps block design approval and any matrix implementation. The next implementation candidate, after user approval of the corrected design, must first close the ordinary-scan precondition/report gate and upgrade the existing 13-exception proof to the full identity model, before adding the 16 legacy scans. No change to the workflow, validator, allowlist, or matrix implementation is authorized by this audit note itself.


### 10.12 Normative engineering amendment v3 — oracle, Git patch, runtime semantics, and trigger completeness

This amendment is normative and supersedes any conflicting wording in Sections 1–10.11. It records the user's approval to refine the design only. It does not authorize production-code changes, workflow changes, allowlist changes, matrix execution, merge, or deployment. The implementation boundary in Section 10.10 remains in force.

#### 10.12.1 Independent oracle architecture and provenance

The oracle MUST be independent of the Gitleaks report being evaluated. It MUST NOT derive its expected identities, expected cardinality, or source manifest from a Gitleaks scan output, a previously generated report, or the same code path used to produce the observed report.

The oracle design MUST provide all of the following before implementation approval:

1. A separately versioned source/provenance extractor that reads Git objects and the pinned baseline configuration directly. It must not consume Gitleaks JSON as its source of truth.
2. A separately versioned matcher for the exact required regex dialect and allowlist semantics. Python re MUST NOT be used as a substitute for Go/RE2 semantics. The proposed implementation language/runtime, compiler/toolchain version, executable digest, and source digest must be pinned.
3. A documented semantic contract for global allowlists, rule-level allowlists, match conditions, regex targets, commits, paths, stopwords, inline directives, ignore files, and any other active suppressor. If a semantic rule cannot be independently reconstructed, the affected identity is UNKNOWN.
4. Differential fixtures covering positive, negative, boundary, Unicode, multiline, path-separator, commit, and overlapping-suppressor cases. Fixtures must compare the independent matcher with the pinned Gitleaks behavior without using Gitleaks output to generate expected values.
5. A provenance chain for each expected identity: source commit object, parent relationship, changed path, patch hunk, rule/predicate identifier, and exact source coordinate. Store only non-secret metadata.
6. An independent review record for the oracle implementation and manifest, including reviewer disposition and exact source/tool digests.

Using Go's standard regexp package may be considered because it implements RE2-style semantics, but language choice alone does not establish independence or correctness. The oracle MUST NOT import Gitleaks internals or call the Gitleaks executable to calculate expected results. It must independently implement only the explicitly documented semantics needed by this experiment and fail closed on unsupported semantics.

The oracle MUST include self-tests that demonstrate it is not reading or trusting the observed report. A deliberate mutation of the observed report must change only the comparison result, never the oracle's expected manifest. If oracle and Gitleaks disagree on any required fixture or production candidate, disposition is UNKNOWN/DISPUTED and the matrix cannot PASS.

#### 10.12.2 Git history and patch-visibility semantics

A source line existing in a commit tree is not sufficient evidence that the line was introduced or scanned as a finding in that commit's Git patch. The manifest MUST distinguish tree provenance from patch provenance.

For every source candidate, record and validate:

- the exact commit object SHA and its parent(s);
- the exact path at that commit, including rename/copy handling;
- whether the relevant line is added, context, or unchanged in the commit's patch;
- the exact patch hunk and line mapping needed to connect the source coordinate to the Gitleaks Git scanner's coordinate;
- whether the commit is a merge commit and which parent comparison(s) are in scope;
- whether the pinned Gitleaks 8.30.1 invocation with --log-opts=--all actually visits that commit and patch under the checked-out ref graph.

Do not assume that git show COMMIT:PATH alone proves patch visibility. For merge commits, do not assume a single-parent diff or first-parent behavior without confirming the exact Gitleaks 8.30.1 implementation and invocation semantics. Rename detection, deleted files, binary files, empty commits, and lines present only as unchanged context must be explicitly handled or classified UNKNOWN.

The independent oracle MUST reproduce the exact patch traversal scope of the experiment from Git objects and explicit ref reachability. A candidate that exists in a tree but is not in the scanned patch universe cannot be counted as a detector Finding. A candidate whose patch mapping is ambiguous blocks PASS.

#### 10.12.3 Coordinate contract and Unicode fixture

The canonical identity remains:
(Commit, File, RuleID, StartLine, StartColumn, EndLine, EndColumn).

Before relying on columns, the implementation MUST establish the exact coordinate contract of the pinned Gitleaks v8.30.1 binary:

- whether columns are byte offsets, Unicode code-point offsets, UTF-16 code units, or another unit;
- whether the start coordinate is zero-based or one-based;
- whether the end coordinate is inclusive or exclusive;
- how tabs, CRLF, LF, combining marks, and multi-byte UTF-8 characters affect the reported range;
- whether the report serializer preserves these values without transformation.

Add controlled fixtures containing ASCII, a multi-byte UTF-8 character before the match, combining characters, tabs, and CRLF/LF variants. Record the actual pinned-binary output as test evidence, but keep expected values independently specified in the fixture source. If the coordinate unit or boundary convention cannot be established unambiguously, column-dependent comparisons are UNKNOWN; do not silently normalize or downgrade to line-only identity.

#### 10.12.4 Exact scan-count and execution accounting

The phrase "18 scans" MUST be scoped precisely:

- The direct full-history CLI sequence contains 18 planned invocations: one ordinary baseline scan, one separate 13-exception proof scan, and 16 legacy matrix cells.
- The pull-request change-range scan is a separate workflow action/step and is not a matrix cell or part of the 18 direct full-history invocations.
- The total number of actual Gitleaks process executions across the whole workflow MUST be reported from the exact pinned Action and CLI logs. Do not assert a total of 19 unless the pinned Action is independently shown to invoke exactly one Gitleaks process for that event. If the Action invokes more than one process, report the measured count and explain the distinction.
- Every planned direct invocation must have a stable scan ID, config digest, expected identity multiset digest, report digest (redacted report only), process exit status, start/end timestamp, duration, and snapshot ID.
- Missing, duplicate, reordered, unrecorded, or unexpected invocations are UNKNOWN/fail-closed. A green workflow status alone is not proof that all 18 intended invocations ran.

#### 10.12.5 Behavioral fail-fast verification

Static shell-text assertions are insufficient to prove the hard-precondition behavior.

A behavioral workflow harness MUST replace the Gitleaks executable and Validator with controlled test doubles at the process boundary, then execute the actual workflow shell script (or an extracted, production-identical script) under Bash with strict mode. It MUST prove at minimum:

1. Baseline exit 0 plus a valid empty JSON array permits the next mandatory stage.
2. Baseline exit 2 prevents the validator, 13-exception proof, and every matrix invocation from starting.
3. Unexpected exit codes prevent every downstream stage.
4. Missing, zero-byte, malformed, truncated, non-array, or non-empty baseline report prevents every downstream stage even if the process returns 0.
5. Validator failure, snapshot drift, timeout, and cleanup failure each stop downstream execution.
6. The harness observes real process invocation order/count using an append-only test event log; it must not infer calls solely from mock setup or source-text order.
7. Original process failure combined with cleanup failure preserves the original failure evidence and still returns non-zero.

The test must demonstrate a genuine RED against the current behavior for the intended reason, then GREEN against the corrected implementation. Syntax/import/setup errors do not count as RED.

#### 10.12.6 Workflow trigger completeness and large-diff behavior

The security-critical allowlist-integrity workflow MUST NOT depend solely on GitHub Actions paths filtering for whether it runs. GitHub's path-filter evaluation has documented limits for large diffs; a change set exceeding the evaluation limit can prevent the expected workflow from being triggered.

Preferred design: trigger the security-critical workflow on every relevant pull_request and push event without a restrictive paths filter, then perform an inexpensive in-workflow changed-path decision while always running the policy-integrity guard for changes to security-sensitive files. If an alternative is proposed, it must demonstrate equivalent coverage for diffs beyond 3,000 files, renames, deletions, merge queues, and branch updates.

The workflow MUST also declare and test the intended events and branch scope. It must not rely on a schedule as a substitute for required PR/push checks. Required status-check identity must remain stable and must not be bypassed by a skipped workflow or renamed job.

A deterministic trigger-coverage test MUST model a change set larger than 3,000 files with the security-sensitive file outside the first 3,000 changed paths and prove that the required workflow still starts and produces the expected check. If this cannot be demonstrated in GitHub Actions, the trigger design is not approved.

#### 10.12.7 Updated acceptance suite additions

The acceptance suite MAT-001 through MAT-022 remains mandatory. Add these unique tests:

23. MAT-023 Independent oracle expected identities are generated only from Git objects, pinned source config, and the separately reviewed manifest; mutation of the observed Gitleaks report cannot mutate the oracle.
24. MAT-024 Oracle RE2/allowlist semantics are pinned and differential fixtures cover global/rule allowlists, conditions, regex targets, paths, commits, inline ignores, and overlap; unsupported semantics produce UNKNOWN.
25. MAT-025 Git patch provenance is proven for every candidate, including merge commits, parent selection, renames, deleted paths, and unchanged context lines; ambiguous patch mapping fails closed.
26. MAT-026 Pinned Gitleaks coordinate units and boundaries are empirically established with UTF-8, combining-mark, tab, CRLF, and LF fixtures.
27. MAT-027 Behavioral fail-fast harness proves that baseline findings, invalid reports, unexpected exit codes, validator errors, drift, timeout, and cleanup failure prevent all downstream invocations.
28. MAT-028 Invocation ledger proves exactly 18 planned direct full-history CLI invocations, with the PR-diff Action accounted separately using measured process evidence.
29. MAT-029 Trigger coverage test proves the required security workflow runs for a change set exceeding 3,000 files, including a security-sensitive file outside the first 3,000 paths.
30. MAT-030 Oracle, compiler/toolchain, executable, source manifest, patch traversal, and coordinate-contract digests are bound to the same immutable experiment snapshot.

The implementation MUST link every MAT-* ID to an executable test name, source file, exact commit SHA, exact evidence run, and observed disposition. Tests that only inspect YAML/shell text do not satisfy behavioral contracts.

#### 10.12.8 Design disposition and approval boundary

The design remains CHANGES_REQUIRED until all requirements in Sections 10.1–10.12 are implemented in the specification, internally consistent, and independently reviewed. The next deliverable is another exact-HEAD design review followed by a separate hostile review. No matrix code, production workflow modification, validator change, allowlist edit, runtime mutation, merge, or deployment is authorized by this amendment.

The existing 18-scan design remains a proposal. Feasibility, Oracle validity, coordinate semantics, Git patch attribution, and trigger completeness are not established merely by this document or by the currently green CI runs.

### 10.13 Normative engineering amendment v4 — rule scope, multiplicity, and trigger-test consistency

This amendment is design-only and supersedes any conflicting wording in Sections 1–10.12. It does not authorize implementation, workflow or validator changes, matrix execution, allowlist changes, merge, or deployment.

#### 10.13.1 Legacy rule-scope and detector-oracle completeness

Section 3's statement that every source record uses the `generic-api-key` rule is incorrect for the 15 inherited legacy entries and is superseded.

- For each legacy entry, derive its actual scope from the exact parsed baseline TOML object. Preserve the complete `targetRules` array exactly; if `targetRules` is absent, classify the entry as global-scope. Never infer `generic-api-key` for all legacy entries.
- The currently pinned configuration includes legacy entries scoped to rule IDs other than `generic-api-key` (including `curl-auth-header`, `aws-access-token`, and `jwt`). The manifest and oracle must represent the actual rule IDs and all relevant rule scopes.
- The independent oracle must reconstruct the detector semantics needed to produce each expected Finding, not only the allowlist predicate. For every in-scope rule ID, pin and model the effective rule definition after default-config inheritance and project overrides, including regex dialect, capture-group/secret-group selection, entropy threshold, path gating, required-rule dependencies, and the exact patch-fragment/line mapping that determines Finding coordinates. Keyword prefiltering may be omitted only if it is proven to be a semantics-preserving optimization for the relevant rule.
- The oracle must separately model the global and rule-level allowlist matching semantics that suppress those detector findings. Unsupported rule features, unresolved inheritance, or incomplete fragment semantics force UNKNOWN; do not replace them with a generic-api-key-only approximation.
- The 13 new line exceptions and two synthetic fixtures retain their currently configured rule scopes; this does not imply that the 15 legacy entries share those scopes.

#### 10.13.2 Canonical identity and multiset reconciliation

Sections 10.1 and 10.2 must be read together as follows; this clause resolves their duplicate-record wording.

- Keep `E_i) as the set of unique canonical Finding identities whose suppression is attributable to legacy entry `L_i`. Keep the many-to-many attribution relation separate: one detector Finding matched by multiple suppressors is still one detector Finding and must not be multiplied by the number of suppressors.
- Construct the expected report as a counted multiset from independently reconstructed detector occurrences and patch provenance. Its multiplicity must be justified by distinct detector occurrences, not by overlapping allowlist matches or source-entry count.
- Compare expected and observed counted multisets over the full canonical identity. An observed duplicate is rejected when the pinned report/detector contract establishes that the same full identity cannot legitimately occur more than once. If identical full identities could represent distinct legitimate occurrences and the oracle cannot distinguish or independently count them, classify the affected comparison UNKNOWN rather than silently deduplicating or rejecting it.
- Therefore, do not apply Section 10.1's phrase “each expected identity occurs exactly once” as an unconditional duplicate rule. It means once per independently established detector occurrence. Section 10.2's multiplicity-sensitive rule controls; no lossy set conversion is permitted.

#### 10.13.3 Trigger acceptance test replaces the legacy path-filter assertion

The existing test `test_allowlist_integrity_workflow_covers_all_branches_for_security_paths`, which requires exact restrictive `paths` lists for `pull_request` and `push`, is incompatible with Section 10.12.6 and MUST be replaced as part of the future implementation. It must not remain as a required acceptance test in its current form.

The replacement acceptance contract must verify that:

1. The security-critical integrity job is scheduled for every intended PR/push event and protected target branch without relying solely on GitHub's path-filter evaluation.
2. If an internal changed-path decision is used, the workflow/job still produces the stable required check identity; a job-level condition must not suppress the entire check for non-matching paths.
3. The workflow declares the intended branch and event scope. If the repository uses merge queues, `merge_group` coverage is explicit and tested; if it does not, that absence is recorded from repository configuration rather than assumed.
4. A change set exceeding 3,000 files, with a security-sensitive path outside the first 3,000 changed paths, still starts the required workflow and produces the expected check in GitHub Actions.
5. Rename, deletion, branch-update, and merge-queue cases are covered by deterministic tests or are explicitly marked unsupported/UNKNOWN.

A source-text assertion that a particular `paths` list exists is not trigger-coverage evidence. An alternative filtered-trigger design is acceptable only if it demonstrates equivalent coverage in GitHub Actions under the large-diff and event cases above.

#### 10.13.4 Design disposition

These clarifications are required for internal consistency and a valid independent oracle. The design remains `CHANGES_REQUIRED / DESIGN_NOT_APPROVED` until the complete specification is reconciled and independently reviewed. No executable implementation or matrix run is authorized by this amendment.

### 10.14 Normative engineering amendment v5 — stable identity joins and cleanup gate semantics

This amendment is design-only and supersedes conflicting wording in Sections 1–10.13. It does not authorize implementation, workflow or validator changes, matrix execution, allowlist changes, merge, or deployment.

#### 10.14.1 Descriptions are metadata, never identity keys

Section 10.3 requires stable manifest identities and exact parsed-object binding. This clause makes the join contract explicit:

- A human-readable TOML `description` is mutable metadata and MUST NOT be used as the primary key for manifest lookup, entry removal, expected-finding selection, or provenance joins.
- Each manifest record MUST have a stable `source_id`. Bind each TOML object using the exact baseline/current config blob SHA, canonical parsed-object digest, and object ordinal/index. Preserve the complete parsed object for semantic comparison. If duplicate canonical objects exist, the object index is required to disambiguate them; if the binding remains ambiguous, classify UNKNOWN.
- Any description-to-record mapping may be used only as a diagnostic cross-check. A changed, duplicated, missing, or edited description must not silently retarget an exception or change which object is removed.
- Acceptance tests MUST mutate descriptions (including swaps between two records) while keeping the underlying object and manifest fixed, and prove that object identity, removal selection, and expected findings do not change. A mismatch must fail closed.
- The implementation currently uses description strings as keys in `EXPECTED_LINE_EXCEPTIONS` and `EXPECTED_FIXTURES`, and uses those keys to select/remove entries. This is a known implementation gap, not acceptable evidence of the stable-identity contract.

#### 10.14.2 Cleanup failure timing and fail-fast semantics

Sections 10.7 and 10.12.5 are reconciled as follows:

- An EXIT trap executes only after the main script body has stopped; therefore terminal EXIT-trap cleanup failure cannot prevent downstream stages that already ran. The specification MUST NOT claim that a terminal EXIT-trap failure retroactively stops downstream execution.
- Any cleanup operation that is a precondition for a subsequent stage MUST be performed synchronously before that stage, and its status checked before the next process starts. A failure blocks all later stages.
- Terminal workspace cleanup MUST still run on every exit path, verify that the private workspace no longer exists, and force the overall workflow result to non-zero if cleanup fails. If the main body already failed, preserve its original failure status/evidence and record cleanup failure separately; if the main body passed, cleanup failure changes the final result to failure.
- The behavioral harness MUST distinguish (a) an intermediate cleanup failure, which prevents the next invocation, from (b) terminal cleanup failure, which prevents a green final result but has no later invocation to suppress. It must test both cases with the append-only event ledger.
- Signal handling, timeout termination, child-process reaping, EXIT handling, and cleanup status composition MUST be specified as one deterministic lifecycle contract; no secret-bearing data may be emitted during failure handling.

#### 10.14.3 Design disposition

Stable object identity and temporally correct cleanup gates are required for a sound necessity proof. The design remains `CHANGES_REQUIRED / DESIGN_NOT_APPROVED` until this amendment and all earlier requirements are independently reviewed. No executable implementation or matrix run is authorized.


---

## 10.15 Normative engineering amendment v6 — exact Git-history input and detector error propagation

This amendment is design-only and supersedes conflicting wording above. It does not authorize implementation, matrix execution, allowlist changes, merge, or deployment.

### 10.15.1 Pin the actual Git input command and ref universe

The Gitleaks v8.30.1 source contract was inspected at tag `v8.30.1`, including `cmd/git.go` and `sources/git.go`. When `--log-opts` is empty, Gitleaks constructs `git log -p -U0 --full-history --all --diff-filter=tuxdb`. When non-empty, the user-supplied log options are appended instead of the default options; therefore the matrix MUST NOT assume that setting a non-empty option preserves the default `--full-history`, `--all`, or diff-filter behavior.

Before any scan, record a redacted immutable Git-input manifest bound to the experiment snapshot:
- exact Gitleaks executable/version and source-tag identity;
- exact effective Git command argument vector (no shell-string ambiguity);
- exact commit graph and ref names/SHAs included in the scan, including whether refs are local, remote-tracking, tags, and pull-request refs;
- repository object completeness (no shallow boundary or missing object) and checkout HEAD;
- relevant Git configuration affecting diff/rename behavior, or an explicit hermetic configuration;
- any custom `--log-opts`, with a proof that it preserves the intended scan universe.

Prefer the pinned Gitleaks default full-history command unless a custom command is necessary and separately proven equivalent. If the intended scan universe requires refs not included by Gitleaks' `--all`, fetch them explicitly before the experiment and pin them; do not silently expand refs during the matrix. Missing objects, changed refs/HEAD, shallow history, unexpected command arguments, or unresolved Git configuration makes the run UNKNOWN and blocks downstream scans.

### 10.15.2 Patch-fragment semantics and coordinate provenance

The pinned source implementation parses Git patch output; deleted files are skipped, ordinary text scans added text fragments with zero-context patches, and the fragment path is the patch's new path. Binary non-archive files are skipped; archive files use blob extraction and have distinct provenance behavior. Therefore the independent oracle MUST:
- model added-line fragment scanning and exact commit/path mapping, not whole-file regex scanning;
- explicitly cover deleted files, renames/copies, mode-only changes, binary files, archive files and nested archive limits, merge commits/parent semantics, and empty/no-addition commits;
- prove how source-line and column coordinates are calculated from the patch fragment and detector match, including UTF-8/Unicode and line-ending fixtures;
- account for the exact path used by Gitleaks for renamed files and the rule/path gating applied to that path;
- reject any candidate whose patch-fragment mapping is ambiguous or cannot be independently reproduced.

No source-line or secret-bearing content may be retained as proof artifacts.

### 10.15.3 Error propagation is an observable contract

Gitleaks v8.30.1's Git source reports non-benign Git stderr as scan errors; it also treats several known Git warnings as benign. The implementation harness MUST not infer success from a generated report alone. Capture and independently validate process exit code, timeout/termination status, stderr disposition (redacted, with benign-warning allowlist pinned), report validity, and invocation completion. Prove that the workflow's wrapper/action does not mask a Git-source error or convert an incomplete scan into a clean result. Any non-benign stderr, failed Git subprocess, incomplete fragment stream, or discrepancy between process status and report is UNKNOWN/FAIL and prevents every downstream invocation.

### 10.15.4 Acceptance tests

Add unique executable tests:
- MAT-031: non-empty `--log-opts` cannot silently remove required history/ref/diff coverage; effective argv and ref inventory are exact.
- MAT-032: shallow/missing-object or changed-ref/HEAD detection blocks scans.
- MAT-033: fragment oracle covers additions, deletions, renames, copies, mode-only, merge commits, binary/archive behavior, and path-gating against the pinned source.
- MAT-034: non-benign Git stderr, subprocess failure, fragment-stream error, timeout, or wrapper exit-status masking prevents downstream invocations and cannot yield PASS.
- MAT-035: coordinate oracle verifies pinned Gitleaks patch-fragment coordinate semantics for same-line multiple findings and UTF-8/CRLF/tab boundary fixtures.

Each test must be linked to its executable name, source file, exact commit, evidence run, and disposition under Section 10.12.7. Static source inspection alone is insufficient.

### 10.15.5 Design disposition

The exact Git-input scope and error-propagation contract are necessary to make the independent oracle falsifiable. The design remains `CHANGES_REQUIRED / DESIGN_NOT_APPROVED`. No implementation or matrix scan is authorized.


---

## 10.16 Normative engineering amendment v7 — actual workflow history-coverage mismatch

This amendment is design-only and supersedes conflicting assumptions in Sections 1–10.15. It does not authorize workflow implementation, matrix execution, allowlist edits, merge, or deployment.

### 10.16.1 Exact observed invocation versus pinned Gitleaks source contract

The exact current workflow file `.github/workflows/secret-history-scan.yml` contains both full-history invocations with non-empty `--log-opts="--all"`:

- ordinary baseline: `gitleaks git ... --log-opts="--all" .`;
- existing 13-exception proof: `gitleaks git ... --log-opts="--all" .`.

At pinned Gitleaks v8.30.1 source `sources/git.go`, a non-empty `logOpts` selects the custom-argument path: Gitleaks constructs `git -C <repo> log -p -U0` and appends the user-supplied tokens. The default empty-`logOpts` path instead includes `--full-history --all --diff-filter=tuxdb`. Therefore the present workflow's custom `--all` invocation does **not** preserve the pinned default `--full-history` or `--diff-filter=tuxdb` options.

This is a verified current-workflow input-coverage gap, not a hypothetical design concern. The successful current runs cannot be treated as proof of the intended full-history universe until the invocation is corrected and independently verified.

### 10.16.2 Required future implementation contract

The implementation must choose and pin one of these paths:

1. **Preferred default path:** omit `--log-opts` entirely, relying on the pinned v8.30.1 default argv, then verify the effective argv and ref universe; or
2. **Explicit equivalent path:** provide a documented exact argv that includes and proves the intended `--full-history`, `--all`, and required diff-filter behavior, with no quoting/splitting ambiguity and no unsupported/changed semantics.

For either path:
- capture the actual Git subprocess argv from a behavioral test, not merely workflow source text;
- compare it against the immutable experiment-input manifest;
- pin all refs intended for coverage and establish object/history completeness;
- demonstrate a fixture commit that is reachable but omitted by simplified history is detected under the selected contract;
- fail closed if the workflow invocation is altered, any intended ref/object is absent, or argv differs from the manifest.

The baseline, 13-exception proof, and all 16 matrix scans must share the same verified Git-input contract and immutable snapshot. A PR-diff Action is a separate scan surface and must remain separately accounted for.

### 10.16.3 Acceptance tests

Add executable acceptance tests:
- **MAT-036:** exact workflow invocation contract — fail against the current `--log-opts="--all"` configuration because it omits the pinned default `--full-history` and `--diff-filter=tuxdb` options; pass only after the invocation is corrected and actual subprocess argv matches the manifest.
- **MAT-037:** history-simplification counterexample — fixture proves the intended reachable commit/finding is absent under the current simplified command but included under the corrected pinned command; no secret values in fixture output.
- **MAT-038:** invocation parity — baseline, 13-exception proof, and each matrix cell use the same verified Git-input manifest and ref/object snapshot; any drift blocks downstream execution.

These tests must be behavioral, tied to exact executable/test names, exact commit SHA, evidence run, and disposition. Static YAML string checks alone are insufficient.

### 10.16.4 Disposition

The current workflow's history-coverage gap is a P1 hostile blocker for a necessity matrix or any claim of complete reachable-history scanning. Existing successful CI is bounded to the command actually executed and does not close this gap. The design remains `CHANGES_REQUIRED / DESIGN_NOT_APPROVED`. No workflow/code change or matrix execution is authorized by this amendment.


---

## 10.17 Normative engineering amendment v8 — executable independent-oracle architecture and patch-provenance proof boundary

This amendment is design-only. It supersedes any conflicting oracle/provenance language in Sections 1–10.16. It does not authorize implementation, workflow/validator changes, matrix execution, allowlist edits, merge, or deployment.

### 10.17.1 Newly identified design gap

Sections 10.12.1 and 10.13.1 require an independent oracle, RE2 semantics, effective detector behavior, and patch-fragment provenance, but do not yet specify a concrete executable oracle architecture, its trust boundary, an independent detector algorithm, or a proof that the oracle's expected identities cannot be derived circularly from the tested Gitleaks report or same detector implementation.

This is a design-completeness gap. The presence of MAT-023–MAT-026 does not close it until the tests exercise a concrete architecture and pinned implementation.

### 10.17.2 Required oracle decomposition and trust boundary

Before approval, define and pin three independently auditable components:

1. **Git-history/patch provenance oracle:** reads Git object graph and explicit pinned refs; independently enumerates commit-parent comparisons and changed-file/patch records; maps each candidate to commit, path, patch status, source coordinates, and scan-scope disposition. It must not consume Gitleaks JSON or invoke Gitleaks to determine expected patch visibility.
2. **Detector-semantic oracle:** independently evaluates the exact effective detector configuration and required rule semantics for each in-scope patch fragment. It must not import Gitleaks detector/report/config implementation packages, invoke Gitleaks as its expected-result generator, or reuse the workflow's report parser/comparator. Pin the language/runtime, RE2-compatible engine, source, executable, and dependency digests. Document which rule semantics are supported and the exact semantics of regex/capture groups, keywords, entropy, path gates, required rules, decoding/archive behavior, and coordinates. Unsupported semantics or unproved equivalence are UNKNOWN.
3. **Suppression-attribution oracle:** independently models the complete effective suppression inventory and many-to-many matching attribution, including inherited defaults and all non-target suppression sources. It must produce candidate identity-to-suppressor relations before computing expected all-out/one-out results; no description-keyed lookup and no subtraction shortcut unless independently proven.

A component may be shared only if the independence claim is narrowed, the shared component is explicitly in the trust boundary, and an independent cross-check is provided. No claim of complete independent oracle may be made merely because a report is redacted or its JSON parser is separate.

### 10.17.3 Immutable oracle output schema and reconciliation

Define a versioned, deterministic, redacted output contract with:
- experiment snapshot ID and exact Git/ref/object/config/toolchain digests;
- source occurrence ID and patch-provenance record;
- canonical full-coordinate identity and independently justified occurrence multiplicity;
- detector rule/predicate identity and match-span/coordinate evidence (without secret-bearing text);
- suppression source IDs and many-to-many attribution edges;
- explicit scan-universe inclusion/exclusion reason;
- per-record status SUPPORTED, DISPUTED, or UNKNOWN, plus aggregate status.

Expected matrix multisets must be derived only from this oracle output. The observed Gitleaks report is a separate input to reconciliation. Mutating, deleting, adding, reordering, or duplicating observed report records must not change oracle output. A mismatch, unresolved attribution, unsupported detector semantics, or incomplete patch provenance is UNKNOWN/CHANGES_REQUIRED—not a count-based PASS.

### 10.17.4 Patch-provenance exact contract

For pinned v8.30.1 and selected Git-input manifest, specify and test:
- commit/ref enumeration and whether every merge commit is compared against each parent or a specific parent policy; no implicit first-parent assumption;
- path identity for rename/copy records and old/new path handling;
- added-line-only eligibility, source coordinate mapping, and how deleted/context/mode-only/empty commits are excluded or handled;
- binary, symlink, submodule, archive, nested archive, and size/decode-limit behavior;
- deterministic patch serialization/parser behavior, hunk-to-source coordinate mapping, line endings, tabs, multi-byte UTF-8, combining marks, and same-line multi-finding collisions;
- explicit reconciliation of independent patch enumerator output with pinned Gitleaks source behavior on bounded fixtures, including counterexamples and unsupported cases.

If a Git feature is unsupported by the oracle, it must be excluded from the pinned experiment universe by an explicit, verified contract or make the experiment UNKNOWN. Do not silently omit it.

### 10.17.5 Acceptance tests

Add uniquely identified behavioral tests:
- MAT-039: oracle independence — prove no Gitleaks package/report/parser or workflow comparator dependency; observed-report mutations do not alter expected oracle output.
- MAT-040: deterministic oracle output — same pinned snapshot yields byte-identical canonical manifest; any source/config/tool/ref drift changes the snapshot and blocks use.
- MAT-041: detector semantic differential suite — exact supported rule feature matrix and differential fixtures; unsupported features yield UNKNOWN rather than guessed expected findings.
- MAT-042: suppressor-attribution graph — overlapping suppressors, global/rule scopes, defaults, inline ignore, ignore-file and path exclusion are represented without double-counting detector occurrences; description mutations/swaps do not retarget IDs.
- MAT-043: patch provenance counterexamples — merge-parent, rename/copy, additions vs unchanged context, deletion, mode-only, binary/archive, symlink/submodule, and coordinate boundary cases; compare oracle to pinned behavior with explicit dispositions.
- MAT-044: oracle/report separation — expected output is frozen before report ingestion; adversarial report mutation (add/remove/duplicate/reorder/corrupt identity) changes only reconciliation result, never expected identities.

Tests must be executable and tied to source/test names, exact commit, dependency/toolchain digests, fixture inventory, evidence run, and disposition. Static checks alone are insufficient.

### 10.17.6 Disposition and approval boundary

The independent-oracle architecture and patch-provenance proof boundary are not yet concretely implemented or experimentally validated. This is a P1 design blocker. The design remains CHANGES_REQUIRED / DESIGN_NOT_APPROVED. No code/workflow changes, matrix execution, allowlist mutation, merge, or deployment are authorized.
