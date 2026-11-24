# Scheduler Task Admission and Durable Recovery

**Status:** Draft implementation evidence  
**PR:** #426  
**Scope:** Isolated source, Cloudflare test fixtures, and Wrangler dry-run configuration  
**Production activation:** Not performed

## 1. Architecture

The scheduler intake uses a Cloudflare Workflow triggered directly by Cron schedules configured on the Workflow export. There is no intermediary Worker `scheduled()` handler and no application-generated `WorkflowBinding.create()` handoff.

A scheduled Workflow receives trusted platform metadata through `event.schedule`:

- `cron`: the exact Cron expression that triggered this Workflow instance.
- `scheduledTime`: the scheduled trigger time in integer milliseconds since the Unix epoch.

The Workflow validates these fields and performs schedule-policy selection and full-batch preflight inside the durable `prepare-scheduled-admission` step. It then processes each Task using its own durable `step.do` step.

The production scheduler config declares the Workflow export but intentionally contains no `schedules` array. No Cron expression is active in this change. A reviewed schedule may only be added after separate policy, key-custody, cost, and staging approval.

## 2. Authorization and admission protocol

For each Task:

1. The adapter resolves TenantDirectory and OrchestratorLedger using the tenant ID as the Durable Object name.
2. It probes OrchestratorLedger for an existing Task admission receipt before contacting TenantDirectory.
3. If the exact Task/Receipt pair already exists, it returns a safe replay outcome and does not request a new Grant.
4. If no receipt exists, TenantDirectory prepares an Ed25519 `ad1` Grant bound to the principal, tenant, project, Task ID, canonical Task digest, idempotency digest, input hash, membership snapshot, and policy decision snapshot.
5. The scheduler creates a short-lived worker assertion immediately before the Ledger RPC. This assertion proves the fixed Scheduler system identity; it is not Task authorization.
6. OrchestratorLedger independently validates the Grant, worker assertion, and canonical Task, then commits the Task, immutable admission receipt, Outbox event, consumed assertion JTI, and claim-candidate index in one Ledger-local transaction.

The receipt probe is read-only and returns only a safe receipt projection. It never returns the Grant bearer token. Task and receipt absence is `not_found`; an incomplete pair or mismatched scope/digest returns `conflict`.

## 3. Expired Grant recovery

A Directory reservation whose Grant has expired can be renewed only when all of these remain unchanged:

- tenant, project, principal, Task ID, Task digest, idempotency digest, and input hash;
- active membership ID and membership version;
- policy-scope epoch;
- allow-rule decision ID, rule version, and resource digest.

Renewal requires the old Grant to be expired by at least five seconds. The replacement Ed25519 Grant is signed outside the synchronous transaction, receives a new admission ID and JTI, and is committed using a compare-and-swap fence against the old reservation identifiers.

The reservation update and append-only `renewTaskAdmissionGrant` audit event share one synchronous Directory transaction. If audit insertion fails, the reservation change rolls back. The audit event records previous and replacement identifiers and the authorization snapshot; it does not store the raw bearer Grant.

A membership or policy change fails closed. Renewal does not reauthorize the Task under a new permission snapshot.

## 4. Failure semantics and atomicity

The Workflow uses one preflight step plus up to twenty Task steps. Each step has a bounded retry policy: six retries, exponential backoff beginning at ten seconds, and a two-minute step timeout.

Configuration, malformed schedule metadata, invalid policy, missing signer configuration, and authorization conflicts are permanent failures. Transient signing/RPC/transport errors remain retryable within the Workflow step budget.

There is no distributed transaction across TenantDirectory and OrchestratorLedger and no batch-wide atomicity guarantee:

- Directory reservation + its audit event are atomic within TenantDirectory.
- Task + immutable admission receipt + Outbox event and related Ledger indexes are atomic within OrchestratorLedger.
- If Task N fails permanently after Tasks 1..N-1 committed, those earlier Task commits remain. The Workflow reports an error rather than rolling them back.
- Replayed event identity is stable because Task ID, idempotency key, Task payload timestamps, Task digest, and input hash derive from the original Cron metadata.

This is at-least-once execution with idempotent state transitions, not exactly-once delivery. The Ledger receipt probe closes the lost-response ambiguity after a Ledger commit: a retry sees the immutable receipt before considering an expired Directory Grant.

## 5. Hostile verification

The dedicated Workflow test suite exercises the exported `WorkflowEntrypoint.run()` contract using Cloudflare Workers runtime objects and a deterministic test implementation of `step.do`. It does not claim to be a live Cloudflare Workflow service integration test.

Covered cases:

- transient Task-step failure is retried and then creates a single Task, receipt, and Outbox event;
- re-execution for the same Cron metadata observes the receipt and produces a replay, with no second Task/receipt/Outbox row;
- a later permanent Task failure preserves earlier Task commits and prevents a denied Task from being committed;
- a simulated lost Ledger response after commit is recovered from the receipt even after the Directory Grant expires;
- tampered Workflow snapshot digests are rejected;
- missing trusted `event.schedule` metadata is rejected before any durable step or Task write.

Directory hostile tests additionally cover the five-second renewal fence, membership revocation, concurrent renewals, and audit-write rollback. Ledger tests cover not-found, exact receipt match, and receipt mismatch.

## 6. Runtime configuration boundaries

The dedicated `wrangler.scheduler.toml` config:

- names a separate Worker script, `chat-gpt111-scheduler`;
- binds TenantDirectory and OrchestratorLedger using remote `script_name = "chat-gpt111"`, preserving the authoritative existing Durable Object namespaces;
- declares the Workflow export;
- contains no `fetch` entrypoint, routes, Cron schedules, or new local production Durable Object migrations.

The public `wrangler.toml`, main Worker entrypoint, secrets, live bindings, routes, Cron schedules, staging, production, and user laptop are not modified by this change. The test-only Wrangler config creates isolated local Durable Objects with separate test keys and identifiers.

## 7. Remaining activation gates

1. Review and approve the actual Cron expression(s), selected tenant policy, service principal, task templates, and maximum execution frequency.
2. Verify remote Durable Object class exports and namespace ownership on the live `chat-gpt111` Worker without changing them.
3. Provision and validate the Directory Grant private key and Ledger verification key, plus Scheduler assertion keys, under a documented key custody/rotation plan. No production secret is added in this PR.
4. Verify Workflow plan limits, retention, step/storage consumption, and account billing tier. Account plan and production usage are not assumed.
5. Run a separately approved staging deployment and actual platform Cron smoke test; neither is performed here.
6. Resolve the existing Full History Secret Scan findings. The current failure is not waived or represented as a clean scan.

## 8. Verification record

The final commit-specific CI run is authoritative. Wrangler checks are dry-runs only. The Full History Secret Scan and deployment smoke remain separate gates; a successful source/test CI run does not clear those blockers.

References:

- https://developers.cloudflare.com/workflows/build/workers-api/
- https://developers.cloudflare.com/workflows/build/events-and-parameters/
- https://developers.cloudflare.com/workflows/build/trigger-workflows/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
