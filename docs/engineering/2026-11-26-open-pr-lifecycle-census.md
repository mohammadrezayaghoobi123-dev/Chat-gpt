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
