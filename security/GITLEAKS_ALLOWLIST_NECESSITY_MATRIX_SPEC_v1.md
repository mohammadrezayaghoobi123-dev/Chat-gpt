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
- Generate all temporary configs and reports under `$RUNNER_TEMP`, set `umask 077`, and remove every temporary file through an EXIT trap.
- Use the exact Gitleaks binary/version already provisioned by the workflow. No network fetch or floating tool version is permitted in the matrix step.
- Every scan must use the same checked-out commit graph and fetched refs. A missing ref, incomplete history, changed HEAD, timeout, malformed report, or budget exhaustion is a hard failure / UNKNOWN.
- Never convert an UNKNOWN or failed scan into PASS.

## 3. Oracle contract

Before matrix execution, construct a redacted, independently reviewable source-tuple manifest for the 15 legacy entries. Each tuple is:

`(commit, repository-relative path, start line, rule ID)`

The manifest must:
1. Be derived from the exact pinned source commits and paths in the trusted `origin/main` baseline.
2. Record the exact source line number and `generic-api-key` rule ID, but never store or print the source line or any matched value.
3. Reject missing commits, missing paths, invalid line numbers, duplicate descriptions, duplicate tuple identities, and non-unique source provenance.
4. Be reviewed independently against the 15 baseline entries before it is used as an oracle.
5. Be immutable during a matrix run and bound to the exact workflow commit and baseline blob identity.

The previously observed candidate count of 43 is a hypothesis, not a hard-coded truth. If fresh reconstruction does not produce the same manifest, stop and classify the result UNKNOWN pending reconciliation. Do not regenerate the expected manifest from Gitleaks output.

Let (E_i) be the independently reviewed tuple set for legacy entry (i), and (U = \bigcup_{i=1}^{15} E_i). The matrix is valid only when the tuple sets and their overlap relationships are explicitly represented; no assumption of disjointness may be inferred from counts alone.

## 4. Required Gitleaks/RE2 matrix

Run exactly 16 diagnostic scans after the ordinary full-history scan:

### A. All-out control (one scan)

Create a temporary config by removing exactly the 15 legacy entries from the current 30-entry config. Retain all 13 new line exceptions and both special fixtures byte-for-byte.

Let `N` be the independently reconstructed tuple set covered by the 13 new exceptions and 2 special fixtures. Expected redacted report tuple set: exactly `U − N`. The preflight hypothesis is `U ∩ N = ∅`, in which case this equals `U`; the matrix must verify rather than assume that condition. The comparison is order-independent, and every tuple must occur exactly once. Missing, extra, duplicate, malformed, or out-of-scope tuples fail the matrix.

### B. One-out variants (15 scans)

For each legacy entry (i), create a temporary config from the original current config by removing exactly entry (i), preserving every other entry byte-for-byte.

Expected redacted report tuple set: exactly `E_i − (union(E_j for j != i) ∪ N)`. This is the subset uniquely suppressed by entry `i` while every other legacy entry and all new/fixture entries remain active. If there is no overlap, the expected report is exactly `E_i`, not `U − E_i`. Shared tuples remain suppressed by another active entry and cannot establish unique necessity in this one-out run. Any overlap or unexpected delta is DISPUTED/UNKNOWN and requires isolated attribution; do not label the entry redundant or overbroad automatically. Compare exact tuples, reject duplicate records, and require each expected tuple exactly once.

### C. Isolated attribution (conditional; not part of the 16-scan baseline)

If any one-out result indicates masking, an unexpected tuple, or ambiguous attribution, stop the baseline matrix. A separately specified and reviewed diagnostic may isolate the implicated entry while disabling competing entries. Do not silently add unbounded scans to the baseline budget.

## 5. Per-scan execution contract

For every scan:
- Invoke the pinned Gitleaks binary with explicit temporary config, `--redact`, JSON report output, and the same full-history Git log scope.
- Capture process exit status without disabling shell fail-fast behavior globally.
- Require exit code 2 when the expected tuple set is non-empty and exit code 0 when it is empty. Any mismatch between status and expected cardinality, or any other exit code, is an execution failure.
- Require a non-empty, parseable JSON array.
- Validate each record's types and exact tuple fields. Reject Boolean values where integer line numbers are required.
- Compare exact tuple multisets, not only counts or set cardinalities.
- Emit only scan identifier, duration, exit status, expected count, observed count, and comparison disposition. Never emit report contents.

## 6. Resource and cost controls

- Per-scan timeout: 30 seconds.
- Aggregate matrix wall-clock budget: 180 seconds, measured with a monotonic clock.
- Maximum diagnostic scans: 16 in the baseline matrix.
- Any timeout, retry, missing scan, malformed report, clock/budget breach, or incomplete cleanup fails closed as UNKNOWN.
- No automatic retry. A retry requires a new workflow run and a fresh exact-head evidence record.
- Keep the workflow's existing overall job timeout as an outer safety bound.

## 7. TDD and adversarial acceptance tests

Before enabling the matrix in the workflow, add tests that prove:
1. All-out config removes exactly the 15 baseline entries and retains the 13 new entries plus 2 fixtures byte-for-byte.
2. Each one-out config removes exactly one uniquely identified baseline entry and preserves all others byte-for-byte.
3. Duplicate descriptions and duplicate tuple identities are rejected.
4. Missing, extra, duplicate, malformed, wrong-rule, wrong-commit, wrong-path, and wrong-line findings are rejected.
5. Tuple comparison is order-independent but multiplicity-sensitive.
6. A Python-derived manifest mismatch against the independently reviewed manifest is UNKNOWN, never silently accepted.
7. Gitleaks exit codes 0, 2, and unexpected non-zero codes are classified correctly.
8. Per-scan timeout, aggregate timeout, scan omission, report truncation, malformed JSON, and cleanup failure all fail closed.
9. A failure in any matrix cell prevents a green aggregate result.
10. No test, log, artifact, or workflow output contains secret values, source-line contents, or unredacted report material.

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
