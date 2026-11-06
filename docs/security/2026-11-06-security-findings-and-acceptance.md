# Security Findings and Remediation Acceptance Criteria — 2026-11-06

## Status

This is a source-level security review of the remediation branch. It records verified code observations and testable acceptance criteria. It is not a claim that the findings have been fixed, that tests were run, or that the deployment is secure.

## Evidence baseline

| Component | Path | Observed source blob |
|---|---|---|
| OrchestratorLedger | `cloud-engineering-connector/orchestrator-ledger.js` | `bc34dd191994f5c5c40d1c0d468d08de3304e051` |
| GitHub intake | `cloud-engineering-connector/orchestrator-github-intake.js` | `4c8c109a24f08a173d9897668d0e455e8edbe783` |
| Worker | `cloud-engineering-connector/worker.js` | `ea872fc7597c5b320b40fbd73b53514891fdec98` |
| Durable Object tests | `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js` | `1f6beb87d937ed882c78f5dbdd3b44befc12bfb1` |
| Wrangler config | `cloud-engineering-connector/wrangler.toml` | `55d1af8492cbaa3a38ae94f664d2fbad36dfb123` |

## Finding SEC-01 — Caller-asserted worker identity is not an authentication proof

**Severity:** Critical architectural trust-boundary issue; exploitability depends on the actual Durable Object RPC reachability and caller graph.

**Observed behavior:** `hasVerifiedWorkerIdentity` accepts a plain object when `authenticated === true`, `identityVerified === true`, `id` matches, and role is allowed. Methods such as `claimTask`, `transitionTask`, `claimOutbox`, and `completeOutbox` rely on this predicate. A plain object with these properties is caller-constructible; the booleans do not establish who issued the assertion.

**Why this matters:** A lease fence limits concurrency and stale-worker writes, but it does not authenticate the worker that is requesting a lease. Authentication and authorization are distinct controls.

**Required remediation design:**
1. Map every RPC call site and identify which Worker code can obtain the Durable Object stub.
2. Define a narrow trusted Worker-to-DO authentication boundary. Do not accept caller-selected identity, role, or boolean trust flags as proof.
3. Authenticate at the boundary using a server-held credential or a signed, short-lived assertion with issuer, audience, subject, role, expiry, and unique nonce. Verify it inside the DO before any state-changing operation.
4. Ensure credentials are never returned to MCP clients, logged, persisted in task payloads, or accepted from arbitrary public request fields.
5. Keep lease-generation fencing after authentication; it remains a separate concurrency control.
6. Reject missing, malformed, expired, wrong-audience, wrong-issuer, and replayed assertions before SQL writes.

**Acceptance tests (must observe RED before implementation):**
- A caller-supplied object containing both booleans set to true cannot claim or complete a lease.
- A valid assertion issued by the trusted Worker boundary can perform the permitted operation.
- Expired, wrong-audience, wrong-subject, wrong-role, malformed-signature, and replayed assertions are rejected without changing durable state.
- A stale lease generation remains rejected even with a valid identity assertion.
- No secret-bearing material is persisted or included in returned errors.

**Implementation gate:** Do not choose a signing format or secret distribution until the full Worker-to-DO call graph and Cloudflare binding topology have been inspected.

## Finding SEC-02 — GitHub webhook authentication and durable replay protection are not established

**Severity:** High; webhook authenticity and delivery replay resistance are required before any webhook-triggered state change.

**Observed behavior:** The current intake path assumes actor, repository, event type, and delivery ID are already verified. The inspected test replay store is in-memory. The intake path reports dry-run acceptance and does not execute task side effects. No end-to-end evidence currently establishes raw-body HMAC verification plus durable delivery deduplication in the deployed Worker.

**Required remediation design:**
1. Read the raw request body once and verify `X-Hub-Signature-256` using HMAC-SHA256 and a server-held webhook secret.
2. Compare the expected and supplied digest in constant time; reject missing, malformed, or invalid signatures before parsing or trusting payload fields.
3. Enforce a strict body-size limit before buffering/parsing.
4. Validate delivery ID, event type, repository identity, installation identity, and action against explicit allowlists.
5. Persist the delivery ID in a durable replay ledger with an atomic uniqueness constraint and bounded retention.
6. Treat duplicate delivery IDs as idempotent no-ops; ensure concurrent duplicate requests cannot both enqueue side effects.
7. Keep webhook intake separate from task execution. Intake should enqueue a bounded, idempotent event; execution requires its own authorization and audit trail.

**Acceptance tests (must observe RED before implementation):**
- Valid signature over exact raw bytes is accepted.
- One-byte body mutation, wrong secret, missing signature, malformed digest, and oversized body are rejected.
- A duplicate delivery ID is not enqueued twice, including concurrent requests and Worker restarts.
- A delivery ID reused with a different payload is rejected and audited as a conflict.
- Untrusted repository, installation, event type, and action are rejected.
- No side effect occurs before signature and identity validation.

## Finding REL-01 — Source cron declarations do not prove runtime scheduled execution

**Severity:** High operational readiness gap.

**Observed evidence:** `wrangler.toml` declares a five-minute cron for root and Staging. The Cloudflare schedules API inventory returned empty schedules for both deployed Worker scripts during the 2026-11-06 audit. The source configuration and live runtime therefore disagree or the runtime schedule is not visible through the inspected API.

**Required remediation:**
- Reconcile deployed Worker script names and environment-specific deployment configuration.
- Apply schedule configuration only through an approved Staging release after backup and rollback readiness.
- Verify the live schedules API after deployment.
- Trigger or observe an actual scheduled invocation and retain invocation evidence.
- Do not infer successful scheduled execution from a source declaration or a successful deployment alone.

## Finding DATA-01 — Durable Object migration is blocked by absent runtime and recovery evidence

**Severity:** Release blocker.

**Observed evidence:** The Cloudflare namespace inventory did not show KnowledgeStore or OrchestratorLedger namespaces. The runtime inventory showed only AgentBudget, AgentSession, and Staging WriteControl. No verified backup artifact, digest, isolated restore drill, or migration-history reconciliation is available in the evidence set.

**Required remediation:**
- Obtain a provider-supported export/backup for every affected namespace.
- Verify artifact digest and metadata independently.
- Restore into an isolated target and validate application-level invariants.
- Reconcile deployed migration history with Wrangler migration declarations.
- Preserve the architectural Option C boundary: KnowledgeStore remains canonical knowledge storage; OrchestratorLedger remains a separate orchestration ledger; Notion remains a projection.
- Require explicit operator authorization before Staging migration. Production migration remains prohibited until a separate approval gate.

## Finding GOV-01 — Release governance is not enforced on main

**Severity:** Critical release-governance gap.

**Observed evidence:** GitHub branch metadata returned `protected=false`, protection disabled, and required status-check enforcement off for `main` at the time of audit.

**Required remediation:**
- An administrator must configure a repository ruleset or branch protection requiring pull requests, independent approval, current-head approval, required CI checks, stale approval dismissal, and restrictions on force-push and deletion.
- Require at least one independent reviewer who is not the author and is not controlled by the same person.
- Verify the active ruleset through the GitHub API after configuration.
- Do not self-approve or simulate an independent review.

## Execution boundary

No production code was modified in this review step. No test command was executed because the connected GitHub interface exposes repository file operations and workflow metadata but does not provide a checked-out local working tree in which to run the package test suite. A future implementation must follow a recorded RED → GREEN → REFACTOR cycle and then pass the repository CI on the exact candidate SHA.

## Release decision

- Production: **NO-GO**
- Staging migration: **BLOCKED**
- Staging runtime acceptance: **UNVERIFIED**
- Independent review: **REQUIRED**
- Main branch governance: **NOT ENFORCED**
