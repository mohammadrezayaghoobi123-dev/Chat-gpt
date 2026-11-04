# P2-B Write Preflight — Evidence and Current Blockers

**Status:** Structural preflight now validates task branch/path scope and a supplied changed-tree manifest, including symlink/submodule rejection. Code/test SHA `b3808fee4700f5006603cb2d043ce7809191f65e` is CI-verified. P2-B execution remains BLOCKED. No GitHub write identity, live ledger, task record, branch, or external side effect is enabled.

## Purpose and safety boundary

`cloud-engineering-connector/orchestrator-github-write-preflight.js` checks prerequisite evidence before a separate execution authorization can even be considered.

The only positive result is `READY_FOR_SEPARATE_EXECUTION_APPROVAL`. It is not an `ALLOW` decision. Every result explicitly sets `sideEffects`, `branchCreation`, `taskPersistence`, `ledgerWrites`, and `executionAuthorized` to `false`.

Owner approval is bound to a canonical SHA-256 digest of repository identity, actor/event/label policy, credential identity/scope, ledger evidence, repository controls, base ref/SHA, independent reviewer, stop-switch state, branch/path policy, requested branch name, exact requested changed-path set, and the complete supplied changed-file manifest (including head SHA and tree entries). Any change invalidates the approval hash.

## Implemented structural controls

1. Exact repository full name and numeric repository ID.
2. Authenticated/identity-verified owner approval shape, bounded expiry, and exact scope-hash match.
3. Unique numeric actor IDs, one event/action pair, and explicit task label.
4. Repository-scoped, short-lived GitHub App/Actions identity shape with exactly `contents:write`.
5. Durable `ORCHESTRATOR_LEDGER` binding and backup/restore evidence shape, separate from KnowledgeStore.
6. Verified branch protection, required approvals, and workflow write-scope review.
7. Immutable non-protected base ref and exact 40-character SHA.
8. Authenticated independent reviewer identity distinct from requesters.
9. Readable stop switch, required to be disabled.
10. Constrained non-protected branch prefix and bounded repository-relative path allowlist.
11. Requested branch must use the approved prefix; each requested path must be within an approved allowlist prefix. Traversal, absolute paths, backslashes, sensitive paths, duplicates, and out-of-scope paths are rejected.
12. Supplied changed-tree manifest must match the exact repository ID, base SHA, requested branch name, head SHA shape, and exact requested path set. Changed leaves must be regular Git blobs (`100644` or `100755`); symlink (`120000`), submodule (`160000`), directory leaves, missing entries, and non-tree ancestors are rejected.
13. The entire changed-file manifest, including head SHA, changed file modes, and tree entries, is included in the canonical owner-approval digest. Changing any manifest field invalidates the approval.

## Important limitation: manifest provenance

The module is deliberately pure and has no GitHub, Cloudflare, network, or ledger imports. The manifest validator checks structure only. It does **not** fetch or authenticate a GitHub compare/tree response. It deliberately ignores any caller-supplied `verified` boolean because such a boolean is not proof of provenance.

Before any future write path exists, its adapter must retrieve the branch ref, compare/diff, and recursive Git tree through authenticated GitHub API calls for the exact repository, base SHA, requested branch, and head SHA. It must verify those responses, reject stale/raced heads, ensure the diff path set exactly matches the approved set, reject symlink/path-resolution escapes, and re-check the stop switch immediately before any side effect. Caller-supplied booleans must never be treated as authentication.

## Verification fixtures are not approvals

Positive fixtures use synthetic evidence-shaped values only. They do not prove any real owner approval, actor allowlist, GitHub App, Durable Object namespace, backup/restore, branch protection, reviewer, stop-switch source, branch prefix, or path allowlist exists. No secret values or credential material are read.

## Verification evidence

- Exact code/test SHA: `b3808fee4700f5006603cb2d043ce7809191f65e`.
- Orchestrator GitHub Intake Contract run `41886574098`: success; 41 tests passed, 0 failed (15 P2-A + 26 P2-B).
- Cloud Engineering Connector CI run `41886573742`: success; Node suite 307 passed, 0 failed; Durable Object/Vitest suite 70 passed, 0 failed; `npm audit` reported 0 vulnerabilities; syntax checks and Wrangler production/staging dry-runs passed. Staging post-deploy smoke was skipped; no deployment occurred.
- Full History Secret Scan run `41886573677`: success on exact code/test SHA; 2,427 commits scanned, no leaks found.

## Current blockers — no values inferred

- No owner-approved branch prefix or path allowlist supplied; test values and tree manifests are synthetic only.
- No owner-approved actor ID list or event/action/label tuple supplied.
- No task-scoped GitHub App or Actions write identity verified.
- No live `ORCHESTRATOR_LEDGER` namespace binding or migration verified.
- No successful ledger backup/restore drill evidenced.
- Branch-protection state and required review policy remain unverified.
- Independent reviewer identity remains unverified.
- No verified stop-switch source for this write path.
- No authenticated GitHub diff/tree adapter or actual write-capable executor exists in this P2-B preflight.

## Safety boundary

This work changes only the P2-B planning branch. It does not modify `main`, PRs #145–#152, Cloudflare resources, secrets, billing, deployments, or production traffic. It does not create a task branch in the target application repository, create a task record, write to the ledger, or invoke any provider.