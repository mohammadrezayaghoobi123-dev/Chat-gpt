# Owner GitHub Webhook Control Plane — Design

**Status:** Proposed; implementation blocked pending owner review of this specification  
**Date:** 2026-11-07  
**Parent:** `remediation/orchestrator-production-hardening` at `dc2934ad3cd8106d3066dcb668c56633ace3df1a`  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt` (repository ID `1398846697`)  
**Owner principal:** GitHub user ID `335530603` (`mohammadrezayaghoobi123-dev`)

## 1. Objective and security invariant

Provide a narrow, auditable control plane for Owner-initiated task cancellation, quarantine, and release from quarantine. A caller must not gain Owner authority by supplying `actor.role="owner"`, an MCP bearer token, a task field, a webhook comment body, or an Agent assertion.

Owner authority is granted only when all of the following hold:
1. GitHub's `X-Hub-Signature-256` validates over the exact raw request body with the configured webhook secret.
2. `X-GitHub-Delivery` is syntactically valid and atomically claimed in the durable OrchestratorLedger replay store.
3. `X-GitHub-Event` is exactly `issue_comment` and payload action is exactly `created`.
4. Payload repository full name and numeric repository ID match the immutable configured repository identity.
5. `sender.id` and `comment.user.id` both equal the configured Owner GitHub numeric ID `335530603`; sender and comment author must agree.
6. Comment timestamp is within the configured bounded freshness window; future timestamps beyond allowed clock skew are rejected.
7. Only a newly created issue comment (not a pull-request review comment) is eligible; `comment.user.id` must equal `sender.id`, the author must not be a Bot, and freshness is derived from `comment.created_at` (not `issue.updated_at`).
8. Command grammar, operation, task ID, task state/version and required reason/resolution are valid.
9. The command is atomically applied with a one-time, context-bound Owner assertion and an append-only audit event.

No Owner operation is exposed as an MCP tool. The MCP bearer is not an Owner credential.

## 2. Existing system facts and integration boundary

The current Worker already exposes `POST /webhooks/github`, validates GitHub HMAC, extracts repository and sender identity, and uses `ORCHESTRATOR_LEDGER.claimGitHubDelivery` for durable replay/idempotency. The current handler only performs P2-B intake and returns `sideEffects: false` and `taskExecution: false`; it does not implement Owner commands.

The current intake policy accepts a configurable actor allowlist. The Owner control path must be a separate strict policy, not a widening or reinterpretation of that general intake allowlist.

The current Worker assertion verifier supports fixed Agent/publisher/system/consumer roles. The current signer does not mint Owner assertions. Ledger `transitionTask` is Agent-only and lease-fenced. The core transition model requires Owner resolution evidence to release `QUARANTINED`, but no authenticated Owner Ledger method currently bridges that requirement.

## 3. Alternatives

### A. Extend the existing webhook intake handler (recommended)
Reuse the verified raw-body authentication and existing Ledger binding, then route only the exact `issue_comment.created` event into a dedicated Owner command parser and service. Keep ordinary issue intake on its current path. Owner-command delivery claiming must occur inside the same Ledger transaction as assertion consumption, task mutation, audit append and command receipt; do not pre-claim it in the ordinary intake path.

- Pros: one webhook secret, one transport endpoint, existing replay store and rate limit.
- Cons: handler requires a strict dispatch boundary and additional tests to prevent cross-policy confusion.

### B. Separate webhook endpoint and secret
Create a second endpoint and GitHub webhook secret dedicated to Owner commands.

- Pros: stronger transport-level separation.
- Cons: additional secret lifecycle, GitHub webhook configuration, endpoint and replay policy; does not remove the need for identical actor/repository/command validation.

### C. Use MCP Owner tools
Expose privileged tools through MCP authentication.

- Rejected: current MCP bearer maps callers to a shared owner identity and cannot prove the human GitHub Owner principal. It creates a privilege-confusion path.

## 4. Recommended command protocol

Commands are accepted only in newly created issue comments in the configured repository:

- `/orchestrator cancel <taskId> --reason "<bounded reason>"`
- `/orchestrator quarantine <taskId> --reason "<bounded reason>"`
- `/orchestrator release <taskId> --reason "<bounded resolution>"`

Parser requirements:
- Exact command prefix and operation allowlist; no shell evaluation, interpolation, aliases, or free-form subcommands.
- Task ID grammar and reason length are bounded; control characters and sensitive-field patterns are rejected.
- Only `issue_comment.created` is eligible; edits, deletes, PR review comments, workflow_dispatch, issue text, and MCP arguments are not.
- The command's issue/comment metadata is provenance, not authority; authority is derived from verified webhook sender and configured immutable IDs. Reject payloads containing `issue.pull_request`; only issue comments are accepted.
- The Owner comment ID and delivery ID are recorded; repeated delivery is a no-op, and a second distinct comment repeating a terminal operation returns a deterministic conflict/no-op according to task state.

## 5. Privileged operations and state rules

| Operation | Allowed source states | Target state | Required evidence |
|---|---|---|---|
| cancel | Any non-terminal state | `CANCELLED` | Owner reason + source comment/delivery provenance |
| quarantine | Any non-terminal state | `QUARANTINED` | Owner reason + source comment/delivery provenance |
| release | `QUARANTINED` only | `VALIDATING` | Owner resolution reason + unique resolution event ID |

- Owner actions bypass Agent lease ownership only through dedicated Ledger methods; they do not bypass task version checks, transition legality, terminal-state immutability, or audit persistence. Cancel and quarantine MUST atomically increment the task's lease/fencing generation (or equivalent monotonic fence) so every previously issued Agent lease becomes stale. All Agent transition, outbox publication, Queue-consumer and side-effect execution paths MUST re-check current task state/version/fence immediately before committing an effect; cancelled or quarantined tasks must not produce new business side effects. Tests must prove a stale Agent/outbox message cannot revive or execute work after Owner cancel/quarantine.
- Owner release is not a generic transition API. It is a dedicated method requiring current state `QUARANTINED`, expected version, and a new Owner resolution event.
- No resurrection from `COMPLETED`, `FAILED`, or `CANCELLED`.
- No global kill switch is included in this scope; it requires a separate design with defined blast radius and recovery semantics.

## 6. Assertion and Ledger transaction design

Add a separate Owner assertion contract rather than expanding the Agent assertion policy. The Worker verifies transport, identity, freshness and grammar before minting; the Ledger independently verifies the assertion signature and claims before any durable mutation. Assertions must be:
- HMAC-SHA-256 signed with a dedicated, versioned Owner key and key ID; do not reuse Agent/Publisher signing authority. The key has a short expiry and is available only to the trusted webhook control path.
- Role `owner`, issuer/audience specific to the OrchestratorLedger.
- Bound to `repositoryId`, `actorId`, `taskId`, operation, GitHub delivery ID, comment ID, and canonical command hash.
- Single-use via atomic JTI consumption in the same Durable Object transaction as task transition and audit append.
- Rejected on expiry, future issue time, wrong repository, actor mismatch, task/operation mismatch, replay, malformed claims, unknown key ID, or key misconfiguration.

The Worker may mint this assertion only after successful stateless validation: raw-body HMAC verification, immutable repository and Owner ID checks, event/action and issue-comment checks, freshness validation, strict command parsing, and bounded input validation. It must not commit a delivery claim before minting. The assertion and verified delivery metadata are passed to the dedicated Ledger entry point. No assertion-minting MCP tool or Agent API is added.

The Ledger entry point MUST verify the assertion cryptographically and validate its complete context before attempting a durable write. WebCrypto verification is asynchronous; it must not be awaited inside `ctx.storage.transactionSync()`. The same applies to `sha256Canonical()`. The pre-transaction phase must be side-effect-free: verify signature/claims, validate bounded inputs, read a snapshot of the task version and audit-chain head, and compute the canonical command/body/audit hash material from that snapshot. It must not claim a delivery, consume a JTI, or mutate task/audit/receipt state.

Dedicated Ledger methods (`ownerCancelTask`, `ownerQuarantineTask`, `ownerReleaseQuarantinedTask`) must perform this verification themselves. They must not trust caller-supplied actor role, `authenticated`, `identityVerified`, or a free-form resolution flag.

Use a dedicated `executeOwnerCommand` Ledger entry point (or equivalent narrowly scoped methods) that owns the entire delivery/command transaction. Do not call `claimGitHubDelivery` in a separate committed transaction before executing the Owner command: that would consume the delivery if a later task/audit write failed, preventing GitHub redelivery from completing the command.

### Atomic commit protocol

Use a short `transactionSync()` callback containing synchronous SQL operations only. No `await`, WebCrypto, network I/O, or asynchronous callback is permitted inside it. The transaction MUST:

1. Check the delivery ID and comment ID in the dedicated Owner-command receipt table. Return the stored result for an exact replay; reject identifier reuse with a different body/command hash. This read-only replay check occurs before attempting to consume a new JTI.
2. Compare the current task version/state and current audit-chain head with the snapshot used to precompute the audit hash. If the audit head changed, abort without consuming the JTI or delivery; re-read/recompute and retry a strictly bounded number of times. If the task's expected version/state is no longer valid, take the deterministic-conflict branch below rather than returning from a partially committed operation.
3. For an executable command, insert/consume the assertion JTI under a unique constraint, bound to the assertion hash and command context. A duplicate JTI must fail closed.
4. Claim the delivery ID and comment ID with their body/command hashes.
5. Apply the dedicated allowed task transition and version increment.
6. Append the precomputed hash-chained audit event, whose previous-hash value was checked against the current audit head in the same transaction.
7. Persist the bounded successful command result receipt.

**Deterministic conflict branch:** when the current task version/state fails the command's expected-version or allowed-source-state precondition, the transaction MUST atomically consume the valid assertion JTI, claim the delivery and comment IDs, and persist a bounded conflict result receipt. It MUST NOT mutate the task or append a successful-transition audit event. It MUST append a distinct `OWNER_COMMAND_REJECTED` audit event containing only the task ID, operation, expected/current version and state, actor/repository IDs, delivery/comment IDs, command hash, and a bounded conflict reason. The rejected-event hash must be precomputed from the observed audit head and revalidated against the current audit head inside the transaction; if the head changed, abort and retry the whole preflight/transaction a bounded number of times. This makes an authenticated Owner command attempt auditable without representing it as a successful task transition.

All writes in the executable-command path (steps 3–7) or deterministic-conflict path MUST commit or roll back together. Any SQL/storage exception aborts the transaction, leaving the JTI, delivery/comment receipt, task projection, audit chain and command receipt unchanged so GitHub redelivery can retry. The pre-transaction snapshot/hash phase is not itself authoritative: in-transaction task-version/state and audit-head comparisons are the compare-and-swap fences that prevent stale hashes or concurrent commands from committing. Do not hold a transaction open across network I/O.

The receipt is committed for deterministic policy outcomes so a redelivery returns the same outcome without re-execution. Exact replays return the stored result; identifier reuse with a different hash is a security conflict and must not overwrite the original receipt. Audit data excludes secrets and raw webhook payloads; store body/command hashes and minimal provenance only.

## 7. Replay, ordering, and failure behavior

- Reuse the durable GitHub delivery claim; never rely on in-memory replay caches.
- Derive an operation idempotency key from repository ID + comment ID + canonical command hash.
- A repeated delivery with the same body is acknowledged as duplicate and performs no second transition.
- Reuse of a delivery ID with a different body hash is a conflict and is rejected.
- A distinct comment that races with another command is serialized by the Ledger transaction and guarded by expected task version/state.
- Fail closed on unavailable Durable Object binding, unavailable replay store, missing/invalid webhook secret, missing Owner/repository configuration, unknown event, stale event, or any assertion verification failure.
- Webhook response must not expose internal secrets, assertion material, stack traces, or task data beyond a bounded status and reason code.

## 8. Configuration

Required non-secret configuration:
- `LEDGER_OWNER_ASSERTION_ACTIVE_KID` — bounded identifier selecting the active Owner-only signing key.
- `GITHUB_WEBHOOK_REPOSITORY=mohammadrezayaghoobi123-dev/Chat-gpt`
- `GITHUB_WEBHOOK_REPOSITORY_ID=1398846697`
- `GITHUB_WEBHOOK_OWNER_ID=335530603`
- bounded command freshness window and reason length limits.

Required secrets:
- Existing `GITHUB_WEBHOOK_SECRET` (minimum 32 bytes); value is never read back, logged, or placed in source.
- `LEDGER_OWNER_ASSERTION_KEYS` — dedicated versioned Owner assertion keyset, separate from Agent/Publisher assertion keys; values are never read back, logged, or placed in source. Rotation must support a bounded overlap window and reject unknown/retired KIDs.

The existing general `GITHUB_WEBHOOK_AUTHORIZED_ACTOR_IDS` remains separate and cannot broaden Owner authority. The Owner ID and repository ID are configuration invariants and should be validated at startup/readiness without logging secret values.

## 9. Durable command receipt and migration

Add an additive, idempotent OrchestratorLedger schema migration for a dedicated Owner-command receipt table keyed by GitHub delivery ID and comment ID. Store command/body hashes, task ID, operation, bounded result code/result JSON, and timestamps; never store raw payloads, secrets or signed assertions. A matching duplicate returns the persisted result. A hash mismatch is a conflict. Migration must preserve existing Ledger data and be covered by fresh-install and upgrade-from-current-schema tests.

## 10. Audit schema

Owner audit event must include:
- immutable event ID and task ID;
- actor numeric ID and role `owner`;
- operation and transition from/to;
- expected and resulting task version;
- repository numeric ID and canonical full name;
- GitHub delivery ID, issue number, comment ID and event timestamp;
- canonical command SHA-256 and bounded reason/resolution;
- previous audit hash, current event hash and creation timestamp.

Do not store raw webhook body, comment body beyond the bounded reason, HMAC secret, signed assertion, or access token.

## 11. Test and acceptance plan (test-first)

### Unit tests — command and identity policy
- Accept exact Owner ID + exact repository ID + `issue_comment.created` + valid command.
- Reject wrong Owner ID, wrong repository name/ID, sender/comment author mismatch, bot author, issue opened/edited, comment edited/deleted, pull-request review comment, stale/future timestamp, malformed command, unknown operation, oversized reason, sensitive reason and malformed task ID.
- Reject Owner-like text from any non-Owner sender, including another repository collaborator.
- Verify exact numeric IDs are compared as decimal strings/safe integers without lossy coercion.

### Cryptographic tests
- Valid Owner assertion verifies only for the bound operation/context.
- Reject tampered signature, changed task ID, changed delivery/comment ID, changed command hash, changed repository/actor, expired assertion, future assertion, unknown KID and malformed claims.
- Assert Agent signer cannot mint Owner assertions and Owner assertion cannot be used for Agent/Publisher operations.

### Ledger tests
- Owner cancellation and quarantine work without an Agent lease but require Owner assertion.
- Owner release works only from `QUARANTINED` and requires reason, expected version and provenance.
- Reject forged `actor.role="owner"`, caller booleans, MCP bearer context, Agent assertion and reused JTI.
- Concurrent/replayed commands produce one state transition and one audit event.
- Audit append and task mutation are atomic; injected audit failure leaves task unchanged.
- Terminal tasks cannot be reopened or overwritten by Owner command.
- Audit chain remains valid and excludes secrets/raw payload.

### Worker integration tests
- Exercise `POST /webhooks/github` with real HMAC-signed fixture bodies and mock Durable Object binding.
- Verify exact sender/comment-author/repository/action/freshness/replay checks before any Owner assertion is minted; reject PR review comments and bot authors.
- Verify exact redelivery returns the stored result; body/command hash mismatch conflicts; injected storage failure rolls back receipt, JTI consumption, task and audit so a retry can safely succeed.
- Verify malformed or unauthorized commands are rejected without state change.
- Verify normal P2-B intake behavior is unchanged.

### CI acceptance
- Focused tests demonstrate red for the missing behavior before implementation.
- Full Cloud Engineering Connector CI and Full History Secret Scan pass on exact PR HEAD.
- Wrangler dry-run is configuration validation only; no live deploy.
- No staging smoke or production action is performed without separate explicit authorization.

## 12. Rollout and safety boundary

This design and its implementation do not authorize deployment. Before any activation:
1. Configure and verify the Owner ID, repository ID and webhook event subscription in Staging.
2. Confirm the existing webhook secret is configured without reading its value.
3. Provision required OrchestratorLedger bindings and assertion key material through the secret manager.
4. Run a Staging end-to-end test using a dedicated test issue and reversible non-production task.
5. Verify audit chain and replay behavior.
6. Obtain independent review and explicit operator authorization before Staging/Production deployment.

No changes to `main`, GitHub branch protections, Cloudflare live resources, or secret values are part of this design.
