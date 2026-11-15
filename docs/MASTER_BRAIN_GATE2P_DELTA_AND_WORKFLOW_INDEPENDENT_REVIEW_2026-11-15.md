# Gate 2P — Independent Delta and Workflow Review (2026-11-15)

**Status:** LIMITED STATIC REVIEW — NOT APPROVED  
**Compared:** 5d55336feef7f27c3ec8b02bb7b8dab4dab0d768 → 5d8ae8c5c096356f0f64a68a46f874374b5a34b8  
**PR #229:** head 871e98b1d101a47d318b597c9c9520ad19976494; base 5d8ae8c5c096356f0f64a68a46f874374b5a34b8  
**Review branch:** review/gate2p-v21-r2-audit-2026-11-15

## 1. Executive result

- GitHub compare reports 50 commits ahead and 0 behind from 5d55336 to 5d8ae8c.
- The compare response lists 45 added files: 42 Markdown documents, two JSON documents and one GitHub Actions workflow.
- Five critical implementation/configuration blobs were fetched at both commits. Their blob SHAs match exactly. This proves byte-identical content for those five paths only.
- The workflow was fetched and read in full: 19,073 characters, 393 lines. Static risk appears low within the inspected scope, but this is not a security approval.
- The 42 Markdown documents and two JSON files were not content-reviewed as a set. Their correctness, internal consistency, provenance and executability remain unassessed.
- The R2 script named in the chat was not present in the recursive tree at 5d8ae8c. Its exact bytes are unavailable for independent review. No R2 write experiment was run.

## 2. Provenance and PR-base finding

PR #229 is open. Its head branch is docs/gate2p-contract-v2-draft-2026-11-15 at 871e98b1d101a47d318b597c9c9520ad19976494. Its base branch is integration/master-brain-unification-2026-11-15 at 5d8ae8c5c096356f0f64a68a46f874374b5a34b8.

The PR body states that the original analysis used 5d55336, while the current PR base points to 5d8ae8c. This is a material review-scope change, not proof of malicious activity. Keep the provenance warning until the new base has been reviewed to the required depth. The PR body must not be interpreted as approval of the new base.

## 3. Five pinned blob checks

The following exact paths were fetched at both commits. Returned blob SHAs were equal:

| Path | Blob SHA at both commits | Result |
|---|---|---|
| cloud-engineering-connector/worker.js | 8911b4fc7df279ecbea7689506e0f814b2414dff | BYTE-IDENTICAL |
| cloud-engineering-connector/orchestrator-ledger.js | ba32281b3698d40917505096d2a61501f8c0f9e4 | BYTE-IDENTICAL |
| cloud-engineering-connector/identity/tenant-directory.js | 47647f84afc03c554b808060b6adce200d31e13d | BYTE-IDENTICAL |
| cloud-engineering-connector/identity/tenant-context.js | 2282a056d1b0436ad8e573f7c8d7873d4fe5c34b | BYTE-IDENTICAL |
| cloud-engineering-connector/wrangler.toml | 6c81ef6761497f6e8889a1ed8aa715b70922a949 | BYTE-IDENTICAL |

This is a narrow invariant check. It does not establish that all code, tests, workflows, configuration or documentation are unchanged.

## 4. Workflow static review

File: .github/workflows/unicode18-raw-byte-acquisition.yml  
Blob SHA: 829a32ddd3ef55563d49bcfe478b229a72fd3008  
Length: 19,073 characters; 393 lines.

### Positive controls observed
- Trigger is restricted to push events on the named integration branch and path-filtered to this workflow file.
- Top-level permissions are empty; no secret reference or third-party uses action was observed.
- Both jobs have a 10-minute timeout.
- Python acquisition uses fixed Unicode 18.0.0 URLs, HTTPS, bounded retries, response-size limits, content-type checks and bounded ZIP member sizes/ratios.
- The workflow does not check out repository content, execute repository scripts, persist raw source bytes, upload artifacts or write back to GitHub.
- The shell reproduction uses HTTPS-only curl options, does not follow redirects, checks HTTP 200, verifies byte counts and compares direct files with ZIP members.
- This is a read-only acquisition/consistency check, not a cryptographic publisher attestation.

### Hardening findings
1. Python urllib follows redirects before the final URL is checked. The final check verifies HTTPS, hostname and path, but does not explicitly pin netloc/port to the canonical origin or prove that no intermediate redirect crossed another origin. No credential is attached, so this is a hardening gap rather than an observed secret-exfiltration path. Prefer rejecting redirects or a redirect handler that validates every hop.
2. ZIP member validation rejects symlinks and encrypted members but does not explicitly reject every other special Unix file type. The workflow does not extract arbitrary entries, reducing impact; still, reject all non-regular, non-directory types before accepting the archive.
3. Direct Unicode files and the official Unicode ZIP are two distribution paths from the same publisher. Byte equality supports packaging consistency, not independent publisher corroboration, authenticity or a trusted timestamp. The workflow correctly labels independent publisher corroboration NOT_ESTABLISHED; preserve that limitation.
4. No durable evidence artifact is retained. The report explicitly says raw contents are not logged and artifacts are not uploaded. If durable audit evidence is required, retain run ID, workflow SHA, runner metadata, report digest and retrieval procedure in the evidence registry.
5. The shell reproduction reacquires and compares bytes but does not repeat every Python ZIP-index safety assertion. Do not describe it as a complete independent security review.

### Workflow verdict
LOW STATIC RISK / LIMITED SCOPE. No observed secret use, write permission or third-party action in the inspected file. Not approved as a security control or proof of Unicode policy correctness. Runtime execution, network behavior, runner provenance and artifact retention have not been independently tested in this review.

## 5. R2 artifact status

A recursive tree query at 5d8ae8c did not find mb-r2-github-idempotency-experiment.sh. The only matching idempotency-named file in the connector tree was the existing unit-test file cloud-engineering-connector/cloudflare-test/orchestrator-ledger-idempotency-scope.test.js.

Therefore:
- Claude-reported syntax validation: NOT INDEPENDENTLY REPRODUCED.
- Claude-reported dry-run: NOT INDEPENDENTLY REPRODUCED.
- Real-write path: NOT_RUN.
- No R2 observation record exists in this reviewed repository snapshot.
- D-04 remains UNVERIFIED.

The exact script must be supplied as a file or committed to a review branch before script-specific findings can be closed.

## 6. Required next gates

| Gate | Required evidence | Status |
|---|---|---|
| G2P-DLT-01 | Review all 42 Markdown and two JSON files, including cross-document contradictions and source provenance | NOT_RUN |
| G2P-WF-01 | Harden redirect and ZIP type validation; test workflow on a non-sensitive test branch | OPEN |
| G2P-R2-01 | Obtain exact R2 script bytes; static and adversarial review of guards/error handling | BLOCKED |
| G2P-R2-02 | Owner-authorized execution in a confirmed disposable private repository | NOT_RUN |
| G2P-R2-03 | Exact paginated reconciliation plus lost-response trials | NOT_RUN |
| G2P-C-01 | Contract v2.1 independent review and owner decision reconciliation | OPEN |

## 7. Non-actions

No workflow was run or changed. No R2 write was executed. No experiment tree, commit, ref or PR was created. No merge, deployment, secret, Cloudflare, Supabase or laptop change was made by this review.

**Final status:** Five pinned files are byte-identical. The workflow has low observed static risk but remains unapproved. The 44 Unicode documents/data files remain unreviewed. R2 is blocked pending exact script bytes. D-04 remains UNVERIFIED.
