# Scheduler Runtime Reachability Audit

**Assessment date:** 2026-11-24  
**Audited source snapshot:** `12ab44c1bdfb7f19640068939d3e0463c84b8d68`  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Related characterization:** PR #383  
**Related mutation control:** PR #385 (closed, unmerged)

## 1. Question and scope

The preceding Ledger experiment established a narrow internal behavior: after a Task INSERT is aborted inside `createTask`'s SQLite transaction, the consumed assertion JTI is rolled back too; the exact same still-valid signed assertion can then be accepted with a different Task projection.

This audit asks a separate question:

> Does the repository's current runtime actually mint and invoke the fixed `orchestrator-scheduler / system / createTask` assertion, and can the existing Cron, MCP, webhook, Queue, or GitHub Actions paths reach that Ledger operation?

This is a repository-source reachability assessment, not a live Cloudflare inspection, penetration test, or claim about Workers deployed outside this repository.

## 2. Evidence inventory

### 2.1 Worker entry point and Cron

- `cloud-engineering-connector/index.js:1-5` imports `worker.js`, exports the Durable Object classes, and exports that Worker as the default entry point.
- `cloud-engineering-connector/wrangler.toml:2` declares `index.js` as the Worker entry.
- `cloud-engineering-connector/wrangler.toml:8,82` declares the five-minute Cron for Production and Staging.
- `cloud-engineering-connector/worker.js:1571-1609` implements and exports the scheduled handler. The handler awaits `processKnowledgeOutbox` and `processOrchestratorOutbox`; it does not invoke a Scheduler consumer, `createTask`, or `claimTask`.
- `cloud-engineering-connector/worker.js:1248-1339` implements the Orchestrator Outbox publisher. Its fixed identity is `orchestrator-outbox-publisher`; it claims, publishes, and completes/fails Outbox events.
- `cloud-engineering-connector/worker.js:1341-1469` implements the Outbox receipt consumer. It accepts the explicit event types `task.created`, `task.transitioned`, and `vault.document.proposed`, then calls `recordOutboxReceipt`. These are event receipts, not task creation or execution.
- `cloud-engineering-connector/worker.js:1470-1554` implements the DLQ archiver and calls `recordOutboxDeadLetter`.
- `cloud-engineering-connector/worker.js:1555-1569` routes only the configured Outbox and DLQ Queue names; unknown queue names are retried.

### 2.2 Signer boundary

Source: `cloud-engineering-connector/orchestrator-worker-identity.js`.

- Lines 84-91 define the fixed-principal policy. It permits `orchestrator-scheduler` with role `system` and operation `createTask`, in addition to the separate Outbox publisher/consumer principals.
- Lines 108-135 implement `createScheduledWorkerAssertion`, enforce that policy, issue a 60-second assertion, and mint a new random JTI for each call (lines 126-127).
- In `worker.js`, the three signer call-sites are:
  - line 1272: publisher assertion; operations are `claimOutbox`, `failOutbox`, and `completeOutbox`;
  - line 1406: consumer assertion for `recordOutboxReceipt`;
  - line 1520: DLQ archiver assertion for `recordOutboxDeadLetter`.
- No call-site in the Worker mints a Scheduler assertion.

The signer allowlist therefore proves that the Scheduler principal is an authorized *capability in the identity module*. It does not prove that a Scheduler runtime consumer exists or is invoked.

### 2.3 Ledger boundary

Source: `cloud-engineering-connector/orchestrator-ledger.js`.

- Line 583 defines `createTask`.
- The method checks the supplied worker ID and verifies an assertion against the exact Scheduler subject, system role, and `createTask` operation before its transaction (lines 583-618).
- The same transaction consumes the assertion JTI and inserts the Task (lines 619 onward).
- Line 809 defines `claimTask`; it has a separate Agent assertion contract.

The Ledger method is therefore implemented and cryptographically gated. The missing element identified by this audit is its trusted runtime caller, not the Ledger method itself.

### 2.4 Queue and workflow configuration

Source: `cloud-engineering-connector/wrangler.toml`.

- Lines 51-52 bind the `ORCHESTRATOR_LEDGER` Durable Object.
- Lines 59-72 configure the Orchestrator Outbox producer, consumer, and DLQ.
- Staging repeats the same Outbox/DLQ topology at lines 125-153.
- No dedicated job-intake Queue, Scheduler Queue consumer, or execution wake-up Queue is declared in this snapshot.

The existing Outbox Queue must not be treated as a task-intake or execution Queue.

The GitHub Actions workflow inventory was also reviewed:

- `.github/workflows/orchestrator-github-intake.yml` is a read-only contract-test workflow; it has `contents: read` permission and runs syntax and Node test commands. It does not invoke the Worker Ledger or create a Task.
- `cloud-engineering-connector/orchestrator-github-intake.js:176-177` explicitly returns `sideEffects: false` and `taskExecution: false`.
- Among the repository's 18 workflow files, the only `schedule:` trigger found is `.github/workflows/secret-history-scan.yml:8-9`, a weekly Gitleaks scan. No scheduled GitHub Actions task-creation workflow was found.

### 2.5 MCP and webhook ingress

- `cloud-engineering-connector/worker.js:21-39` declares the finite MCP `TOOLS` catalog. It contains repository inspection, architecture, Brain Store/Vault, and draft-PR operations; it contains no Orchestrator Task creation, Scheduler, or generic Durable Object RPC tool.
- `cloud-engineering-connector/worker.js:828-846` dispatches only the explicit tool-name switch. Unknown names throw `Unknown tool`; callers cannot choose an arbitrary Durable Object method.
- `cloud-engineering-connector/worker.js:1128` resolves a requested MCP tool through `TOOLS.find` before calling the fixed dispatcher. Public unauthenticated access is separately constrained by `PUBLIC_READ_ONLY_TOOLS`.
- The GitHub webhook path (`worker.js:1027-1073`) uses the Ledger's `claimGitHubDelivery` method as a delivery replay store. It does not invoke `createTask`. The validated intake result is explicitly marked `sideEffects: false` and `taskExecution: false` (`orchestrator-github-intake.js:176-177`).

This further falsifies the hypothesis that the current MCP or GitHub webhook ingress is a hidden generic Scheduler-to-Ledger bridge.

### 2.6 Whole-source static call-site scan

The audit enumerated the complete recursive Git tree for the audited commit. It contained 20 non-test JavaScript modules under `cloud-engineering-connector/`. Those modules were fetched and checked for the Scheduler signer, direct `createTask` invocation, `.createTask` RPC invocation, Scheduler principal, and `claimTask` call-sites.

In the deployed Worker source specifically (`worker.js`):
- `createTask(`: 0 occurrences;
- `.createTask`: 0 occurrences;
- `orchestrator-scheduler`: 0 occurrences;
- `claimTask(`: 0 occurrences;
- `createScheduledWorkerAssertion`: one import and three call-sites, all mapped to the Outbox publisher, Outbox consumer, and DLQ archiver described above.

This is a source-level, bounded negative result. It does not cover code, Workers, bindings, or services that are not present in this repository snapshot.

## 3. Existing design documents agree with the source

- `docs/specs/2026-11-23-orchestrator-executor-ab-design.md:22-27` records the fixed Scheduler assertion, the Outbox-only scheduled/Queue handlers, and the absence of a task-claim call in the runtime entry points.
- The same document describes a dedicated Scheduler Queue consumer as a proposed future Slice 3 (`lines 160-164`). It states that retry/DLQ policy, cursor checkpointing, and execution-time budget remain to be selected (`line 138`).
- `docs/specs/2026-11-23-orchestrator-release-validation-lifecycle-audit.md:65` records that no runtime call path performs release validation and scheduling. Its conclusion at line 169 requires explicit approval of Validator trust, validation policy, non-pass mapping, and exact Scheduler transition authority before implementation.

These documents are design/evidence records, not runtime proof by themselves. Their statements were independently cross-checked against the source paths above.

## 4. Hypotheses and attempted refutation

| Hypothesis | Evidence-based result | Label |
|---|---|---|
| H1: The five-minute Cron is the Scheduler. | The deployed handler calls only Knowledge and Orchestrator Outbox processing. No Task creation or claim call is present. | **Rejected** |
| H2: The existing Outbox Queue is the job-intake Queue. | Its consumer records receipts for already-persisted Outbox events; the configured Queue topology is Outbox plus DLQ only. The design explicitly says not to repurpose it. | **Rejected** |
| H3: GitHub intake workflow creates Tasks. | The workflow runs read-only contract tests; the intake validator declares no side effects and no task execution. | **Rejected** |
| H4: The fixed Scheduler signer policy proves the Scheduler is live. | A permitted signing policy exists, but there is no Scheduler signer call-site or Ledger `createTask` call in the audited runtime modules. | **Rejected** |
| H5: A Scheduler caller exists outside this repository or in an uninspected deployed Worker/binding. | This repository audit cannot inspect external Workers or live account bindings. | **Unknown** |
| H6: PR #383's changed-payload retry is a currently reachable Production exploit. | The Ledger characterization is real, but no in-repository runtime caller or external route to that operation was established. | **Unknown / not demonstrated** |

## 5. Interpretation of the JTI rollback experiment

PR #383 remains a valid Ledger characterization:

1. A real SQLite INSERT failure rolls back Task, Claim Candidate, and consumed JTI writes.
2. Reusing the still-valid assertion with a different Task is accepted when the insert failure has been removed.
3. PR #385's deliberate mutation, which committed JTI consumption outside the Task transaction, was killed by the new test.

However, `createScheduledWorkerAssertion` itself generates a fresh random JTI on each invocation. The repository contains no current Scheduler invocation from which to infer whether an operational retry would reuse one signed token or mint a new one. The prior characterization must not be promoted into a claim of external reachability, Production exploitability, or signing-key compromise.

## 6. Security decision and safe next boundary

**Current classification:** the Scheduler runtime is **not implemented in the audited Worker path**; operational invocation and external reachability remain **Unknown**.

Do not:
- broaden the signer allowlist;
- let MCP/webhook/Queue payloads select the Scheduler principal or operation;
- repurpose the existing Outbox/DLQ Queue for job intake or execution;
- expose a generic Durable Object RPC proxy;
- promote `VALIDATING` or create execution leases without the separately authorized Validator/Scheduler lifecycle.

Before implementing a Scheduler consumer, its owner-approved contract must define at least:
- a dedicated intake channel and a bounded, versioned, authenticated envelope;
- deterministic request identity and payload binding (including retry behavior);
- durable idempotency and concurrency semantics;
- exact Scheduler authority and assertion/JTI lifecycle;
- a separate execution wake-up path;
- failure, retry, DLQ, and reconciliation policy.

The existing design document already treats these as open design decisions. This audit does not authorize implementing them.

## 7. Falsification conditions

This conclusion must be revisited if any of the following evidence is produced:

1. A runtime source file or deployed Worker outside this snapshot that calls `createScheduledWorkerAssertion` for `orchestrator-scheduler/system/createTask`.
2. A real caller that invokes the Ledger `createTask` RPC, with provenance showing how the assertion is minted and supplied.
3. Cloudflare binding/Service configuration demonstrating an externally reachable path not represented in the repository.
4. Correlated, non-secret runtime evidence that a single Scheduler assertion JTI is reused across different Task payloads after a database abort.

Until then, the operational exploit hypothesis remains **Unknown**, and the correct posture is fail-closed.

## 8. Safety and non-actions

- This evidence change does not modify Worker code, Ledger code, tests, schemas, routes, Queues, secrets, Cloudflare configuration, `main`, or Production.
- No merge, deploy, live smoke test, Cloudflare API mutation, or secret read was performed.
- The source snapshot is the commit recorded above; no claim is made about uninspected external deployments.
