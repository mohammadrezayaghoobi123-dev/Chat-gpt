# Trusted Reconciliation Authority — Design Specification (v1)

- **Status:** Proposed design; not an implementation authorization
- **Date:** 2026-11-26
- **Decision:** Hybrid A+B+C, with strict separation of authority
- **Parent checkpoint:** PR #480, commit `4ff372d7c51b1e334ec93011dc0f11134a506022`
- **Scope:** Expired-lease reconciliation in Cloud Engineering Connector
- **Production impact:** None. This document does not authorize production code, schema, secret, Cloudflare, deployment, or merge changes.

## 1. Executive decision

Adopt a controlled hybrid of all three candidate architectures:

1. **A — Independent Trusted Reconciliation Authority (TRA):** evaluates evidence and issues a narrowly scoped, signed reconciliation authorization.
2. **C — Reconciliation Coordinator:** orchestrates evidence collection, bounded retries, timeout handling, and idempotent request tracking. It has no authority to mutate leases.
3. **B — Ledger-side authorization and atomic commit:** independently validates the TRA authorization and current lease state, then performs one atomic, fenced state transition. The Ledger remains the sole authority capable of changing lease ownership or generation.

This is not a three-way distribution of write authority. It is a three-part separation of evidence, orchestration, and state mutation. **Only the Ledger commits lease state.**

## 2. Evidence baseline and current-state boundary

The parent checkpoint source was inspected at the exact PR #480 head listed above.

Observed facts:

- `orchestrator-ledger.js` validates the worker assertion before entering the claim transaction.
- The current `claimTask` path explicitly ignores caller-supplied `reconciliationEvidence` as authorization and returns `RECONCILIATION_REQUIRED` for an expired lease whose owner is non-null.
- The current code comment states that no trusted reconciliation issuer or claimTask runtime caller exists in this repository path.
- The existing expired-lease characterization test verifies that caller-shaped evidence does not bypass the fence.
- The executor assertion implementation currently scopes its claims and allowed operations to the existing executor principal/role and the operations `claimTask`, `renewLease`, and `releaseLease`. This is not evidence that a TRA principal or reconciliation operation already exists.
- Lease mutation and assertion-consumption logic are performed within the Ledger's SQLite transaction boundary in the inspected claim path.

Not established by this inspection:

- That an independent source can reliably prove a worker is dead or permanently unable to act.
- That all external side effects are fenced by the current lease generation.
- That a production-ready key rotation, revocation, or compromise-recovery process exists for a future TRA.
- That the proposed protocol has been implemented or tested.

Current classification: fail-closed rejection of the tested caller-controlled evidence path is **provisionally supported**. A positive recovery path is **not implemented / unknown**.

## 3. Goals and non-goals

### Goals

- Preserve fail-closed behavior until the complete trusted path exists.
- Prevent an Agent, Worker, Coordinator, or caller-supplied JSON object from self-authorizing lease recovery.
- Bind every authorization to one task, one previous owner, one previous generation, one operation, and a bounded validity window.
- Make replay resistance and lease reassignment atomic at the Ledger.
- Preserve stale-worker fencing after recovery.
- Make coordinator retries safe and observable without granting coordinator write authority.
- Distinguish safety from liveness and report unresolved evidence as unknown.

### Non-goals

- Proving physical process death from lease expiry alone.
- Treating a network timeout, missing heartbeat, or unreachable host as conclusive proof of termination.
- Allowing the TRA or Coordinator to update lease rows directly.
- Performing external side effects inside the lease-state transaction.
- Enabling automatic production recovery in this design-only phase.
- Resolving unrelated historical secret-scan findings or changing existing Cloudflare configuration.

## 4. Authority and trust-boundary matrix

| Principal/component | May observe evidence | May issue TRA authorization | May coordinate retries | May consume authorization / mutate lease |
|---|---:|---:|---:|---:|
| Agent / execution Worker | Limited operational observations | No | No | No |
| Reconciliation Coordinator | Yes, subject to source policy | No | Yes | No |
| Trusted Reconciliation Authority | Yes, independently evaluated inputs | Yes | No | No |
| Orchestrator Ledger | Current authoritative state | No | No | **Yes — sole writer** |
| External observer / evidence source | Source-specific facts only | No | No | No |

The Ledger must not trust a Coordinator assertion that evidence was checked. It must verify a TRA-signed authorization against a configured trust policy and current state.

The TRA must not trust a Worker-supplied claim that the Worker is dead. Evidence collection must be independent of the subject whose lease is being reclaimed.

## 5. Proposed protocol

### 5.1 Evidence evaluation

The Coordinator creates a reconciliation request with a stable idempotency key. It gathers evidence from independently governed sources and submits a bounded evidence package to the TRA.

The TRA evaluates:
- provenance and source identity;
- freshness and expiry;
- independence/correlation between sources;
- contradiction and counter-evidence;
- whether the evidence supports the narrow claim being made;
- whether the evidence is sufficient under a separately approved policy.

A timeout, unavailable source, contradictory evidence, or missing evidence must not be silently converted into a positive result. Such outcomes remain `UNKNOWN`, `DISPUTED`, or `BLOCKED` according to the policy.

### 5.2 Signed authorization envelope

The following is a conceptual claim set, not a finalized wire format:

```json
{
  "v": 1,
  "iss": "trusted-reconciliation-authority",
  "aud": "orchestrator-ledger",
  "sub": "trusted-reconciliation-authority",
  "role": "reconciliation-authority",
  "op": "reconcileExpiredLease",
  "taskId": "<task-id>",
  "previousWorkerId": "<worker-id>",
  "previousGeneration": 1,
  "evidenceDigest": "<canonical-evidence-digest>",
  "evidenceRef": "<immutable-evidence-reference>",
  "policyVersion": "<approved-policy-version>",
  "iat": 0,
  "exp": 0,
  "jti": "<unique-one-time-identifier>",
  "requestId": "<stable-reconciliation-request-id>"
}
```

Required properties:

- Sign a canonical serialization with a versioned algorithm and explicit key identifier.
- Reject unknown or duplicate fields and non-canonical encodings.
- Enforce strict size, type, identifier, and timestamp bounds.
- Bind `taskId`, `previousWorkerId`, `previousGeneration`, `op`, `aud`, and policy version into the signature.
- Use short-lived authorizations; exact lifetime and clock-skew limits require a documented threat-based decision.
- Maintain a key set with explicit activation, retirement, and revocation semantics.
- Never place private signing material in source code, test fixtures intended for production, logs, or caller-controlled payloads.
- Treat `evidenceRef` as a locator, not proof. The digest and provenance must be verifiable under a defined retention policy.

### 5.3 Ledger-side commit

The Ledger must, within one synchronous transaction or equivalent atomic storage primitive:

1. Read the current task and lease rows.
2. Verify task eligibility and assignment constraints.
3. Verify the TRA signature, key status, issuer, audience, operation, policy version, and validity interval using trusted Ledger time.
4. Require the current lease owner and generation to equal the authorization's previous owner and generation.
5. Require the lease to be expired according to Ledger time.
6. Check that the authorization JTI has not already been consumed.
7. Check that the request/idempotency record is either new or a valid retry of the same request and same intended result.
8. Consume the JTI and record the reconciliation decision.
9. Advance the generation exactly once and assign the new owner/lease deadline using a conditional update that asserts the old generation.
10. Persist an auditable outcome in the same transaction.

Any failed precondition must leave the lease row and JTI-consumption state unchanged, except for explicitly designed, separately atomic audit of rejected attempts. The exact rejected-attempt audit policy must be decided before implementation.

The transaction must not call remote services, fetch evidence, or perform external side effects.

## 6. State machine

Proposed states:

- `LEASE_ACTIVE`
- `LEASE_EXPIRED`
- `RECONCILIATION_PENDING`
- `EVIDENCE_VERIFIED`
- `LEDGER_COMMIT_PENDING`
- `LEASE_REASSIGNED`

Terminal or blocking outcomes:

- `RECONCILIATION_UNKNOWN`
- `EVIDENCE_REJECTED`
- `RECONCILIATION_DISPUTED`
- `RECONCILIATION_CONFLICT`
- `RECOVERY_BLOCKED`

Important distinction: `EVIDENCE_VERIFIED` is not a lease grant. Only a successful Ledger commit can produce `LEASE_REASSIGNED`.

The Coordinator may move its own workflow record between orchestration states. It cannot mutate authoritative lease state. The Ledger derives the authoritative transition from current persisted state and a verified authorization.

## 7. Safety and liveness invariants

### Safety invariants

- **S1 — Single writer:** only the Ledger mutates lease ownership and generation.
- **S2 — No self-authorization:** Agent and Coordinator inputs cannot create a TRA authorization.
- **S3 — Exact binding:** authorization is bound to task, previous owner, previous generation, audience, operation, and policy version.
- **S4 — Replay resistance:** one JTI can authorize at most one committed transition.
- **S5 — Monotonic fencing:** generation strictly increases on successful reassignment and never decreases.
- **S6 — Stale-worker rejection:** every protected operation checks the current generation, not merely worker identity.
- **S7 — Trusted time:** lease expiry and authorization validity are evaluated using Ledger-controlled time.
- **S8 — Atomic commit:** JTI consumption, reconciliation record, and lease generation/owner update commit or roll back together.
- **S9 — Fail closed:** missing, stale, contradictory, unavailable, or unverifiable evidence never grants a lease.
- **S10 — Auditability:** each accepted or rejected decision has a traceable request, policy version, evidence digest, and reason code without leaking secrets.

### Liveness invariants

- **L1 — Bounded retries:** Coordinator retries are bounded and use backoff.
- **L2 — Idempotent recovery:** repeating the same request cannot create a second generation increment.
- **L3 — Explicit uncertainty:** unavailable evidence or an ambiguous commit is reported as unknown until reconciled against Ledger state.
- **L4 — Operational escape hatch:** a separately authenticated and audited administrative procedure must be designed for irrecoverable TRA/key failures; it must not bypass fencing or silently reset generation.

Safety and liveness are separate acceptance dimensions. A system that never grants a lease may satisfy some safety properties while failing liveness. Neither should be represented as proving the other.

## 8. Threat model and hostile cases

| Threat/failure | Required defense | Falsification test |
|---|---|---|
| Forged or modified authorization | Signature and strict claims validation | Alter each signed claim and expect rejection |
| Caller-shaped evidence | No authorization semantics for raw caller JSON | Supply arbitrary `reconciliationEvidence` and expect rejection |
| Cross-task substitution | Task binding | Replay valid token against another task |
| Cross-generation replay | Previous-generation binding | Change current generation before commit |
| Previous-owner substitution | Owner binding | Change current lease owner |
| JTI replay | Atomic one-time consumption | Submit same authorization concurrently twice |
| Concurrent recovery | Conditional update/CAS and transaction | Race two different authorizations for same old generation |
| Stale worker resumes | Fencing on every protected mutation | Old generation attempts renew/release/transition after reassignment |
| Clock manipulation | Ledger-controlled time | Vary caller-provided `now` |
| TRA unavailable | Fail closed, bounded retry, UNKNOWN | Timeout during evidence evaluation |
| Key rotation/revocation | Versioned key policy | Retired/revoked key attempts authorization |
| Crash before commit | Transaction rollback | Inject crash before transaction commit |
| Crash after commit but before response | Idempotent lookup of committed result | Retry same request after simulated lost response |
| False evidence from correlated sources | Independence and contradiction checks | Supply duplicate/correlated evidence as if independent |
| Compromised Coordinator | Coordinator has no signing or Ledger write authority | Attempt direct lease mutation and fake status claims |
| Compromised TRA | Narrow scope, short lifetime, key revocation, audit | Attempt cross-task, cross-operation, or over-broad authorization |

## 9. Acceptance test plan

The following IDs are requirements, not completed tests:

- **RTA-01:** malformed, forged, altered, or non-canonical authorization is rejected.
- **RTA-02:** task, owner, and generation mismatch is rejected without mutation.
- **RTA-03:** expired or not-yet-valid authorization is rejected using Ledger time.
- **RTA-04:** duplicate JTI cannot commit twice, including concurrent submissions.
- **RTA-05:** two concurrent recovery requests for one generation yield at most one successful commit.
- **RTA-06:** old generation cannot renew, release, transition, or perform any protected action after reassignment.
- **RTA-07:** injected crashes before commit leave no partial mutation or consumed authorization.
- **RTA-08:** a lost response after successful commit is safely resolved by idempotent request lookup.
- **RTA-09:** timeout, unavailable evidence, or contradictory evidence never becomes positive authorization.
- **RTA-10:** key retirement/revocation prevents new use according to the approved policy.
- **RTA-11:** external side effects are not duplicated by recovery retries.
- **RTA-12:** audit records are complete, tamper-evident under the declared trust model, and contain no secret material.

Each test must record setup, injected fault, expected state, observed state, evidence artifact, and verdict. Unrun tests remain `NOT_RUN`; inconclusive tests remain `INCONCLUSIVE`. Neither counts as pass or fail.

## 10. Observability and audit record

For each request, record at minimum:

- request ID and idempotency key (or a safe digest);
- task ID;
- old and new generation, if committed;
- previous and new owner identifiers;
- TRA key ID and policy version;
- evidence digest and immutable reference;
- decision code and reason;
- timestamps from the authoritative Ledger clock;
- transaction outcome and retry correlation.

Do not log bearer assertions, private keys, raw evidence containing secrets, or full authorization tokens. Define retention, access controls, and tamper-evidence separately.

## 11. Rollout and rollback gates

No production rollout is authorized by this specification.

Before any implementation can be considered:

1. Map every lease-protected mutation and every external side-effect boundary.
2. Define the authoritative evidence sources and what each can actually prove.
3. Approve the TRA principal, key custody, rotation, revocation, and emergency response model.
4. Finalize canonical token schema and policy versioning.
5. Define rejected-attempt JTI semantics and audit transaction boundaries.
6. Prove the Ledger transaction and idempotency behavior under crash and concurrency.
7. Implement RTA tests before production logic changes.
8. Run the full repository CI and hostile review.
9. Keep the change behind a disabled-by-default feature gate until separately approved.
10. Require explicit approval for staging, production, and merge as separate actions.

Rollback must disable new reconciliation issuance/consumption without decrementing generations, restoring stale leases, or weakening existing fencing. Existing active leases must continue under the pre-existing rules. Any emergency path must preserve monotonic generation and produce an auditable decision.

## 12. Open decisions — blockers, not assumptions

- **OD-01:** Which independent evidence sources are authoritative, and what claims can each prove?
- **OD-02:** What evidence threshold is required, including independence and counter-evidence policy?
- **OD-03:** Where does the TRA execute, and what identity/key custody boundary protects it?
- **OD-04:** What are key rotation, revocation, compromise, and emergency recovery procedures?
- **OD-05:** What exact token lifetime, clock-skew, and revocation-cache policy is acceptable?
- **OD-06:** Should rejected authorization JTIs be consumed, separately recorded, or remain reusable? Current behavior must not be generalized without an explicit threat analysis.
- **OD-07:** What is the exact idempotency record schema and retention period?
- **OD-08:** Which external side effects require their own idempotency keys or fencing tokens?
- **OD-09:** What administrative recovery procedure exists if the TRA is unavailable or compromised?
- **OD-10:** What independent review is required before enabling the feature?

These decisions remain open. The design must not silently fill them with implementation defaults.

## 13. Hostile review of this specification

### Findings and limitations

1. **Evidence truth is not guaranteed by a signature.** A valid signature proves that the configured TRA key signed the claims; it does not prove the underlying worker is dead. The evidence policy and source independence remain open blockers.
2. **A lease timeout is not proof of process termination.** A partitioned worker may resume. Correctness therefore depends on fencing at every protected resource, including external systems.
3. **The Ledger cannot make arbitrary external effects atomic.** Database transaction atomicity does not provide exactly-once semantics for remote calls. External effects need idempotency/fencing and reconciliation of their own.
4. **The Coordinator can be compromised.** The architecture limits its authority, but only if the TRA does not accept Coordinator assertions as sole evidence and the Ledger rejects Coordinator-signed tokens.
5. **TRA compromise remains high impact.** Narrow claim scope and short validity reduce blast radius but do not eliminate it. Key custody, revocation propagation, and emergency shutdown are unresolved.
6. **JTI semantics are not yet fully specified.** Consuming only successful commits is simple for atomicity but permits repeated rejected-token attempts; consuming rejected JTIs can itself create denial-of-service or transaction-design issues. A policy decision is required.
7. **Idempotency after lost responses needs durable request lookup.** A retry cannot infer failure merely because the caller did not receive a response.
8. **The proposed state machine spans multiple systems.** Coordinator workflow state and Ledger lease state must remain separate; no distributed transaction is assumed.
9. **No liveness proof exists.** A strict fail-closed policy can leave a task blocked indefinitely. The administrative path and bounded operational recovery remain unresolved.
10. **No implementation evidence exists.** This document is a design artifact; RTA-01 through RTA-12 are planned tests, not passing tests.

### Hostile verdict

**PROVISIONALLY ACCEPTED AS A DESIGN BASELINE ONLY**, subject to OD-01 through OD-10 and independent review.

- Production implementation: **NOT AUTHORIZED**
- Positive lease recovery: **NOT IMPLEMENTED / UNKNOWN**
- Safety of every external side effect: **UNKNOWN**
- Liveness under TRA failure: **UNKNOWN**
- Merge/deployment/staging: **NOT AUTHORIZED**

## 14. Change control

This document is intentionally isolated in a documentation-only branch based on the PR #480 checkpoint. It does not change runtime code, schemas, tests, secrets, Worker configuration, or deployment settings. Any implementation must be proposed separately, with tests, evidence, hostile review, and explicit authorization.
