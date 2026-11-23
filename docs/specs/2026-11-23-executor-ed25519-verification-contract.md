# Executor Ed25519 Assertion Verification Contract

## Status and scope

This document describes the isolated Executor assertion protocol and its Ledger verification boundary. The implementation covers operation-scoped assertion creation/verification and the Ledger authentication boundary for the fixed Executor lease lifecycle.

It does not provision a Cloudflare secret, deploy a Worker, activate an Executor runtime, expose an HTTP endpoint, or change production configuration. Runtime activation remains a separate release decision.

## Trust boundaries

| Component | Key material | Permitted capability |
|---|---|---|
| Dedicated Executor signer (future runtime integration) | Ed25519 PKCS#8 private key | Sign only fixed orchestrator-executor / agent assertions for claimTask, renewLease, or releaseLease |
| chat-gpt111 Ledger Worker | Ed25519 raw public-key set | Verify Executor assertions; cannot derive or use the private key |
| Existing Scheduler/Outbox paths | Existing HMAC key set | Preserve existing Scheduler/Outbox and non-Executor compatibility behavior; cannot create a valid Ed25519 Executor signature |

The private signing key must be provisioned only as a secret bound to the dedicated Executor Worker. It must never be added to the Ledger Worker, shared HMAC configuration, source control, logs, issues, or test fixtures as a literal credential.

The Ledger Worker receives only public verification material through ORCHESTRATOR_EXECUTOR_VERIFICATION_KEYS. Public-key material is not a secret, but the mapping is security policy and must be reviewed like code.

## Trust-boundary diagram

~~~mermaid
flowchart LR
  Scheduler["Scheduler / Outbox runtime"] --> HMAC["Existing HMAC signing key"]
  HMAC --> HMACVerify["Ledger HMAC verifier"]
  Executor["Dedicated Executor Worker (future runtime)"] --> Private["Ed25519 private key"]
  Private --> Sign["Fixed allowlisted-operation signer"]
  Sign --> Token["Ed25519 v2 assertion"]
  Public["Ledger public-key set"] --> Verify["Ledger Ed25519 verifier"]
  Token --> Verify
  Verify --> Claim["Ledger claimTask / renewLease / releaseLease"]
  HMACVerify --> Legacy["Existing Scheduler / Outbox / non-Executor paths"]
~~~

## Public-key set schema

The environment value is a JSON object keyed by a bounded key identifier. Each entry has exactly four fields:

~~~json
{
  "executor-ed25519-v1": {
    "publicKey": "<base64url-encoded 32-byte Ed25519 raw public key>",
    "subject": "orchestrator-executor",
    "role": "agent",
    "operations": ["claimTask", "renewLease", "releaseLease"]
  }
}
~~~

The verifier accepts one to four key identifiers. Every entry is validated, including entries not selected by the current token. Unknown fields, private-key fields, a different principal, role, or operation outside the fixed three-operation allowlist, malformed key identifiers, and invalid public-key material fail closed.

The public-key set must not contain a private key or a generic algorithm selector. Algorithm selection is fixed by the protocol version and verification function.

## Assertion format

The token has four dot-separated segments:

~~~text
v2.<kid>.<canonical-base64url-payload>.<base64url-ed25519-signature>
~~~

The signature covers the exact UTF-8 bytes of the first three segments joined by dots. The canonical JSON payload contains exactly these claims:

| Claim | Fixed or bounded value |
|---|---|
| v | 2 |
| iss | orchestrator-executor |
| aud | orchestrator-ledger |
| sub | orchestrator-executor |
| role | agent |
| op | One of claimTask, renewLease, releaseLease |
| iat | Safe integer Unix time in seconds |
| exp | iat + 60 seconds maximum |
| jti | Random 128-bit identifier with the jti- prefix |

The signer accepts a timestamp and one operation selected from the fixed three-operation allowlist. It rejects any other operation and caller-supplied subject, role, issuer, audience, expiry, or JTI values. The signer imports PKCS#8 Ed25519 material for the sign usage only. The verifier imports raw public-key material for the verify usage only.

The verifier enforces a 60-second maximum lifetime and five-second clock-skew allowance. The Ledger consumes the JTI transactionally with the corresponding state-changing operation. Reuse of a consumed JTI is rejected.

## Ledger compatibility boundary

- When workerId is exactly orchestrator-executor, claimTask, renewLease, and releaseLease must use ORCHESTRATOR_EXECUTOR_VERIFICATION_KEYS and the Ed25519 v2 verifier; the signed operation must exactly match the Ledger method being invoked.
- An HMAC v1 assertion must not authenticate that fixed Executor principal.
- An Ed25519 Executor assertion must not authenticate Scheduler task creation or other Ledger operations outside the fixed allowlist. The fixed Executor principal is rejected from all other agent-authenticated Ledger methods, including advanceAgentRound, appendAuditEvent, transitionTask, recordMessage, and enqueueOutbox.
- Other existing agent identities retain the current HMAC compatibility path.
- Scheduler/Outbox HMAC signer and verifier behavior is not migrated or broadened here.
- The legacy HMAC createExecutorWorkerAssertion export now fails closed; only the Ed25519 signer module can mint a valid Executor assertion.
- Claim assignment, cursor ownership, JTI consumption, and lease fencing remain Ledger-owned.

## Key rotation

A rotation may temporarily include multiple public key identifiers, up to the verifier's four-key bound. The signer selects only its configured active key identifier. Before retiring an old public key, operators must allow the maximum assertion lifetime plus clock skew and confirm no in-flight token can still be valid. Key provisioning, active-key switching, and secret rotation are not performed by this PR.

## Required verification

- Ed25519 round-trip using a public-only verifier key set for each of the three authorized operations.\n- A token signed for one allowed operation is rejected at either of the other Ledger operation boundaries.\n- Executor renewal and release preserve lease-generation fencing, expiry checks, and one-time JTI consumption.\n- Executor HMAC assertions and all Executor operations outside the fixed allowlist are rejected.
- HMAC v1 cannot authenticate the fixed Executor principal.
- Ed25519 Executor assertions cannot authenticate Scheduler task creation.
- Unknown key IDs, malformed key material, extra/private-key fields, altered payloads, altered signatures, expiry, clock skew, and unauthorized key policy are rejected.
- The Ledger consumes a valid JTI once and rejects replay across separate claim attempts.
- Existing HMAC agent claims and Scheduler/Outbox tests remain green.
- No public claim, lease, cursor, or assertion-minting MCP API is introduced.

## Test fixture isolation

The Durable Object test harness derives a deterministic Ed25519 fixture at test runtime from numeric test-only material. The derived signing material is not stored as a literal, is not a production credential, and is never bound into the Ledger Worker environment. The Ledger test environment receives only the corresponding public key. The Scheduler HMAC test material is read from the existing test-only binding rather than duplicated in source.

## Release boundary

This contract is not evidence that a dedicated Executor Worker is deployed or that a private key has been provisioned. Until the separate Worker is implemented, configured with a dedicated private key, bound privately to the Ledger Durable Object, and independently verified, the Executor runtime remains inactive. Missing public-key configuration fails closed. Merge and deployment remain outside this PR.
