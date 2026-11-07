# Worker-to-Ledger Cryptographic Identity — Implementation Contract

- Date: 2026-11-06
- Status: Approved engineering contract for isolated implementation; not runtime-enabled
- Branch: `remediation/production-readiness-2026-11-06`
- Parent design: `docs/decisions/2026-11-06-authenticated-orchestrator-and-webhook-intake.md`

## 1. Trust boundary

The only trusted signer is the Cloudflare Worker process after it has authenticated the upstream principal through a mechanism that establishes the required principal class and independently derived the principal's identity and role. MCP request arguments, webhook JSON, task payloads, caller-provided context objects, and legacy boolean fields are untrusted.

The Durable Object is the policy enforcement point. It must verify the assertion itself. The Worker must never pass a pre-decoded `authenticatedWorker` object as proof.

## 1A. Important identity limitation in the current Worker

The inspected `worker.js` currently authenticates MCP requests using one shared `MCP_AUTH_TOKEN` bearer secret and reduces the result to a Boolean `authenticated`. That proves possession of a service credential; it does **not** identify an individual human, agent, publisher, or system worker. The Worker must not derive `sub` or an `agent` role from RPC arguments, task payloads, `actor` objects, or client-supplied metadata.

Until a separate trusted principal-authentication mechanism exists:
- The shared MCP credential may map only to a fixed, explicitly named service principal (for example, `mcp-gateway`) and only to operations authorized for that service principal.
- It must not mint `agent`, `publisher`, or `system` assertions merely because the request asks for those roles.
- Agent assertions require a distinct authenticated agent channel or a trusted server-side scheduler/worker registry that proves the agent identity. Publisher assertions require an independently authenticated publisher service.
- If the required principal cannot be established, the Worker must not mint an assertion and the Durable Object must reject the mutation.

A future per-user identity provider or per-client credential design is a separate architecture decision. A single shared bearer secret cannot support non-repudiable per-user attribution.

## 2. Wire format

Use a compact, versioned envelope:

`v1.<kid>.<base64url(canonical-claims-utf8)>.<base64url(hmac-sha256)> `

Canonical claims are a JSON object serialized with recursively sorted object keys, UTF-8 encoding, no insignificant whitespace, and no non-finite numbers. Arrays preserve order. Reject duplicate JSON keys at decode time; do not rely on permissive JSON.parse behavior for signed claim interpretation.

Required exact claim set:
- `v`: integer `1`
- `iss`: fixed service identifier `chat-gpt111-worker`
- `aud`: fixed Durable Object audience `orchestrator-ledger`
- `sub`: worker identity matching the explicit workerId argument
- `role`: one of `agent`, `publisher`, `system`
- `op`: exact method-level operation identifier
- `iat`: integer Unix epoch seconds
- `exp`: integer Unix epoch seconds
- `jti`: cryptographically random, unique assertion identifier (at least 128 bits of entropy)

No additional claims are accepted. Identifiers must use the existing bounded identifier policy. `exp` must be after `iat`; lifetime must not exceed 60 seconds. Allow at most 5 seconds of clock skew in either direction. Reject future-issued, expired, zero/negative, non-integer, or out-of-window timestamps.

## 3. Cryptographic requirements

- HMAC-SHA-256 over the exact ASCII signing input `v1.<kid>.<payload-segment>`.
- Key material is a server-only Cloudflare secret binding, never a `vars` value, source constant, request field, or Durable Object storage record.
- Each configured key must contain at least 32 random bytes.
- `kid` is a bounded allowlisted key identifier. Unknown IDs fail closed.
- Support current and previous key IDs only during an explicit bounded rotation overlap. Rotation itself is a separate controlled operation.
- Use Web Crypto `crypto.subtle` and constant-time comparison for equal-length MACs.
- Do not log the token, payload, MAC, key ID, subject, or raw body. Logs may contain only bounded reason codes and correlation IDs.
- Never return cryptographic verification detail to an untrusted caller.

## 4. Replay protection and atomicity

A valid signature is not sufficient to authorize repeated execution. Add a dedicated Ledger table for consumed assertion IDs with a unique key on `jti`, plus operation, subject, key ID, issued/expiry times, and consumed timestamp.

The assertion must be consumed in the same `transactionSync` transaction as the authorized state change. A separate verify-then-consume transaction creates a race and is not acceptable.

- New `jti`: continue the operation and persist consumption atomically with its mutation.
- Previously consumed `jti`: reject with a generic authorization failure and perform no mutation.
- Unique-key conflict: reject; do not treat as success.
- Storage/transaction error: fail closed and roll back the protected mutation.
- Cleanup may remove expired assertion records only after expiry plus the clock-skew and operational margin; cleanup must never make a still-valid assertion replayable. The current implementation retains consumed IDs for at least 10 minutes after expiry before pruning and indexes `expires_at` for bounded cleanup.

If Web Crypto verification is asynchronous, the implementation must not split authorization from the mutation. Verify the MAC and claims before entering the transaction; then atomically consume the verified `jti` and perform the operation inside the same transaction. The verified result must be an internal, non-serializable value created by the verifier, not a caller-supplied object. Do not expose an API that lets request code construct this value.

## 5. Operation and role matrix

| Operation | Allowed role | Subject binding |
|---|---|---|
| `createTask` | `system` | assertion sub = fixed `orchestrator-scheduler` principal |
| `claimTask` | `agent` | assertion sub = workerId |
| `renewLease` | `agent` | assertion sub = workerId |
| `releaseLease` | `agent` | assertion sub = workerId |
| `transitionTask` | `agent` | assertion sub = workerId = actor.id |
| `advanceAgentRound` | `agent` | assertion sub = workerId |
| `claimOutbox` | `publisher` | assertion sub = workerId |
| `completeOutbox` | `publisher` | assertion sub = workerId |
| `enqueueOutbox` | `agent` | assertion sub = workerId; consumed atomically with enqueue |
| `appendAuditEvent` | `agent` | assertion sub = workerId = actor.id; actor role is derived from the assertion |
| `recordMessage` | `agent` | assertion sub = workerId = envelope.senderId |

The exact operation string is included in the signature. A token minted for `claimTask` cannot authorize `completeOutbox`. Roles are derived by the Worker from trusted server-side policy and a verified principal class; the caller cannot choose a role. The existing shared `MCP_AUTH_TOKEN` is not sufficient evidence for agent, publisher, or system identity.

Read-only methods do not gain write authority by possessing a worker assertion. Any future administrative operation requires a separate role and operation entry, not a generic wildcard.

## 6. API migration

- Replace `authenticatedWorker` and `authenticatedSender` object parameters with a signed assertion string.
- `appendAuditEvent` accepts only a verified `agent` assertion in the current implementation; caller-provided `owner`, `reviewer`, or `system` actor labels do not grant audit authority.
- Remove `authenticated` and `identityVerified` as authorization inputs.
- Reject legacy object-shaped identity values, even if both booleans are true.
- Ensure all lease mutations, direct `enqueueOutbox`, `claimOutbox`, `completeOutbox`, message acceptance, and audit append paths use the same verifier contract. Keep `enqueueOutbox` internal to already-authorized transactions or add an explicit trusted system operation; it must not become an unauthenticated public mutation.
- Do not add a fallback mode that accepts legacy booleans when a secret is missing.
- Do not introduce an environment default secret or a test secret into `wrangler.toml`.

## 7. Required red/green test sequence

1. Add a regression test proving a forged legacy object with both booleans true cannot claim a task. Observe the focused test fail against the current implementation.
2. Add the minimal verifier and prove the same test passes only with a valid signed assertion.
3. Add negative tests for invalid MAC, modified payload, malformed envelope, unknown kid, missing/weak key, unknown claim, duplicate claim, wrong issuer/audience/subject/role/operation, expiry, excessive lifetime, future issue time, and clock skew.
4. Add one-time `jti` replay tests and a concurrent duplicate assertion test. Verify exactly one protected mutation can commit.
5. Add transaction failure injection and verify no lease/task/outbox mutation is committed.
6. Preserve existing lease-generation fencing, assignee checks, state/version preconditions, and idempotency tests.
7. Run focused DO tests, complete Node tests, full DO suite, `npm run check`, Wrangler dry-run, and CI on the exact final SHA.

Do not mark a cycle red unless the focused test fails for the intended authorization defect, not because of setup or syntax.

## 8. Configuration and activation gates

Required production secret binding name: `LEDGER_WORKER_ASSERTION_KEYS` (secret JSON map keyed by `kid`, with strict schema and no plaintext logging). It must be configured independently in Staging and Production through the Cloudflare secret manager. This document does not authorize creating, rotating, or disclosing that secret.

No runtime activation until:
- Staging binding inventory confirms the secret exists without exposing its value.
- A staging-only end-to-end test proves Worker signing and DO verification.
- Replay persistence and failure behavior are tested.
- Backup/export and restore drill are complete before any schema migration.
- Independent reviewer approves the exact final commit.
- Branch protection and required CI checks are enabled.
- Operator separately authorizes deployment/migration.

## 9. Explicit safety constraints

- Keep `main` unchanged.
- Do not merge KnowledgeStore and OrchestratorLedger.
- Do not deploy, migrate, change traffic, configure secrets, or rotate keys as part of source implementation.
- Production remains NO-GO until all gates are evidenced.


## 10. Source implementation update — 2026-11-06

The following source-level controls have now been implemented on the isolated branch
`remediation/orchestrator-production-hardening`; this does not authorize runtime activation:

- `createScheduledWorkerAssertion` signs HMAC-SHA-256 assertions using the server-only key-set binding and an explicit active `kid`. Its policy is deliberately restricted to the fixed `orchestrator-scheduler` / `system` / `createTask` tuple and the fixed `orchestrator-outbox-publisher` / `publisher` / `claimOutbox|failOutbox|completeOutbox` tuples. It cannot mint an agent assertion or accept a caller-selected principal.
- The Worker scheduled handler invokes a bounded `processOrchestratorOutbox` publisher. It requires both the `ORCHESTRATOR_LEDGER` Durable Object and an `ORCHESTRATOR_OUTBOX_QUEUE` producer binding before claiming any event.
- The publisher uses a fresh operation-bound assertion for each claim, failure, and completion; uses a 120-second lease; limits each scheduled batch to 5 events by default and 20 maximum; publishes a versioned envelope carrying the stable `eventId`; and records retryable queue-send failures through the Ledger's existing retry/DLQ state machine.
- If queue send succeeds but Ledger completion is uncertain, the publisher does not mark the event failed. It leaves the lease to expire and reports completion pending. This is at-least-once delivery: a future Queue consumer MUST atomically deduplicate by `eventId` before any side effect.

### 10.1 Deliberately inactive configuration

At this source revision, `ORCHESTRATOR_OUTBOX_QUEUE` is not declared in `wrangler.toml`, and no Queue consumer exists in this repository. The publisher therefore returns `orchestrator_outbox_queue_unavailable` before calling `claimOutbox`. This is intentional fail-closed behavior, not a completed production pipeline.

The following remain mandatory before activation:
1. Provision separate Staging and Production Cloudflare Queues and configure the corresponding producer bindings through a reviewed configuration change.
2. Configure `LEDGER_WORKER_ASSERTION_KEYS` as a Cloudflare secret and `LEDGER_WORKER_ASSERTION_ACTIVE_KID` as the matching non-secret active key identifier in each environment. Verify presence and key compatibility without reading or logging secret values.
3. Implement and test a Queue consumer with durable `eventId` deduplication, bounded retries, poison-message handling, and explicit event-type policy. No task execution may be inferred from arbitrary outbox payloads.
4. Add a staging end-to-end test covering claim → publish → consume → deduplicate → completion/recovery, including the send-success/complete-failure duplicate window.
5. Establish a separate trusted Agent identity channel before any Agent assertion can be minted. The shared MCP bearer remains insufficient.
6. Complete backup/restore, independent review, branch governance, and operator-approved deployment gates.

### 10.2 Verification boundary

The source implementation and its tests are CI-verified only at their exact recorded commit SHA. The Cloudflare Queue binding, signing secret, consumer, and live Durable Object behavior have not been verified in Staging or Production. Production remains NO-GO.

## 11. Expired task lease recovery — fail-closed boundary (2026-11-07)

The current Ledger does not possess an independently authenticated reconciliation authority or a durable proof that a prior Agent's external side effects have stopped or been reconciled. Therefore:

- `claimTask` rejects reclamation when an existing lease has a non-null worker and `lease_until <= now`, returning `RECONCILIATION_REQUIRED`.
- Caller-supplied `reconciliationEvidence.checked`, `priorGeneration`, and `evidenceRef` are not accepted as authorization evidence and cannot override this rejection.
- The expired lease row (owner, generation, expiry) and task projection remain unchanged on rejection. The cryptographically valid assertion JTI is consumed atomically before task/lease inspection, including when reclamation is denied. A repeated use of the same assertion is rejected as `AUTHENTICATED_WORKER_REQUIRED`.
- A lease row with no current worker remains reclaimable under the existing generation-fencing rules; a live lease remains unavailable to another claimant.
- This is intentionally fail-closed and may leave tasks unavailable after worker crashes. Availability must not be restored by trusting caller claims.

Re-enabling reclamation requires a separate reviewed contract and implementation for an authenticated reconciliation authority, proof provenance, binding to task ID and prior lease generation, expiry/replay protection, and atomic persistence. A GitHub URL or caller-provided boolean alone is not proof. No such authority is implemented by this change.

This source-only control does not establish an Agent identity channel, verify external side effects, or authorize runtime activation. Production remains NO-GO.
