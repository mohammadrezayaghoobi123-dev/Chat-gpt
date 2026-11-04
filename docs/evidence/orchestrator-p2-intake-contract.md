# P2-A Read-Only GitHub Intake Contract — Evidence

**Status:** Implemented as a deterministic validation contract; CI verification pending. No live task intake or side effect is enabled.

## Repository identity

- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Numeric repository ID: `1398846697` (read from the GitHub repository API)
- Implementation branch: `plan/orchestrator-p2-github-intake-2026-11-04`
- Baseline plan commit: `63f284c30227180d6d7e03051649c0f1692335f0`

## Implemented contract

The validator in `cloud-engineering-connector/orchestrator-github-intake.js` requires explicit injected configuration for:
- exact repository name and numeric repository ID;
- non-empty numeric GitHub actor-ID allowlist;
- event/action allowlist;
- one exact required task label;
- an atomic replay/idempotency store interface.

Missing or malformed policy configuration fails closed. The validator checks repository identity, numeric actor ID, event/action, delivery ID, bounded event timestamp, issue schema, canonical GitHub issue URL, required label, payload limits, and optional task branch/path scope.

The validator does not treat issue title/body as instructions. It hashes the untrusted text and returns only a digest, not the raw title/body. It never creates tasks, branches, commits, comments, pull requests, or deployments. Its positive result is named `DRY_RUN_ACCEPT` and explicitly returns `sideEffects: false` and `taskExecution: false`.

Replay protection is an interface contract: `replayStore.claim({ deliveryId, idempotencyKey, inputHash })` must be atomic and durable in any live runtime. Unit tests use an in-memory fake only. No production durability claim is made.

## Workflow boundary

`.github/workflows/orchestrator-github-intake.yml` is a read-only test workflow:
- triggers only on pull requests touching the contract files, or manual dispatch;
- grants `contents: read` only;
- pins `actions/checkout` to a full commit SHA;
- disables persisted checkout credentials;
- runs syntax checks and the focused Node test file;
- does not receive issue/comment events and does not execute task text.

This is intentionally not a live issue-intake trigger. The owner has not yet approved a task-creation event, actor-ID allowlist, exact label, or live credential/replay-store design.

## Test coverage

The focused test suite covers:
- valid dry-run acceptance;
- missing policy configuration;
- repository mismatch and invalid/unauthorized actor IDs;
- unknown event/action;
- malformed delivery IDs and stale/future timestamps;
- missing replay store, duplicate delivery, and idempotency conflict/quarantine;
- malformed issue schema and issue URL;
- required label and payload-size limits;
- prompt-injection strings remaining untrusted data and not being returned;
- protected branch, traversal, sensitive path, and symlink-escape rejection;
- replay-store errors and sanitized deny results.

## Explicit non-claims / remaining gates

- The in-memory test store is not a durable replay defense.
- No live GitHub issue event is accepted by this workflow.
- The test actor ID is a fixture, not an owner-approved production requester.
- No branch creation, task execution, PR creation, write token, GitHub App, webhook, or public endpoint is configured.
- No live Cloudflare Durable Object binding or migration is used.
- P2-B and P2-C remain separately gated.
- Passing this contract does not prove Staging or Production readiness.
