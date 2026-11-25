# EGIS-FM-006 — Independent Reassessment of Verification Gate v1.1.1

**Status:** Candidate reassessment; execution remains NOT_RUN  
**Date:** 2026-11-25  
**Initial reviewed commit:** 95f5a7918c0a24bf6e649193ebf3e559cda9fa36  
**Remediation head:** e7ed42327b90ec2013c3f69c951954681037a055  
**Scope:** PR #475 source, tests, PR metadata, and GitHub Actions evidence

## Evidence observed

- PR #475 remains OPEN and DRAFT; it is not merged.
- The exact PR-diff Gitleaks scan completed successfully and reported no leaks across the 11-commit PR range.
- The full fetched-ref/history scan failed on 13 generic-api-key detections in historical commits and paths outside the PR diff:
  - cloud-engineering-connector/worker.js
  - cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js
  - tools/9router-review/review.test.mjs
  - docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md
- These detections are not proven credentials or proven false positives by this run. Each requires independent classification and, if real, revocation/rotation. Do not suppress them merely to obtain a green check.
- Both observed check runs failed at the full-history scan step; the PR-diff scan step passed.
- Python unit tests, SANY, and TLC remain NOT_RUN. No formal verification result is claimed.

## Additional hostile findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-060 | High | Relative input paths were not anchored to --root. | Fixed in candidate: jar/module/config/output paths now resolve against root; regression tests cover relative resolution. |
| FMH-061 | Medium | Timeout output may be bytes and break JSON serialization. | Fixed in candidate: UTF-8 decoding with replacement; regression test exercises bytes output and JSON serialization. |
| FMH-062 | Medium | The mocked tests do not exercise subprocess.run, actual Java discovery, actual SANY/TLC invocation, or output parsing. | Open; add CI unit execution and a separately controlled real-tool verification run |
| FMH-063 | High | TLC success is accepted from process exit code alone. The runner does not require a complete TLC summary, expected invariant inventory, state counts, or absence of truncated/ambiguous output. | Open; independent output parser and negative/mutation fixtures required |
| FMH-064 | Medium | Java runtime identity/version and execution environment provenance are absent from evidence. | Open; record Java version and relevant platform/runtime metadata |

## Security interpretation

The PR-diff scan passing establishes only that Gitleaks found no leak in the scanned PR change range under the current configuration. The full-history scan failure remains a repository-level security finding. No allowlist change, history rewrite, or credential rotation was performed in this reassessment.

## Remediation and CI evidence

- FMH-060 and FMH-061 were addressed in the remediation head.
- A minimal Python 3.11 GitHub Actions workflow was added with read-only contents permission, checkout credentials disabled, compileall, and mocked unit tests.
- First CI execution compiled successfully and ran 13 tests; 12 passed and one exposed a separate status-classification defect: an expected-commit mismatch was classified BLOCKED instead of FAIL.
- That defect was corrected: dirty checkout and commit mismatch are FAIL; unavailable Git metadata is BLOCKED. A dedicated regression test now covers unavailable metadata.
- The latest remediation-head unit-test run was queued at the time of this report; its final result is not yet established.
- Full-history Gitleaks findings remain independent and unresolved.

## Required next atomic increment

1. Confirm the remediation-head Python CI result and correct any newly exposed defect.
2. Keep the full-history secret findings visible; classify each detection against its exact historical content and determine whether revocation is required.
3. Implement independent TLC summary/invariant/trace validation before treating a gate result as formal verification.
4. Capture Java runtime provenance and artifact attestation.
5. Re-run hostile review against the resulting exact commit.

## Promotion decision

**NOT READY FOR MERGE OR PROMOTION.** PR #475 remains a draft candidate. No merge, runtime change, secret change, deployment, branch retargeting, or laptop operation was performed.
