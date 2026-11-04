# P2-B Write Preflight — Evidence and Current Blockers

**Status:** Structural preflight now validates task branch/path scope and a supplied changed-tree manifest, including symlink/submodule rejection. Code/test SHA `fa617c3d94a375c0da2d553fca43b4e2e457957c` is CI-verified. P2-B execution remains BLOCKED. No GitHub write identity, live ledger, task record, branch, or external side effect is enabled.

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

## Read-only GitHub manifest provider

`cloud-engineering-connector/orchestrator-github-manifest-provider.js` now retrieves repository identity, branch ref, commit/tree, compare metadata, and recursive tree through authenticated GitHub REST GET requests. It verifies the exact repository ID, base/head SHAs, task branch prefix, exact changed-path set, compare status, complete (non-truncated) tree, and regular-file modes. It rejects deletes, renames, copies, symlinks, submodules, unsupported paths, and truncated trees. It performs no GitHub writes, branch creation, task persistence, ledger writes, or provider invocation. Tests use a synthetic fetch implementation and a dummy token; no live credential or production GitHub write was used.

## Important limitation: manifest provenance

The module is deliberately pure and has no GitHub, Cloudflare, network, or ledger imports. The preflight validator checks structure only. The separate read-only provider fetches GitHub evidence but has not been exercised with a live token. The manifest itself is not a self-authenticating token. It deliberately ignores any caller-supplied `verified` boolean because such a boolean is not proof of provenance.

Before any future write path exists, its adapter must retrieve the branch ref, compare/diff, and recursive Git tree through authenticated GitHub API calls for the exact repository, base SHA, requested branch, and head SHA. It must verify those responses, reject stale/raced heads, ensure the diff path set exactly matches the approved set, reject symlink/path-resolution escapes, and re-check the stop switch immediately before any side effect. Caller-supplied booleans must never be treated as authentication.

## Verification fixtures are not approvals

Positive fixtures use synthetic evidence-shaped values only. They do not prove any real owner approval, actor allowlist, GitHub App, Durable Object namespace, backup/restore, branch protection, reviewer, stop-switch source, branch prefix, or path allowlist exists. No secret values or credential material are read.

## Verification evidence

- Exact code/test SHA: `fa617c3d94a375c0da2d553fca43b4e2e457957c`.
- Orchestrator GitHub Intake Contract run `41887340961`: success; 50 tests passed, 0 failed (15 P2-A + 26 P2-B + 9 manifest-provider tests).
- Cloud Engineering Connector CI run `41887352380`: success; Node suite 316 passed, 0 failed; Durable Object/Vitest suite 70 passed, 0 failed; `npm audit` reported 0 vulnerabilities; syntax checks and Wrangler production/staging dry-runs passed. Staging post-deploy smoke was skipped; no deployment occurred.
- Full History Secret Scan run `41887352233`: success on exact code/test SHA; 2,435 commits scanned, no leaks found.

## Current blockers — no values inferred

- No owner-approved branch prefix or path allowlist supplied; test values and tree manifests are synthetic only.
- No owner-approved actor ID list or event/action/label tuple supplied.
- No task-scoped GitHub App or Actions write identity verified.
- No live `ORCHESTRATOR_LEDGER` namespace binding or migration verified.
- No successful ledger backup/restore drill evidenced.
- Branch-protection state and required review policy remain unverified.
- Independent reviewer identity remains unverified.
- No verified stop-switch source for this write path.
- The read-only authenticated GitHub manifest provider exists, but it has only been tested against synthetic API fixtures. No live token-backed API retrieval, authenticated GitHub diff/tree evidence, or actual write-capable executor has been verified.

## Safety boundary

This work changes only the P2-B planning branch. It does not modify `main`, PRs #145–#152, Cloudflare resources, secrets, billing, deployments, or production traffic. It does not create a task branch in the target application repository, create a task record, write to the ledger, or invoke any provider.

## Live infrastructure inventory — read-only observation, 2026-11-04

Cloudflare API inventory was queried using read-only GET operations. No secret values were retrieved, and no Cloudflare resource was changed.

| Worker | Observed bindings relevant to orchestration | Finding |
|---|---|---|
| `chat-gpt111` (Production) | Secret binding names include `GITHUB_READONLY_TOKEN`, `GITHUB_TOKEN`, `MCP_AUTH_TOKEN`; rate limiter | No Durable Object namespace binding is present in the returned Worker settings. |
| `chat-gpt111-staging` | `WriteControl` Durable Object namespace; `PUBLIC_READ_ONLY=true`; `SERVICE_MODE=cloud`; GitHub/MCP secret binding names | No KnowledgeStore or Orchestrator Ledger namespace binding is present. |
| `master-brain-cloud-agent` | `AgentBudget`, `AgentSession` Durable Object namespaces; AI binding | These namespaces belong to this Worker and are not evidence of an orchestrator ledger for `chat-gpt111`. |

The account namespace inventory returned exactly three namespaces: `master-brain-cloud-agent_AgentBudget`, `master-brain-cloud-agent_AgentSession`, and `chat-gpt111-staging_WriteControl`. No namespace named or classed as `KnowledgeStore` or `ORCHESTRATOR_LEDGER` was returned. This confirms that the P2-B ledger prerequisite is currently not provisioned in the observed account inventory; it is not merely an untested positive fixture.

The GitHub integration returned HTTP 403 for branch-protection reads (`Resource not accessible by integration`). Therefore branch protection and required approvals remain **unknown**, not absent and not verified. No attempt was made to bypass the permission boundary.

## Verification of code changes and latest evidence-document head

The code-validation head was `f81ad2ab3fdca789e668ee9e2d80e65223fbbf35`. The latest PR #153 head is the evidence-only documentation commit `a18a77f036e1af87350ce899150c6f5f0594d0b2`.

- Orchestrator GitHub Intake Contract run `41898547416`: success.
- Cloud Engineering Connector CI run `41898547404`: success; staging post-deploy smoke skipped.
- Full History Secret Scan run `41898547383`: success.
- A second push-triggered run for the intake contract and secret scan also succeeded (`41898532226`, `41898532189`).
- The new malformed-tree and non-tree-ancestor negative tests are included in the successful intake-contract run.
- These checks do not constitute a live provider exercise, a staging deployment, or proof of Production readiness.

The latest evidence-document commit `a18a77f036e1af87350ce899150c6f5f0594d0b2` passed Cloud Engineering Connector CI run `41898873033`, Orchestrator GitHub Intake Contract run `41898873296`, and Full History Secret Scan run `41898873112`. Staging post-deploy smoke remained skipped. The live inventory findings above are read-only observations and do not authorize provisioning, binding migrations, secret changes, or deployment.
