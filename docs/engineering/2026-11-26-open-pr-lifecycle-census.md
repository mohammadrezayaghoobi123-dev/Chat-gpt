# Open Pull Request Lifecycle Census — 2026-11-26

## Status and scope

- Audit type: read-only repository census and targeted hostile triage.
- Snapshot date: 2026-11-26 (UTC).
- Account scope: the connected primary GitHub identity `mohammadrezayaghoobi123-dev`.
- Accessible repositories returned by the connected account: `Chat-gpt`, `Master-Brain-MCP-Hub`, `openclaw`, and `verbose-funicular`.
- The second connected GitHub identity returned no accessible repositories in the repository-list operation. This is an access-scope observation, not proof that the identity owns no repositories.
- No PR state, branch, review, repository setting, secret, Worker, Cloudflare resource, staging environment, production environment, or default branch was changed.

## Executive result

| Repository | Open PRs | Draft | Ready | Mergeable=false |
|---|---:|---:|---:|---:|
| Chat-gpt | 158 | 156 | 2 | 6 |
| Master-Brain-MCP-Hub | 21 | 20 | 1 | 3 |
| openclaw | 1 | 0 | 1 | 0 |
| verbose-funicular | 0 | 0 | 0 | 0 |
| **Total** | **180** | **176** | **4** | **9** |

Draft share: **176/180 = 97.78%** of currently open PRs in the accessible repository scope. This confirms that the user's estimate of roughly 90% is directionally correct; the observed proportion is higher.

The earlier 121-PR interim count was incomplete because the initial query path capped the Chat-gpt results at 100. The later repository PR-list operation returned 158 open PRs for Chat-gpt and 21 for Master-Brain-MCP-Hub; OpenClaw added one. Use this 180-item census as the corrected snapshot.

## Repository and dependency topology

### Chat-gpt

- 158 open PRs; 156 Draft; 2 Ready.
- 6 PRs report `mergeable=false`.
- 21 target `main`.
- 126 PRs have a base branch that exactly matches the head branch of another currently open PR. This is a direct, mechanically observed open-PR dependency edge; it does not by itself prove that the dependency is semantically necessary or that the parent is safe to merge.
- 32 PRs do not target the head branch of another currently open PR. Their base may still be a closed/merged PR branch or a long-lived integration branch; do not label these as independent without ancestry comparison.

Examples of active stacks include:
- Lease/Executor characterization: #353 -> #479 -> #480 -> #481 (plus other related branches).
- EGIS design/model chain: #466 -> #468 -> #470 -> #471 -> #472 -> #475.
- Ledger lifecycle tests: #440 -> #444 -> #452 -> #455 -> #457 -> #462.
- Environment/release guard chain: #415 -> #418 -> #421 -> #427 -> #429 -> #430 -> #432 -> #433 -> #436.
- 9Router provenance: #261 -> #262 -> #431, with design/audit follow-ups.

### Master-Brain-MCP-Hub

- 21 open PRs; 20 Draft; 1 Ready.
- 3 PRs report `mergeable=false`.
- 1 targets `main`.
- 20 PRs have a base branch matching another currently open PR head.
- The PR5 integration chain includes #5 -> #12 -> #13 -> #14 -> #15 -> #16 -> #17, followed by #18 and further dedup contract/review work (#20 -> #21 -> #23 -> #24). This is not a single simple linear chain: #10/#11/#9 are parallel historical or alternative branches and require explicit disposition.

### OpenClaw

- One open PR: #1, Ready, mergeable metadata true.
- Exact-head workflow snapshot includes multiple successful checks, but the `CI` workflow is completed with **failure**. Therefore the PR is not release-ready based on current evidence.

### verbose-funicular

- No open PRs were returned.

## Ready-state hostile triage

A Ready label is not a merge authorization. All four Ready PRs fail at least one release/approval gate in the evidence inspected:

| PR | Current exact head | CI snapshot | Review evidence | Disposition |
|---|---|---|---|---|
| Chat-gpt #115 | `7588e798a5c3a550249a2d254582c489ff83ef1e` | Lost BTC Scout: success | No submitted review found | Blocked: independent approval absent; historical comment reports branch divergence of 8 ahead / 167 behind from 2026-11-09; refresh compare and rerun on current base |
| Chat-gpt #114 | `781215d8a227ca2db479177dee43b528b9772be7` | CTP Evidence Lab Checks: success | No submitted review found | Blocked: independent approval absent; historical comment reports 5 ahead / 167 behind from 2026-11-09; refresh compare and rerun on current base |
| Master-Brain-MCP-Hub #5 | `302ab1a711f5212372144860ba5fe2d4cdc23afd` | Master Brain MCP Hub CI: success | Latest submitted review is COMMENTED, explicitly NOT APPROVED | Blocked: known redirect/retry, response-contract, SQLite contention/migration findings and dependent remediation chain remain unmerged; do not merge standalone |
| openclaw #1 | `2d35277568d928bcafa0db9159cdde374016824e` | CodeQL/quality checks shown successful; `CI`: failure | No submitted review found | Blocked: identify failing CI job and obtain independent review |

The 2026-11-09 ahead/behind findings for #114/#115 are historical comments, not fresh compare results. They are blockers to revalidation, not asserted current divergence measurements.

## Non-mergeable metadata

Nine open PRs report `mergeable=false` at the census snapshot:

- Chat-gpt: #279, #226, #149, #148, #145, #113.
- Master-Brain-MCP-Hub: #9, #4, #3.

This metadata is a mergeability snapshot only. It does not identify whether the cause is conflicts, GitHub's asynchronous mergeability calculation, or another condition. Fetch current PR details and compare branches before remediation.

## Supersession and closure candidates

The following are evidence-backed candidates for explicit disposition, not automatic closure instructions:

- Master-Brain-MCP-Hub #10: PR body states it is superseded for integration by clean PR #12 and should remain open/Draft for traceability.
- Master-Brain-MCP-Hub #11: PR body states it is superseded for integration by clean stacked PR #14 and should remain open/Draft for traceability.
- Chat-gpt contains references to superseded attempts in comments/bodies, but each candidate must be matched to the exact replacement PR and checked for unique content before closure.
- Do not close a PR merely because its body contains the word "superseded"; it may retain unique evidence or a needed dependency.

## Findings and risk interpretation

1. **Draft saturation is real:** 97.78% of open PRs are Draft in this connected repository scope.
2. **The dominant structural cause is likely dependency stacking:** 146 of 179 open PRs in Chat-gpt and Hub have a base ref equal to another open PR's head ref (126 + 20). This is a direct branch-name relation, not a complete ancestry proof.
3. **Mergeability is not readiness:** 171 PRs report mergeable=true, but that does not establish current-base validity, CI success, review approval, security clearance, or deployment safety.
4. **Ready status is currently misleading if interpreted as merge-ready:** all four Ready PRs have a concrete unresolved gate in the targeted evidence.
5. **The oldest PRs are around 24 days old in this snapshot**, but age alone is not a reason to close or merge.
6. **The open-PR backlog is not one homogeneous queue:** it contains active implementation stacks, test-only characterization, architecture/specification, security controls, historical alternatives, and possible superseded branches. They need different exit criteria.
7. **Unknown remains unknown:** where CI, review, branch ancestry, runtime behavior, or external backend semantics were not freshly verified, this report does not infer success or failure.

## Recommended atomic remediation sequence

### Phase 1 — Freeze the census and enrich evidence
- Preserve this report as a snapshot, not a continuously current dashboard.
- For every PR, record exact head SHA, base SHA, mergeability state, CI run IDs/conclusions, submitted review states, unresolved review threads, changed-file scope, and branch ancestry.
- Refresh evidence when head/base SHA changes; prior comments and CI do not transfer to a new SHA.

### Phase 2 — Resolve dependency graph before status changes
- Build a directed graph from PR base SHA/ref to the parent PR head SHA/ref.
- Identify roots, linear chains, forks, duplicate alternatives, cycles/inconsistent refs, and branches whose parent is no longer open.
- Select one integration path per logical feature. Preserve superseded branches until unique content and evidence are accounted for.

### Phase 3 — Classify each PR independently
Use exactly one operational disposition:
- `READY_FOR_REVIEW`: complete scope, current exact-head CI green, required tests/security checks present, no unresolved blocking review threads, base relationship validated.
- `REMAINS_DRAFT`: a specific, actionable blocker is recorded.
- `REPAIR_REQUIRED`: narrowly scoped defect with a testable remediation.
- `SUPERSEDED_PENDING_OWNER_DECISION`: exact replacement identified; unique content checked; owner decision still required before closure.
- `UNKNOWN_NEEDS_EVIDENCE`: required evidence unavailable or stale.

Do not use `mergeable=true` as a substitute for any of these gates.

### Phase 4 — Promote in dependency order
- Promote only the earliest safe parent in a chain.
- Re-run exact-head CI and independent review after any rebase, retarget, or new commit.
- Never promote a child ahead of its required parent.
- Keep release, staging, production, secrets, and default-branch gates separate from code-review readiness.

### Phase 5 — Merge and close only under explicit authorization
- Ready for Review is not Approved.
- Approval is not merge authorization.
- Merge and closure decisions require the repository's branch rules, independent approval, and the owner's explicit authorization.
- No merge, closure, retarget, rebase, deployment, or branch protection change is authorized by this census.

## Hostile review of this census

### Counter-hypotheses
- The 97.78% Draft rate may be intentional because the repository deliberately uses Draft as a hard safety boundary.
- A high stacked-PR count may represent disciplined atomic delivery rather than poor workflow.
- Some PRs marked Ready may have been marked Ready before their latest blocking evidence was recorded.
- Some mergeability=false values may be transient GitHub metadata.

### Falsification requirements
- Compare exact commit ancestry, not just branch names, for every suspected dependency.
- Refresh exact-head CI and review state for all four Ready PRs and all non-mergeable PRs.
- Inspect full PR body, changed files, review threads, and replacement ancestry before calling any PR superseded.
- Compare current base/head SHAs for #114/#115 before treating the 2026-11-09 divergence note as current.
- Reconcile OpenClaw #1's failing CI job rather than inferring from the other green checks.

### Verdict
**PROVISIONALLY ACCEPTED AS A REPOSITORY-WIDE CENSUS AND TRIAGE BASELINE ONLY.**

This report is not a final per-PR audit and does not claim that all 180 PRs have been individually reviewed at diff/test/security depth. The 180-item inventory, draft ratios, base/head branch-name dependency edges, mergeability metadata, and targeted Ready-PR evidence are the verified scope. Per-PR exact-SHA checks, full ancestry, diff review, and security review remain outstanding.

## Change boundary

This is a documentation-only audit record on an isolated branch. It does not modify runtime code, schemas, tests, secrets, Cloudflare resources, Worker configuration, staging, production, or `main`.

## Follow-up snapshot — 2026-11-28

### Inventory scope and counts

A fresh read-only REST pagination pass was run across all open PR pages in the four repositories visible to the primary connected identity. Chat-gpt required two pages plus an empty third-page confirmation; the other three repositories fit within one page.

| Repository | Open PRs | Draft | Ready |
|---|---:|---:|---:|
| Chat-gpt | 171 | 167 | 4 |
| Master-Brain-MCP-Hub | 25 | 24 | 1 |
| openclaw | 1 | 0 | 1 |
| verbose-funicular | 0 | 0 | 0 |
| **Total** | **197** | **191** | **6** |

Draft share: **191/197 = 96.95%**. Compared with the 2026-11-26 snapshot, the number of open PRs increased from 180 to 197 (+17); Drafts increased from 176 to 191 (+15), and Ready PRs from 4 to 6 (+2).

### Exact dependency graph

Dependency edges were computed by exact SHA equality: a child PR's current base.sha equals another currently open PR's head.sha. This is stronger than matching branch names, but it still does not prove semantic necessity or safety of the parent.

| Repository | Open PRs | Exact parent-head dependency edges |
|---|---:|---:|
| Chat-gpt | 171 | 118 |
| Master-Brain-MCP-Hub | 25 | 20 |
| openclaw | 1 | 0 |
| verbose-funicular | 0 | 0 |
| **Total** | **197** | **138** |

Representative current edges include:
- Chat-gpt Orchestrator clock/JTI stack: #493 → #490 → #340.
- Chat-gpt Gitleaks coverage stack: #484 → #477 → #473, then #485 → #486 → #487 → #488.
- Chat-gpt Executor identity stack: #268 → #263.
- Chat-gpt cancellation/receipt/JTI chain: #327 → #328 → #329 → #330 → #334 → #336 → #338 → #340.
- Master-Brain-MCP-Hub schema/dedup stack: #28 → #27 → #26 → #25 → #17 → #16 → #15 → #14 → #13 → #12 → #5 (with additional side branches).

The grouped Pulls list returned mergeable=null for all 197 PRs, so no bulk mergeability count is asserted. Individual PR metadata can return a computed mergeability value, but that is still not review approval or release readiness.

### Hostile revalidation of all six Ready PRs

A Ready label is treated as ready for review, not permission to merge. Each of the six was re-read individually for exact head/base, checks and submitted reviews.

| PR | Exact head | Evidence found | Current disposition |
|---|---|---|---|
| Chat-gpt #489 | ca048c21661e430a2f86bd1f138f683d62874a08 | Connector test job passed; PR diff Gitleaks passed; full fetched-ref/history Gitleaks failed; no submitted review | **HOLD** — full-history gate failing |
| Chat-gpt #225 | e429197b28b4d9067a456957827bf8a3bc2ebcbc | Connector CI and branch-history Gitleaks passed; submitted reviews are COMMENTED by the PR author, not APPROVED; staging validation is blocked by Cloudflare account recovery and was not attempted | **HOLD** — no independent approval and no staging acceptance |
| Chat-gpt #115 | 7588e798a5c3a550249a2d254582c489ff83ef1e | Last visible test check is 2026-11-02; no submitted reviews; branch diverges from current main: 168 commits on PR side and 8 commits on main side from common base f2cae91d | **REVALIDATION REQUIRED** — sync/review/current CI absent |
| Chat-gpt #114 | 781215d8a227ca2db479177dee43b528b9772be7 | Last visible test check is 2026-11-02; no submitted reviews; branch diverges from current main: 168 commits on PR side and 5 commits on main side from common base f2cae91d | **REVALIDATION REQUIRED** — sync/review/current CI absent |
| Master-Brain-MCP-Hub #5 | 302ab1a711f5212372144860ba5fe2d4cdc23afd | CI last verified 2026-11-14; existing technical review explicitly states COMMENT / NOT APPROVED; clean dependent PRs #12–#17 and later #25–#28 remain open; backend endpoint/contract and mixed-version migration constraints are unresolved | **HOLD** — dependent integration and approval gates open |
| openclaw #1 | 34b78edfd22d7e86e1d140bc34294e59d7a1d6c6 | No check runs returned for the exact current head and no submitted review; prior CI run was on older SHA 2d352775 and concluded failure | **REVALIDATION REQUIRED** — exact-head CI/review missing |

Relevant exact check evidence:
- #489 Connector CI: run 46127914186; Gitleaks: run 46127914078.
- #225 Connector CI: run 46118652788; branch-history Gitleaks: run 46118652801.
- OpenClaw's older CI run: 44319399140.

### Cross-project integration gates still open

1. **Chat-gpt PR #268 / #263:** Ledger-side Ed25519 Executor lifecycle is implemented and exact-head CI passes on PR #268, but the full fetched-ref Gitleaks gate fails on three unresolved findings documented in Issue #264. Do not promote #268 into #263 until the findings are dispositioned and exact-head scans pass.
2. **Chat-gpt PR #493 / #490:** effective issuer timestamp propagation is integrated into the PR #493 feature branch and exact-head CI passes. Parent clock/JTI PR #490 remains Draft/open; repository-wide historical Gitleaks and Staging/runtime acceptance remain separate gates.
3. **Gitleaks integrity chain #473 / #477 / #483–#488:** clean results remain policy/ref-inventory dependent. Merge-resolution coverage is not complete; MAT-050 and octopus-merge coverage limitations remain explicit.
4. **Master-Brain-MCP-Hub PR #5 chain:** PR #5 is Ready but its technical review is NOT APPROVED; dependent clean PRs remain Draft and backend contract/runtime semantics are not independently verified.
5. **OpenClaw #1:** current exact head has no check-run or independent-review evidence; older CI failed. No merge recommendation.

### Safety / non-claims

- main was not changed; current verified main SHA remains 919b19ca3d3887352cdef06b03c668ead04fbce7.
- No PR was merged, closed, retargeted, or downgraded in this census update.
- No branch was deleted, history rewritten, secret read, allowlist widened, scanner weakened, Cloudflare resource/secret changed, Worker/Queue invoked, or deployment performed.
- This is still a census and targeted Ready-PR triage, not an individual diff/security audit of all 197 PRs. The 138 exact dependency edges are a mechanical snapshot; each chain still needs semantic review and exact-head verification before promotion.

### Verdict

**PROVISIONALLY ACCEPTED AS A CURRENT PR LIFECYCLE CENSUS AND TRIAGE RECORD.** All six Ready PRs have at least one evidence gate preventing a merge-readiness claim. The inventory is complete for the four repositories returned by the connected primary identity at the snapshot time; it does not claim completeness for inaccessible identities, organizations, or repositories.


### Full-history secret scan for this census update

[Full History Secret Scan](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/46139547068) on the exact census update head reported:
- PR change range: 2 commits scanned; **no leaks found**.
- All fetched refs/reachable history: 5,572 commits scanned; **13 historical generic-api-key findings**; job failed.
- The 13 metadata-only tuples and cross-snapshot reconciliation are recorded in [Issue #264](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/issues/264). The snapshot union currently has 15 distinct path/line/commit tuples, but the counts differ by fetched-ref scope and do not imply simultaneous reachability.
- No source value, annotation, regex literal, or secret fingerprint was opened. No suppression, branch deletion, history rewrite, or scanner weakening was performed.

**Census PR disposition: HOLD.** This documentation-only change has a clean diff scan but an unresolved full-history security gate; the PR remains Draft/open/unmerged.
