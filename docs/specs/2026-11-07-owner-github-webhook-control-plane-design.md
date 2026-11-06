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
7. Command grammar, operation, task ID, task state/version and required reason/resolution are valid.
8. The command is atomically applied with a one-time, context-bound Owner assertion and an append-only audit event.

No Owner operation is exposed as an MCP tool. The MCP bearer is not an Owner credential.

## 2. Existing system facts and integration boundary

The current Worker already exposes `POST /webhooks/github`, validates GitHub HMAC, extracts repository and sender identity, and uses `ORCHESTRATOR_LEDGER.claimGitHubDelivery` for durable replay/idempotency. The current handler only performs P2-B intake and returns `sideEffects: false` and `taskExecution: false`; it does not implement Owner commands.

The current intake policy accepts a configurable actor allowlist. The Owner control path must be a separate strict policy, not a widening or reinterpretation of that general intake allowlist.

The current Worker assertion verifier supports fixed Agent/publisher/system/consumer roles. The current signer does not mint Owner assertions. Ledger `transitionTask` is Agent-only and lease-fenced. The core transition model requires Owner resolution evidence to release `QUARANTINED`, but no authenticated Owner Ledger method currently bridges that requirement.

## 3. Alternatives

### A. Extend the existing webhook intake handler (recommended)
Reuse the verified raw-body authentication and durable delivery claim, then route only the exact `issue_comment.created` event into a dedicated Owner command parser and service. Keep ordinary issue intake on its current path.

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
- The command's issue/comment metadata is provenance, not authority; authority is derived from verified webhook sender and configured immutable IDs.
- The Owner comment ID and delivery ID are recorded; repeated delivery is a no-op, and a second distinct comment repeating a terminal operation returns a deterministic conflict/no-op according to task state.

## 5. Privileged operations and state rules

| Operation | Allowed source states | Target state | Required evidence |
|---|---|---|---|
| cancel | Any non-terminal state | `CANCELLED` | Owner reason + source comment/delivery provenance |
| quarantine | Any non-terminal state | `QUARANTINED` | Owner reason + source comment/delivery provenance |
| release | `QUARANTINED` only | `VALIDATING` | Owner resolution reason + unique resolution event ID |

- Owner actions bypass Agent lease ownership only through dedicated Ledger methods; they do not bypass task version checks, transition legality, terminal-state immutability, or audit persistence.
- Owner release is not a generic transition API. It is a dedicated method requiring current state `QUARANTINED`, expected version, and a new Owner resolution event.
- No resurrection from `COMPLETED`, `FAILED`, or `CANCELLED`.
- No global kill switch is included in this scope; it requires a separate design with defined blast radius and recovery semantics.

## 6. Assertion and Ledger transaction design

Add a separate Owner assertion contract rather than expanding the Agent assertion policy. Assertions must be:
- HMAC-SHA-256 signed with the existing versioned key set, key ID and short expiry.
- Role `owner`, issuer/audience specific to the OrchestratorLedger.
- Bound to `repositoryId`, `actorId`, `taskId`, operation, GitHub delivery ID, comment ID, and canonical command hash.
- Single-use via atomic JTI consumption in the same Durable Object transaction as task transition and audit append.
- Rejected on expiry, future issue time, wrong repository, actor mismatch, task/operation mismatch, replay, malformed claims, unknown key ID, or key misconfiguration.

The Worker may mint this assertion only after successful raw-body HMAC verification, immutable repository and Owner ID checks, freshness validation, strict command parsing, and durable delivery claim. No assertion-minting MCP tool or Agent API is added.

Dedicated Ledger methods (`ownerCancelTask`, `ownerQuarantineTask`, `ownerReleaseQuarantinedTask`) must verify the assertion themselves. They must not trust caller-supplied actor role, `authenticated`, `identityVerified`, or a free-form resolution flag.

Each method performs, in one synchronous Durable Object transaction:
1. consume the context-bound assertion JTI exactly once;
2. load task and check expected version/current state;
3. apply the specific allowed transition;
4. append the hash-chained audit event with provenance and bounded reason;
5. persist task projection and audit event atomically.

If any step fails, no partial task or audit write is committed. Audit data excludes secrets and raw webhook payloads; store body/command hashes and minimal provenance only.

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
- `GITHUB_WEBHOOK_REPOSITORY=mohammadrezayaghoobi123-dev/Chat-gpt`
- `GITHUB_WEBHOOK_REPOSITORY_ID=1398846697`
- `GITHUB_WEBHOOK_OWNER_ID=335530603`
- bounded command freshness window and reason length limits.

Required secret:
- Existing `GITHUB_WEBHOOK_SECRET` (minimum 32 bytes); value is never read back, logged, or placed in source.

The existing general `GITHUB_WEBHOOK_AUTHORIZED_ACTOR_IDS` remains separate and cannot broaden Owner authority. The Owner ID and repository ID are configuration invariants and should be validated at startup/readiness without logging secret values.

## 9. Audit schema

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

## 10. Test and acceptance plan (test-first)

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
- Verify exact sender/repository/action/freshness/replay checks before any Owner assertion is minted.
- Verify duplicate webhook causes no second Ledger mutation.
- Verify malformed or unauthorized commands are rejected without state change.
- Verify normal P2-B intake behavior is unchanged.

### CI acceptance
- Focused tests demonstrate red for the missing behavior before implementation.
- Full Cloud Engineering Connector CI and Full History Secret Scan pass on exact PR HEAD.
- Wrangler dry-run is configuration validation only; no live deploy.
- No staging smoke or production action is performed without separate explicit authorization.

## 11. Rollout and safety boundary

This design and its implementation do not authorize deployment. Before any activation:
1. Configure and verify the Owner ID, repository ID and webhook event subscription in Staging.
2. Confirm the existing webhook secret is configured without reading its value.
3. Provision required OrchestratorLedger bindings and assertion key material through the secret manager.
4. Run a Staging end-to-end test using a dedicated test issue and reversible non-production task.
5. Verify audit chain and replay behavior.
6. Obtain independent review and explicit operator authorization before Staging/Production deployment.

No changes to `main`, GitHub branch protections, Cloudflare live resources, or secret values are part of this design.
