# Orchestrator Lease Reconciliation Evidence

## Purpose

Expired worker-owned leases are not ordinary scheduler candidates. Reclaiming one requires a short-lived, task-bound, single-use authorization signed by a trusted reconciliation issuer. Missing or invalid configuration fails closed.

## Runtime bindings

Configure these bindings independently in each Worker environment:

| Binding | Type | Format |
|---|---|---|
| `LEDGER_RECONCILIATION_EVIDENCE_KEYS` | Secret text | JSON object mapping key IDs to 32–64-byte lowercase hex HMAC keys |
| `LEDGER_RECONCILIATION_EVIDENCE_ISSUERS` | Plain text | JSON array containing 1–16 allowed issuer IDs |

Example shape only (never use the example key as a real secret):

```json
{
  "reconcile-v1": "<64-or-128-lowercase-hex-characters>"
}
```

Issuer allowlist shape:

```json
["trusted-reconciliation-service"]
```

The keyset is a secret and must not be committed, written into Wrangler configuration, logged, or exposed through readiness endpoints. The issuer allowlist contains identifiers only and is not secret.

## Signed evidence contract

The evidence object must contain exactly these fields:

- `taskId`: exact task identifier
- `priorGeneration`: positive integer matching the expired lease generation
- `evidenceId`: unique identifier, at least 16 characters
- `issuer`: an identifier in the configured allowlist
- `issuedAt`: Unix epoch milliseconds
- `expiresAt`: Unix epoch milliseconds
- `signature`: `v1.<key-id>.<base64url-hmac>`

The HMAC-SHA-256 input is:

```text
v1.<key-id>.<base64url(UTF-8(canonical JSON))>
```

The canonical JSON payload is:

```json
{
  "v": 1,
  "taskId": "...",
  "priorGeneration": 1,
  "evidenceId": "...",
  "issuer": "...",
  "issuedAt": 0,
  "expiresAt": 0
}
```

Evidence lifetime is capped at five minutes. Future issue times are tolerated by at most 30 seconds; expiry is strict. The issuer must bind the evidence to one task and one lease generation.

## Consumption and replay protection

Evidence verification happens before the Durable Object transaction. Inside the claim transaction, the ledger re-checks task identity, executor assignment, lease expiry and generation, checks whether the evidence ID was already consumed, consumes it, consumes the worker assertion, and advances the lease generation atomically. A failed transaction rolls back all writes.

Consumed evidence IDs are retained through expiry plus a ten-minute margin. Cleanup removes at most 100 expired records per claim operation using the expiry index.

## Operational constraints

- Do not enable lease reconciliation until a trusted issuer service can generate the exact signed contract.
- Use a separate HMAC keyset from worker-assertion and owner-assertion keys.
- Rotate by adding a new key ID, switching the issuer, then removing the old key after all evidence signed with it has expired.
- A missing keyset or issuer allowlist makes `/readyz` fail closed.
- Configuration changes and deployments are separate, explicitly authorized operations; this implementation does not modify Cloudflare resources.
