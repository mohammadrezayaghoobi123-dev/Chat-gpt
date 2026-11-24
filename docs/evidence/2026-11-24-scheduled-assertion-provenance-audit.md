# Scheduled Assertion Provenance and Admission Authority Audit

- Audit date: 2026-11-24
- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Base branch: `main`
- Base commit: `919b19ca3d3887352cdef06b03c668ead04fbce7`
- Scope: source-level provenance and authority review; no runtime or production mutation
- Classification: evidence review; no vulnerability verdict

## Executive finding

The current source defines a fixed signer grant for `orchestrator-scheduler / system / createTask`, but the minting helper does not itself establish that its caller is executing inside a genuine Cloudflare scheduled-event invocation.

`createScheduledWorkerAssertion(keySet, activeKid, expected)` accepts caller-supplied `subject`, `role`, `operation`, and `nowMs`. It checks those values against a static allowlist, loads an HMAC key from the supplied key set, and signs a short-lived assertion. It accepts no `ScheduledController`, event, execution context, invocation nonce, trusted runtime marker, or independently verified provenance object.

The helper therefore enforces **principal/operation allowlisting**, not **runtime-origin authentication**. Its comment describes an intended invocation boundary, but the function signature and implementation do not prove that boundary.

This is a latent authority-design gap, not evidence of a remotely exploitable production vulnerability. No production call site was found in the bounded source review, and the connected Production Worker previously inspected does not have the Ledger binding. External callers and other accounts remain unknown.

## Exact source evidence

### 1. Signer policy and minting helper

File: `cloud-engineering-connector/orchestrator-worker-identity.js`

Observed at current `main`:
- Blob SHA: `b2ef5f2f4063b63e82d10f6abe428a5b1dd1acdc`
- `SCHEDULED_SIGNER_POLICY` grants `orchestrator-scheduler` the `system` role for `createTask`.
- `createScheduledWorkerAssertion` checks the supplied subject/role/operation against that policy.
- It signs claims containing issuer, audience, subject, role, operation, issued-at, expiry, and JTI.
- The signed claim set contains no tenant, project, task, request digest, policy decision ID, or scheduled-event provenance.
- The helper receives no event/context parameter and performs no runtime event verification.

The helper is not imported by the checked-in production modules inspected in this audit. The only confirmed imports in the inspected test set are described below.

### 2. Ledger admission boundary

File: `cloud-engineering-connector/orchestrator-ledger.js`

Observed at current `main`:
- Blob SHA: `ba32281b3698d40917505096d2a61501f8c0f9e4`
- `createTask` requires `workerId === "orchestrator-scheduler"`.
- It verifies an assertion for the fixed subject `orchestrator-scheduler`, role `system`, and operation `createTask`.
- The expected assertion context contains only subject, role, operation, and `nowMs`.
- Tenant and project are read from the supplied Task object and used for persistence/idempotency scoping.
- The admission method does not independently resolve active tenant membership or a project authorization decision.
- The assertion is not bound to the supplied tenant, project, task ID, canonical Task digest, or an authorization decision.

The ledger therefore authenticates possession of a valid system assertion for the operation, but the current assertion does not prove that the asserted system principal was authorized to admit this exact tenant/project/task request.

### 3. Runtime call-site census

The current-main production source review covered the Worker, Ledger, identity modules, protocol/core modules, exports, and supporting production modules. No production import/call site for `createScheduledWorkerAssertion` was identified in the fetched source set. The default Worker remains fetch-only and does not call `createTask`.

This is a bounded repository-source result. It does not exclude generated code, an external service, a different repository, or a different Cloudflare account.

### 4. Existing test usage

The following current-main Cloudflare test files import and call `createScheduledWorkerAssertion`:

- `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-idempotency-scope.test.js`: mints the Scheduler assertion inside the test and directly calls the Durable Object's `createTask` method.
- `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-receipt-scope.test.js`: mints an Outbox Consumer assertion to test receipt tenant/project fencing.
- `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-tenant-fencing.test.js`: mints an Outbox Publisher assertion to test lease fencing.

These tests establish that the helper can mint test assertions and that Ledger APIs enforce the tested persistence/fencing invariants. They do not establish that a real Cloudflare scheduled event is the exclusive source of a Scheduler assertion. No test in the inspected set attempts to mint a Scheduler assertion without a scheduled event or proves that such a call is rejected.

## Threat model and security boundary

### Assets
- Integrity of Task admission.
- Tenant/project isolation.
- Integrity of the system-level Scheduler identity.
- Auditability of who authorized a Task and why.

### Trust assumptions currently encoded
- A caller able to invoke the helper and access `LEDGER_WORKER_ASSERTION_KEYS` can request a permitted Scheduler assertion.
- The Ledger trusts a valid assertion for the fixed system principal and operation.
- Tenant/project scope is supplied by the Task payload rather than authenticated as part of the Scheduler assertion.

### What is not established
- Whether any deployed runtime currently has both the signing key and a reachable Ledger admission path.
- Whether a separate Scheduler exists outside the inspected repository/account.
- Whether the key is exposed to any untrusted or less-trusted runtime.
- Whether the project intends a platform-global Scheduler or a tenant-scoped Scheduler.
- Whether a trusted external control plane authorizes each Task before admission.

## Falsifiable hypotheses

| ID | Hypothesis | Current disposition | Distinguishing evidence |
|---|---|---|---|
| H1 | The helper cryptographically proves a genuine Cloudflare scheduled-event origin. | Rejected by source inspection | Function accepts no event/context and checks only caller-supplied fields plus key possession. |
| H2 | A production module in the inspected current-main source invokes the helper. | Not observed in bounded census | Complete import/call graph or deployed source/runtime trace. |
| H3 | Existing tests prove scheduled-event provenance. | Rejected for inspected tests | Tests mint assertions directly from test code; no event-origin negative test. |
| H4 | The current production runtime can reach Ledger admission with a Scheduler assertion. | Unknown / not demonstrated | Deployed binding, actual caller, signing-key placement, and invocation trace. |
| H5 | Task admission is bound to an authoritative tenant/project policy decision. | Not established by this path | A verified policy decision and canonical Task/request digest must be bound and rechecked at admission. |

## Required security properties before enabling this path

1. **Runtime provenance:** the signing operation must be reachable only from an explicitly trusted scheduler adapter. Do not treat a caller-supplied string or comment as proof of scheduled-event origin.
2. **Key isolation:** the HMAC signing capability must not be available to general Worker request handlers, MCP tools, webhook handlers, or user-controlled code paths.
3. **Request binding:** the assertion must bind tenant ID, project ID, task ID, canonical Task digest, operation, issuer, audience, expiry, and a unique JTI.
4. **Policy binding:** the admission request must carry a verifiable decision from the authoritative Tenant Directory/project policy boundary, including policy version and decision ID, or an explicitly documented platform-global authorization model.
5. **Independent verification:** the Ledger must recompute the canonical Task digest and validate every binding rather than trusting caller-supplied digest metadata.
6. **Replay atomicity:** assertion consumption, idempotency receipt, and Task insertion must be committed atomically, with concurrency and rollback tests.
7. **Negative tests:** prove rejection when event provenance is absent/forged, the signing capability is unavailable, tenant/project/task/digest changes, policy decision is missing/stale, and the assertion is replayed.
8. **Mutation tests:** remove each binding/verification step independently and require the corresponding test to fail.

## Safe disposition

- Do not enable or deploy the Scheduler admission path based on the current helper.
- Do not remove the grant solely because no current-main production caller was found; first establish whether the platform-global Scheduler is an intended product capability.
- Keep Production, `main`, bindings, secrets, and Cloudflare resources unchanged.
- The next implementation decision is an explicit authority contract: platform-global admission with a separately authenticated control plane, or tenant/project-scoped admission backed by Tenant Directory policy. These are materially different trust models and must not be blended implicitly.

## Verification limitations

- This is a source/evidence-only review.
- No application tests, mutation tests, local build, Wrangler dry-run, or production invocation were executed in this step.
- No secret values, key material, fingerprints, or runtime secret contents were retrieved.
- No merge or deployment was performed.
