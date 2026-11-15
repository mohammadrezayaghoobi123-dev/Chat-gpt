# Gate 2P — R2.1 Script Static Review and Artifact Record

**Status:** REVIEW ARTIFACT — STATIC CHECKS PARTIAL; NOT APPROVED FOR LIVE EXECUTION  
**Date:** 2026-11-15  
**Script version:** 2.1.0  
**Standalone artifact:** `mb-r2-github-idempotency-experiment-v2.1.sh`  
**SHA-256:** `c6ed67f347b2f5f719046dd2f53fd2666ebee1107bbe491e22a234518592b463`

## 1. Scope and authority

This record documents a locally prepared script artifact for controlled R2.1 review. The script has **not** been committed to this repository. This document does not authorize live execution, GitHub writes, merge, deployment, production retries, or cleanup.

## 2. Verification results

| Check | Result | Evidence / limitation |
|---|---|---|
| Bash parser | PASS | `bash -n` completed without syntax errors |
| Offline dry-run | PASS | Explicitly reported no GitHub API calls and no writes |
| Live GitHub API integration | NOT_RUN | GitHub CLI `gh` is not installed in the review environment |
| ShellCheck | NOT_RUN | ShellCheck is not installed |
| Real GitHub writes | NOT_RUN | No repository writes were performed |
| Lost-response fault injection | NOT_IMPLEMENTED / NOT_RUN | Requires a controlled transport/proxy harness |
| D-04 | UNVERIFIED | No empirical API evidence exists |

## 3. Controls present in the script

- Offline dry-run is the default; only exact `R2_APPLY=yes` enters the write path.
- Requires exact repository name, numeric repository ID, expected base SHA, high-entropy run ID, disposable-repository acknowledgement, PR-notification acknowledgement, and a second typed confirmation immediately before the first write.
- Requires a private, non-archived repository and rejects the known Master Brain repository name.
- Performs read-only identity, repository, baseline, and branch preflight before writes.
- Captures process exit code, HTTP status, GitHub request ID, request payload digest, response body digest, stderr digest, transport classification, and elapsed time.
- Does not retry ambiguous or unknown outcomes.
- Uses explicit page-by-page PR traversal and verifies the PR head/base, repository ID, marker, commit/tree/ref linkage, and retrieved blob bytes.
- Does not automatically delete or clean up any artifact.

## 4. Residual limitations

1. The script characterizes selected GitHub API behavior; it cannot prove general Exactly-Once semantics.
2. It does not implement a transmitted-request/response-dropped fault injection. R2-LOSS remains NOT_RUN.
3. No live GitHub CLI/API integration test or ShellCheck run was possible in this environment.
4. The disposable-repository and notification acknowledgements are operator assertions, not cryptographic proof that the repository contains no valuable data or has no unintended collaborators.
5. The script still requires independent adversarial review and a controlled mocked-API test before any real-write execution.
6. A successful R2 run cannot independently authorize production retries.

## 5. Non-actions

No GitHub branch, tree, commit, ref, issue, or PR was created by this review. No merge, deployment, Cloudflare, Supabase, or laptop operation was performed.

**Disposition:** Script artifact prepared for review only. Live execution remains blocked. D-04 remains UNVERIFIED.
