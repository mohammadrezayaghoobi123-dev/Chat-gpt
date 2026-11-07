# Security Decision Record: Authenticated Orchestrator and GitHub Webhook Intake

- Date: 2026-11-06
- Status: Proposed; implementation and runtime activation are blocked pending tests and backup/restore evidence
- Scope: `OrchestratorLedger` worker identity and GitHub webhook ingress
- Architecture invariant: `KnowledgeStore` remains the canonical knowledge source; `OrchestratorLedger` remains a separate coordination/audit service. Notion remains a projection only.

## 1. Evidence-backed problem statement

The current Ledger helper `hasVerifiedWorkerIdentity` accepts a caller-provided object when it contains `authenticated: true`, `identityVerified: true`, a matching worker ID, and an allowed role. These booleans are assertions, not cryptographic proof. The Durable Object therefore cannot distinguish a trusted identity assertion from a caller-constructed object.

The GitHub intake validator documents that actor, repository, event, and delivery metadata must already come from a trusted GitHub transport. It does not verify `X-Hub-Signature-256` against the raw request body. Its test replay store is an in-memory Map and is explicitly not production persistence. The validator returns `DRY_RUN_ACCEPT`; it does not execute tasks or perform side effects.

## 2. Decision A — authenticate the Worker-to-Ledger boundary

Replace boolean identity claims at the trusted boundary with a short-lived signed assertion created only by the Worker after server-side authentication.

Required assertion claims:
- `iss`: fixed trusted Worker service identifier
- `aud`: exact Durable Object/service audience
- `sub`: authenticated worker identifier
- `role`: one allowlisted role
- `iat` and `exp`: integer epoch seconds, with a short maximum lifetime and bounded clock skew
- `jti`: unique bounded assertion identifier
- `operation`: exact Ledger operation being authorized

Verification requirements inside the Durable Object:
1. Verify HMAC-SHA-256 using a server-only secret; reject missing, malformed, or weakly configured secrets.
2. Compare MACs in constant time.
3. Recompute the MAC over a canonical, versioned encoding; reject unknown claim fields and unsupported versions.
4. Enforce issuer, audience, subject, role, operation, issue time, expiry, and maximum lifetime.
5. Bind the verified subject to the explicit worker ID argument and the current lease/fencing generation.
6. Never accept a caller-supplied `authenticated` or `identityVerified` boolean as authority.
7. Keep the signing secret out of client-visible responses, logs, task payloads, and audit details.

The Worker must derive claims from its authenticated server-side context. It must not accept a signed assertion or identity claims from MCP request arguments. Key rotation must support a bounded overlap window and an explicit key identifier; rotation is not part of this change unless tested.

## 3. Decision B — authenticate GitHub webhook bytes before parsing

At the HTTP ingress boundary:
1. Read the request body once as raw bytes, enforcing a strict maximum before JSON parsing.
2. Require `X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event`.
3. Compute HMAC-SHA-256 over the exact raw bytes using the configured GitHub webhook secret.
4. Validate the `sha256=<64 lowercase hex>` encoding and compare the expected and supplied MAC in constant time.
5. Reject invalid signatures before JSON parsing, persistence, or any business logic.
6. Parse JSON only after successful authentication; then validate repository ID, repository full name, actor ID, event/action allowlist, issue schema, and timestamp policy.
7. Treat issue/comment/title/body content as untrusted data; never as policy or instructions.

The existing pure validator may remain as a post-authentication policy function, but its API must make trusted transport metadata explicit and impossible to confuse with unverified body fields.

## 4. Decision C — durable webhook replay and idempotency

Use the OrchestratorLedger's own durable SQL storage, not an in-memory map or KnowledgeStore, for webhook delivery claims.

Minimum persisted record:
- provider delivery ID (unique key)
- repository ID and event type
- SHA-256 digest of the exact authenticated raw body
- received timestamp
- processing status (`ACCEPTED`, `QUARANTINED`, or terminal state)
- bounded reason code and schema version

Atomic transaction rules:
- New delivery ID + valid digest: insert one claim.
- Same delivery ID + same digest: return replay/no-op; do not enqueue again.
- Same delivery ID + different digest: quarantine and alert; never overwrite the original claim.
- Storage unavailable or transaction failure: fail closed; do not accept the event.
- Retention must be bounded by a documented policy, with no deletion before the maximum replay window plus operational safety margin.

Delivery deduplication and business idempotency are separate controls. The stable business key must include repository, event type, target resource, and the relevant action semantics; a different delivery ID must not bypass business-level duplicate detection.

## 5. Required tests (red/green)

Before production code changes are accepted, add tests that demonstrate failure before implementation and pass after implementation:

### Worker identity
- A forged object containing both legacy booleans is rejected.
- A valid signed assertion is accepted only for its exact subject, role, audience, and operation.
- Modified payload, invalid MAC, unknown key ID, expired assertion, excessive lifetime, future issue time, wrong audience, wrong operation, and role escalation are rejected.
- Assertion replay is rejected or safely constrained by the documented short lifetime and operation binding.
- Lease fencing still rejects stale generations after identity verification succeeds.

### GitHub webhook
- Valid signature over exact raw bytes succeeds.
- One-byte body mutation, wrong secret, malformed signature, missing signature, and oversized body fail before JSON parsing.
- Header delivery ID cannot be overridden by body fields.
- Duplicate delivery ID with identical digest is a no-op.
- Duplicate delivery ID with different digest is quarantined.
- Concurrent duplicate deliveries produce exactly one durable claim.
- Storage errors fail closed.
- Existing issue policy, allowlist, timestamp, size, prompt-injection, and read-only behavior remain intact.

## 6. Rollout and safety gates

1. Implement on the isolated remediation branch only.
2. Run focused tests with observed red then green, full Node suite, Durable Object Vitest suite, syntax checks, and Wrangler dry-run.
3. Review exact diff and CI results on the final commit SHA.
4. Validate staging backup/export and a restore drill before any Durable Object schema change or runtime activation.
5. Verify the exact deployed Worker bindings and Durable Object namespaces before enabling ingress.
6. Obtain independent formal review and enforce branch protection before merge.
7. Keep Production disabled until all evidence gates pass and the operator separately authorizes migration/deployment.

## 7. Explicit non-goals

- No merge to `main`.
- No Cloudflare deployment, traffic change, secret rotation, or Durable Object migration.
- No task execution or write side effects from GitHub webhook intake.
- No merging of `KnowledgeStore` and `OrchestratorLedger`.
- No claim of production readiness from source-level tests alone.

## 8. Acceptance statement

This record is a design decision and implementation contract, not proof that the controls exist. Completion requires the tests and runtime evidence above. Until then, webhook-driven execution and Production remain NO-GO.
