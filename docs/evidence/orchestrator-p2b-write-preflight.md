# P2-B Write Preflight — Evidence and Current Blockers

**Status:** Structural preflight, including branch-prefix and path-allowlist shape validation, implemented and focused CI-verified on code/test SHA `847593e0f1df3c1a95e721ced06e81c7df2ee92b`. P2-B execution remains BLOCKED. No GitHub write identity, live ledger, task record, branch, or external side effect is enabled by this module.

## Purpose

`cloud-engineering-connector/orchestrator-github-write-preflight.js` checks whether all P2-B prerequisites have independently verifiable evidence before a separate execution authorization can even be considered.

The only positive result is `READY_FOR_SEPARATE_EXECUTION_APPROVAL`. It is not an `ALLOW` decision and does not authorize execution. Owner approval is cryptographically bound to a canonical SHA-256 digest of the exact repository identity, actor/event/label policy, credential identity/scope, ledger evidence, repository controls, base ref/SHA, independent reviewer, stop-switch state, branch/path policy, requested branch name, and requested changed-path set. Any change invalidates the approval hash. Every result explicitly returns:
- `sideEffects: false`
- `branchCreation: false`
- `taskPersistence: false`
- `ledgerWrites: false`
- `executionAuthorized: false`

Missing or malformed evidence returns `BLOCKED` with stable reason codes.

## Required evidence categories

1. **Owner approval:** authenticated and identity-verified owner record, bounded authorization ID, scope hash, approval time, and non-expired expiry.
2. **Actor/event/label policy:** unique numeric GitHub actor IDs, exactly one event/action pair, and one explicit label.
3. **Task-scoped credential:** verified short-lived GitHub App or Actions identity, repository-scoped, with exactly `contents:write` as the requested permission.
4. **Durable ledger:** verified `ORCHESTRATOR_LEDGER` binding, distinct from KnowledgeStore, with successful backup/restore evidence.
5. **Repository controls:** verified default-branch protection, at least one required approval, and workflow write-scope review.
6. **Immutable base:** verified non-protected base ref and exact 40-character commit SHA.
7. **Independent reviewer:** authenticated, identity-verified reviewer distinct from all authorized requester IDs.
8. **Stop switch:** readable and explicitly disabled immediately before the future side effect.
9. **Branch/path scope:** a non-protected, constrained branch prefix plus a bounded, unique list of repository-relative path prefixes.
10. **Task-specific requested scope:** the requested branch must use the approved prefix; each requested changed path must fall within an approved path prefix. Traversal, absolute paths, backslashes, sensitive paths, duplicates, and out-of-scope paths are rejected. This is lexical validation only; a future executor must inspect the actual diff and reject symlink/path-resolution escapes.

## Verification fixtures are not approvals

The positive test fixture uses synthetic evidence-shaped values to prove schema behavior, including exact scope-hash binding. It does not assert that any real owner approval, actor allowlist, GitHub App, Durable Object namespace, backup/restore, branch protection, reviewer, or stop-switch evidence exists. No secret values or credential material are read.

The preflight module is deliberately pure and has no GitHub, Cloudflare, network, or ledger imports. It validates a task-specific requested branch and changed-path set against the approved policy, but does not inspect an actual Git diff or resolve symlinks; those checks remain mandatory in any future executor. A future write-capable adapter must independently retrieve and authenticate these evidence sources, bind approval to the exact scope hash, re-check the stop switch immediately before the side effect, and require a separate explicit authorization. It must not treat caller-supplied booleans as authentication.

## Verification evidence

- Exact code/test SHA: `847593e0f1df3c1a95e721ced06e81c7df2ee92b`.
- Orchestrator GitHub Intake Contract run `41817856166`: success, 34 tests passed, 0 failed (15 P2-A + 19 P2-B).
- Full History Secret Scan run `41817510530`: success; 2,409 commits scanned, no leaks found.
- Cloud Engineering Connector CI run `41817510443`: the only returned job was `post-deploy-staging-smoke`, skipped. This is not evidence of a full connector test/build run; no full connector CI pass is claimed for this SHA.

## Test coverage

The focused suite verifies:
- complete evidence reaches preflight only, never execution authorization;
- missing prerequisites fail closed;
- trusted clock requirement;
- absent, expired, malformed, or non-owner approval;
- unique numeric actor IDs and one event/action/label tuple;
- short-lived, repository-scoped, least-privilege credential shape;
- durable and restored ORCHESTRATOR_LEDGER evidence;
- repository protections and workflow permission review;
- immutable non-protected base ref/SHA;
- distinct verified reviewer;
- stop-switch fail-closed behavior;
- safe branch-prefix and path-allowlist validation;
- requested branch prefix enforcement and changed-path containment checks;
- approval-hash invalidation when policy or requested task scope changes;
- aggregation of multiple independent blockers.

## Current blockers — no values inferred

- No owner-approved branch prefix or path allowlist supplied; test values are synthetic only.
- No owner-approved actor ID list supplied.
- No owner-approved task event/action and exact label supplied.
- No task-scoped GitHub App or Actions write identity verified.
- No live ORCHESTRATOR_LEDGER namespace binding or migration verified.
- No successful ledger backup/restore drill evidenced.
- Branch-protection state and required review policy remain unverified.
- Independent reviewer identity remains unverified.
- No verified stop-switch source for this write path.

## Safety boundary

This work does not modify `main`, PRs #145–#152 outside the new P2-B planning branch, Cloudflare resources, secrets, billing, deployments, or production traffic. It does not create a branch in the target application repository for a task, create a task record, or invoke any provider.
