# P2-B Write Preflight — Evidence and Current Blockers

**Status:** Structural preflight implemented. P2-B execution remains BLOCKED. No GitHub write identity, live ledger, task record, branch, or external side effect is enabled by this module.

## Purpose

`cloud-engineering-connector/orchestrator-github-write-preflight.js` checks whether all P2-B prerequisites have independently verifiable evidence before a separate execution authorization can even be considered.

The only positive result is `READY_FOR_SEPARATE_EXECUTION_APPROVAL`. It is not an `ALLOW` decision and does not authorize execution. Every result explicitly returns:
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

## Verification fixtures are not approvals

The positive test fixture uses synthetic evidence-shaped values to prove schema behavior. It does not assert that any real owner approval, actor allowlist, GitHub App, Durable Object namespace, backup/restore, branch protection, reviewer, or stop-switch evidence exists. No secret values or credential material are read.

The preflight module is deliberately pure and has no GitHub, Cloudflare, network, or ledger imports. A future write-capable adapter must independently retrieve and authenticate these evidence sources, bind approval to the exact scope hash, re-check the stop switch immediately before the side effect, and require a separate explicit authorization. It must not treat caller-supplied booleans as authentication.

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
- aggregation of multiple independent blockers.

## Current blockers — no values inferred

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
