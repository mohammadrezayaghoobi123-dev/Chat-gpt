# Executor Ed25519 Assertion Verification Contract

## Status and scope

This document describes the isolated Executor assertion protocol and its Ledger verification boundary. The implementation is limited to assertion creation/verification primitives and the OrchestratorLedger.claimTask authentication branch.

It does not provision a Cloudflare secret, deploy a Worker, activate an Executor runtime, expose an HTTP endpoint, or change production configuration. Runtime activation remains a separate release decision.

## Trust boundaries

| Component | Key material | Permitted capability |
|---|---|---|
| Dedicated Executor signer (future runtime integration) | Ed25519 PKCS#8 private key | Sign only fixed orchestrator-executor / agent / claimTask assertions |
| chat-gpt111 Ledger Worker | Ed25519 raw public-key set | Verify Executor assertions; cannot derive or use the private key |
| Existing Scheduler/Outbox paths | Existing HMAC key set | Preserve existing Scheduler/Outbox and non-Executor compatibility behavior; cannot create a valid Ed25519 Executor signature |

The private signing key must be provisioned only as a secret bound to the dedicated Executor Worker. It must never be added to the Ledger Worker, shared HMAC configuration, source control, logs, issues, or test fixtures as a literal credential.

The Ledger Worker receives only public verification material through ORCHESTRATOR_EXECUTOR_VERIFICATION_KEYS. Public-key material is not a secret, but the mapping is security policy and must be reviewed like code.

## Public-key set schema

The environment value is a JSON object keyed by a bounded key identifier. Each entry has exactly four fields:

~~~json
{
  "executor-ed25519-v1": {
    "publicKey": "<base64url-encoded 32-byte Ed25519 raw public key>",
    "subject": "orchestrator-executor",
    "role": "agent",
    "operations": ["claimTask"]
  }
}
~~~

The verifier accepts one to four key identifiers. Every entry is validated, including entries not selected by the current token. Unknown fields, private-key fields, a different principal, role, or operation, malformed key identifiers, and invalid public-key material fail closed.

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
| op | claimTask |
| iat | Safe integer Unix time in seconds |
| exp | iat + 60 seconds maximum |
| jti | Random 128-bit identifier with the jti- prefix |

The signer accepts only a timestamp input. Caller-supplied subject, role, operation, issuer, audience, expiry, or JTI values are rejected. The signer imports PKCS#8 Ed25519 material for the sign usage only. The verifier imports raw public-key material for the verify usage only.

The verifier enforces a 60-second maximum lifetime and five-second clock-skew allowance. The Ledger consumes the JTI transactionally with the claim operation. Reuse of a consumed JTI is rejected.

## Ledger compatibility boundary

- When workerId is exactly orchestrator-executor, claimTask must use ORCHESTRATOR_EXECUTOR_VERIFICATION_KEYS and the Ed25519 v2 verifier.
- An HMAC v1 assertion must not authenticate that fixed Executor principal.
- An Ed25519 Executor assertion must not authenticate Scheduler task creation or other HMAC-only Ledger operations.
- Other existing agent identities retain the current HMAC compatibility path in this slice.
- Scheduler/Outbox HMAC signer and verifier behavior is not migrated or broadened here.
- Claim assignment, cursor ownership, JTI consumption, and lease fencing remain Ledger-owned.

## Key rotation

A rotation may temporarily include multiple public key identifiers, up to the verifier's four-key bound. The signer selects only its configured active key identifier. Before retiring an old public key, operators must allow the maximum assertion lifetime plus clock skew and confirm no in-flight token can still be valid. Key provisioning, active-key switching, and secret rotation are not performed by this PR.

## Required verification

- Ed25519 round-trip using a public-only verifier key set.
- HMAC v1 cannot authenticate the fixed Executor principal.
- Ed25519 Executor assertions cannot authenticate Scheduler task creation.
- Unknown key IDs, malformed key material, extra/private-key fields, altered payloads, altered signatures, expiry, clock skew, and unauthorized key policy are rejected.
- The Ledger consumes a valid JTI once and rejects replay across separate claim attempts.
- Existing HMAC agent claims and Scheduler/Outbox tests remain green.
- No public claim, lease, cursor, or assertion-minting MCP API is introduced.

## Release boundary

This contract is not evidence that a dedicated Executor Worker is deployed or that a private key has been provisioned. Until the separate Worker is implemented, configured with a dedicated private key, bound privately to the Ledger Durable Object, and independently verified, the Executor runtime remains inactive. Missing public-key configuration fails closed. Merge and deployment remain outside this PR.
