> **Historical evidence snapshot — superseded.** This document records findings against
> `edcebf33a3673ee4a5c705449869f6880e5480af` on
> `remediation/production-readiness-2026-11-06`. Its negative findings below are
> not assertions about the later `remediation/orchestrator-production-hardening`
> branch. For current source state, use the addendum at the end and verify the
> exact commit and CI runs before making a release decision.

# Security Integration Gate — Webhook and Ledger Identity

- Date: 2026-11-06
- Reviewed branch: `remediation/production-readiness-2026-11-06`
- Reviewed head: `edcebf33a3673ee4a5c705449869f6880e5480af`
- Scope: Worker ingress routing, webhook authentication module, OrchestratorLedger identity boundary
- Status: BLOCKED — source-level integration is not complete

## Verified facts

1. `github-webhook-auth.js` exports `authenticateGitHubWebhook`. It validates the HMAC-SHA-256 signature against the raw request body before JSON parsing, validates delivery/event headers, enforces a bounded body, and returns a SHA-256 body digest.
2. The Node contract tests are included in `npm test` and `npm run check`.
3. GitHub Actions workflow `Cloud Engineering Connector CI` completed successfully on the reviewed head. The main `test` job passed dependency installation, npm advisory audit, the Node and Durable Object test commands, and syntax/Wrangler checks. The live Staging smoke job was skipped.
4. `worker.js` routes `/healthz`, `/readyz`, and `/mcp`; the inspected request router has no GitHub webhook route and does not import or call `authenticateGitHubWebhook`. Therefore the authenticator is currently an isolated module, not an active ingress control.
5. `orchestrator-ledger.js` currently treats a worker object as verified when caller-supplied booleans `authenticated === true` and `identityVerified === true`, plus matching ID and allowed role. Those fields are not cryptographic proof. Existing Durable Object tests construct these objects directly.
6. The Worker does not currently demonstrate a signed Worker-to-Ledger identity assertion verified inside the Durable Object.
7. The webhook authenticator does not itself persist delivery IDs. Durable replay prevention is not implemented by this module.

## Security consequence

The current CI result validates the isolated authenticator and existing suites; it does not prove that GitHub webhook requests are authenticated at the live Worker boundary, nor that Ledger lease operations are protected against caller-forged identity objects.

## Required implementation sequence

1. Define a versioned Worker-to-Ledger signed assertion contract, including issuer, audience, subject, role, operation, issued-at, expiry, key ID, and unique assertion ID.
2. Verify the assertion inside the Durable Object using a server-only HMAC key, canonical serialization, constant-time MAC comparison, strict claim validation, bounded clock skew/lifetime, and operation binding. Remove boolean identity fields as authority.
3. Add red/green Durable Object tests for forged legacy booleans, valid assertions, tampered claims, wrong audience/operation/role, expiry, future issue time, key rotation, and lease fencing.
4. Add an HTTP webhook route that reads bounded raw bytes once, invokes the authenticator before parsing, validates repository/event policy, and passes only authenticated transport metadata to the durable replay claim.
5. Implement atomic durable replay claims in OrchestratorLedger with unique delivery ID, body digest, duplicate-no-op semantics, conflicting-digest quarantine, and fail-closed storage errors.
6. Add integration tests for concurrent duplicate delivery, storage failures, header/body confusion, and no side effects before authentication.
7. Run focused tests, full Node suite, Durable Object suite, syntax checks, Wrangler dry-run, and inspect exact final CI head.
8. Only after Staging backup/restore evidence and independent formal review may runtime activation be considered.

## Explicit non-actions

- No Worker webhook route was added.
- No Ledger identity implementation was changed.
- No durable replay table was added.
- No Cloudflare binding, secret, migration, deployment, or traffic was changed.
- No production readiness claim is made.

## Release decision

Webhook-driven task execution and Production remain **NO-GO**. The successful CI run is necessary but insufficient evidence for runtime security.


## Addendum — subsequent source remediation (2026-11-06)

This addendum is deliberately separate from the historical assessment above.

- Current remediation branch: `remediation/orchestrator-production-hardening`
- Current inspected head at addendum authoring: `d541ac8979f06d12446a8707e50f63d9e84ef753`
- The Worker source now contains the `/webhooks/github` route, calls
  `authenticateGitHubWebhook` before passing verified transport metadata to
  `OrchestratorLedger.claimGitHubDelivery`, and propagates the business
  `idempotencyKey` and semantic `inputHash`.
- The Ledger source now contains durable webhook-delivery and business
  idempotency tables and an atomic `claimGitHubDelivery` transaction.
- The intake semantic hash was corrected to include issue identity/content and
  the required policy label, while excluding unrelated mutable triage labels.
- A focused regression test now verifies that an unrelated label change does
  not create a second business operation.
- Durable Object tests were added for distinct delivery IDs replaying the same
  business key/hash and for conflicting semantic hashes being rejected.

**Verification state:** the intake contract workflow for
`1176acdad43502a7fc293a1be75e52a8d18c3476` passed. Full CI and secret-scan
runs for `d541ac8979f06d12446a8707e50f63d9e84ef753` were queued/in progress
when this addendum was written; do not treat them as passing evidence until
their terminal conclusions are inspected. The Staging smoke job remained
skipped on the preceding run. No live Cloudflare runtime verification or
Production deployment is claimed.

**Release decision remains NO-GO** until the exact current head has green CI,
live Staging end-to-end verification, independent review, and the remaining
runtime signer/publisher/scheduler and recovery controls are proven.
