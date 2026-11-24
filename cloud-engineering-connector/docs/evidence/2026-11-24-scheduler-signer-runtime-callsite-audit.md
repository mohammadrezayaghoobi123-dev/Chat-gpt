# Scheduler Signer Runtime Call-Site Audit

**Audit date:** 2026-11-24  
**Baseline:** `97ba7b66b4c227b2dedaee9ab42a8e9973f1220d`  
**Scope:** Cloud Engineering Connector production JavaScript source and the Worker-to-Ledger assertion boundary

## Executive finding

The Scheduler signing grant is present and is accepted by the Orchestrator Ledger, but the reviewed production Worker has no runtime call site that mints an `orchestrator-scheduler / system / createTask` assertion.

The grant is therefore a **dormant internal capability** in the reviewed repository state. This is not evidence of a remotely exploitable vulnerability. It is also not proof that an out-of-repository Worker, Cloudflare binding, or account-level integration cannot use the capability.

## Source inventory and method

The audit enumerated the Connector's production JavaScript sources (22 files ending in `.js`, `.mjs`, or `.cjs`) from the baseline tree. Test and Cloudflare test directories were excluded from the production call-site inventory.

The source inventory was searched for:
- `createScheduledWorkerAssertion`
- `orchestrator-scheduler`
- `LEDGER_WORKER_ASSERTION_KEYS`

Relevant runtime files were then read at the exact baseline ref, and the Worker entrypoint and event handlers were followed into their signer and Ledger calls.

## Findings

### 1. Signer and verifier capability exists

`orchestrator-worker-identity.js` defines the fixed signer policy:

- `orchestrator-scheduler / system / createTask`
- `orchestrator-outbox-publisher / publisher / claimOutbox, failOutbox, completeOutbox`
- `orchestrator-outbox-consumer / consumer / recordOutboxReceipt`
- `orchestrator-outbox-dlq-archiver / consumer / recordOutboxDeadLetter`

`orchestrator-ledger.js` independently verifies the exact Scheduler identity, role, and operation in `createTask`. The grant is therefore not merely a test-only string: PR #405 separately proves that the production signer output is accepted by the real Durable Object and SQLite persistence path.

### 2. The only production signer caller is the Worker entrypoint

The production source inventory found only two files referencing the signer symbol:
- `orchestrator-worker-identity.js`: signer definition and policy.
- `worker.js`: the only production import and call sites.

There are exactly three signer invocation sites in `worker.js`:

| Runtime path | Principal | Role | Ledger operations |
|---|---|---|---|
| `processOrchestratorOutbox` | `orchestrator-outbox-publisher` | `publisher` | `claimOutbox`, `failOutbox`, `completeOutbox` |
| `consumeOrchestratorOutbox` | `orchestrator-outbox-consumer` | `consumer` | `recordOutboxReceipt` |
| `consumeOrchestratorDeadLetters` | `orchestrator-outbox-dlq-archiver` | `consumer` | `recordOutboxDeadLetter` |

No production Worker call site uses the Scheduler principal.

### 3. Event routing does not create Tasks

The exported `scheduled` handler delegates to:
- `processKnowledgeOutbox`
- `processOrchestratorOutbox`

It does not call `createTask`.

The exported `queue` handler delegates to:
- `consumeOrchestratorOutbox`
- `consumeOrchestratorDeadLetters`

These Queue event paths mint only receipt-consumer and DLQ-archiver assertions. They do not mint Scheduler assertions.

The Worker HTTP/MCP surface is separately characterized by PR #397, which verifies that protected Scheduler/Task operations are not advertised or routed by the current authenticated MCP/HTTP interface.

### 4. Test fixtures are not production callers

Several Node and Cloudflare tests construct Scheduler assertions to exercise the Ledger's `createTask` authentication and persistence contract. Those test references are excluded from the production runtime inventory and must not be interpreted as a deployed Scheduler runtime.

### 5. Signer naming/comment does not prove event provenance

The signer API is named `createScheduledWorkerAssertion`, and its module comment describes fixed principals whose authority comes from the Cloudflare scheduled-event execution path.

However, the same function is used by Queue event handlers for receipt and DLQ processing. Its input is a key set, key ID, and an expected principal/role/operation tuple. The signed claims bind those values, but do not include a cryptographic proof of a particular `ScheduledController`, Cron invocation, or Queue event.

Accordingly, the signer establishes **fixed-principal operation authorization**, not independent proof of the event source. In the current Worker, event provenance relies on trusted internal call sites choosing fixed identities and not forwarding caller-controlled identity parameters into the signer.

## Regression guard added

The test-only change in `test/orchestrator-worker-identity.test.js` scans production JavaScript files and asserts that:
1. Only the signer implementation and Worker entrypoint reference `createScheduledWorkerAssertion`.
2. Exactly three signer call sites exist in the Worker.
3. Those call sites use only the Publisher, receipt Consumer, and DLQ Archiver principals.
4. The Worker source does not acquire an `orchestrator-scheduler` call site without a separately reviewed contract.

This is a source-structure regression guard. It is not a cryptographic boundary and does not inspect Cloudflare account configuration or code outside this repository.

## Security disposition

| Claim | Disposition | Reason |
|---|---|---|
| The Scheduler signer grant exists | **Provisionally supported** | Fixed signer policy and Ledger verifier are present; PR #405 proves signer-to-Ledger compatibility |
| The current production Worker uses the Scheduler grant | **Rejected for reviewed source state** | No Scheduler mint call site in the Worker or other inventoried production JS |
| The current MCP/HTTP surface exposes Scheduler intake | **Rejected for reviewed surface** | PR #397 behavioral test denies protected operations |
| No external Worker or infrastructure caller exists | **Unknown** | No Cloudflare account-level or out-of-repository inventory was performed |
| The signing API proves that a call originated from a scheduled event | **Rejected** | The token binds fixed claims but contains no event-source attestation |

## Decision

Do not add a Scheduler runtime call site and do not broaden the signer policy in this step. Keep Task creation fail-closed until the Scheduler owner, execution boundary, and event-provenance contract are explicitly established.

Do not remove the dormant grant solely on this source audit: the intended external Scheduler ownership and any out-of-repository caller remain unknown. A later policy decision can either remove the unused grant or introduce a separately reviewed, narrowly scoped Scheduler capability with a concrete runtime and provenance proof.

## Safety

This audit and its guard are test/documentation-only. No production source, `main`, live Worker, Cloudflare resource, Queue, Secret, merge, or deployment was changed or invoked.
