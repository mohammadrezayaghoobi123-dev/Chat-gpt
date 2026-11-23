# Orchestrator Release-Validation Lifecycle: Adversarial Audit

**Status:** Confirmed architecture gap; execution remains fail-closed  
**Audited baseline:** PR #297 head `16ed5de37711510bee5e3e23a8bc864383beebbe`  
**Scope:** Existing Owner release, Ledger transition, worker identity, Executor assertion, Queue receipt, and task-claim contracts  
**Change boundary:** This audit and its regression test do not authorize a new principal, new state transition, claimable state, Queue, MCP tool, deployment, or production operation.

## 1. Finding

An Owner release currently moves a quarantined task to `VALIDATING`, advances the task version, revokes the previous execution lease, and emits an Outbox transition event. The repository does not contain a complete authenticated path that validates the released task, advances that same task through `READY` to `SCHEDULED`, and then allows the fixed Executor to obtain a new lease.

This is a **liveness gap with a deliberately fail-closed safety posture**. It is not evidence that the task was validated, that the task should be claimable, or that a replacement lease can safely be created.

The current safe result is therefore:

- The released task remains in `VALIDATING`.
- The revoked Worker cannot regain authority with its old lease generation.
- The current scheduler cannot act as a Validator or use its task-creation assertion as a transition assertion.
- The current Executor cannot validate or schedule a task; its assertion operations are restricted to lease lifecycle operations.
- `VALIDATING` remains non-claimable.

Do **not** solve this by adding `VALIDATING` to `CLAIMABLE_TASK_STATES`, broadening the scheduler signer, reusing an Outbox Queue as an execution Queue, or accepting caller-supplied validation evidence.

## 2. Repository facts and falsification

The following findings were checked against the audited baseline. They are source-level facts, not claims about a live Staging or Production deployment.

| Hypothesis | Evidence examined | Result |
|---|---|---|
| Owner release itself completes validation | `orchestrator-ledger.js`: Owner `release` maps the task to `VALIDATING`; the transaction clears the execution lease and increments its generation | **Rejected** |
| The release Outbox event is a validation command | Outbox publisher/consumer path records delivery/receipt and fences stale task versions; it does not perform the task's validation or promote it to `READY` | **Rejected** |
| The fixed scheduler can validate or promote the released task | `orchestrator-worker-identity.js`: `orchestrator-scheduler` is signed as `system/createTask`; no validation or transition operation is authorized | **Rejected** |
| The fixed Executor can perform validation | `orchestrator-executor-assertion.js`: fixed subject/role and exact operations are `claimTask`, `renewLease`, and `releaseLease`; `transitionTask` is excluded | **Rejected** |
| A previously leased Agent can advance the released task | `transitionTask` requires an authenticated Agent, matching worker identity, an unexpired Lease owned by that Agent, and the current lease generation; Owner release clears the owner and advances the generation | **Rejected** |
| The released task can be claimed directly | `claimTask` and its candidate-index SQL only admit `SCHEDULED`, `RUNNING`, and `VERIFYING`; `VALIDATING` is excluded | **Rejected** |
| The task-state graph is sufficient to authorize recovery | `orchestrator-core.js` permits the domain edge `VALIDATING → READY`, but the Ledger's `transitionTask` API still requires a live Agent Lease and Agent assertion | **Rejected** |

The distinction in the final row is important: a legal state-graph edge is not an authorization grant. A domain transition can be representable while the runtime has no trusted actor authorized to execute it.

### 2.1 Counter-hypotheses

**H1 — The Outbox consumer is the Validator.**  
Refutation: its contract records receipt against the source event and enforces task-version fencing. A receipt proves delivery processing, not validation of source state or artifacts.

**H2 — The scheduler can reuse its assertion for `VALIDATING → READY`.**  
Refutation: its assertion is bound to subject `orchestrator-scheduler`, role `system`, operation `createTask`. The Ledger transition boundary requires role `agent` and operation `transitionTask`; the assertion is not interchangeable.

**H3 — The Executor should simply claim `VALIDATING`.**  
Refutation: this would permit execution before an independently authenticated validation decision. It would collapse validation and execution authority into the same principal and would turn a safety gate into a scheduler hint.

**H4 — A new task can be created to replace the released one.**  
Refutation: creating a second task does not validate or resume the original task. It would split the audit history, complicate idempotency, and could bypass the original Owner resolution lineage. A replacement task requires an explicit, separately reviewed product contract.

## 3. Authority matrix

| Principal / component | Current authorized boundary | Must not be inferred |
|---|---|---|
| Owner command verifier | Audited cancel, quarantine, and release commands | Technical validation, execution, lease creation |
| `orchestrator-scheduler` | Fixed `system/createTask` assertion | Validation, arbitrary task transition, Executor claim |
| `orchestrator-executor` | Ed25519 `agent` assertion for claim/renew/release lease operations | Validation, scheduling, task completion |
| Ordinary Agent | Agent-scoped operations, with active Lease and matching generation for task transition | Authority after Owner revocation |
| Outbox publisher/consumer | Publish event and persist a verified receipt | Task validation, scheduling, or execution |
| MCP caller / GitHub webhook payload | Bounded request or authenticated Owner-command input | Worker identity, assertion claims, lease generation, validation verdict |

No `orchestrator-validator` principal or equivalent trusted validation signer is authorized by the current scheduled signer policy. No runtime call path was identified that performs release validation and scheduling.

## 4. Required target contract — proposal, not authorization

A future implementation should preserve the separation between **validation**, **scheduling**, and **execution**. The following is a proposed contract for review; it is not implemented or approved by this audit.

### 4.1 Validation authority

Introduce a dedicated, fixed Validator identity only after its owner, deployment boundary, key custody, and independent trust source are explicitly selected.

Candidate contract:

- Principal: `orchestrator-validator`.
- Role: `validator`.
- Operation: one exact operation such as `validateReleasedTask`.
- Assertion: short-lived, one-time, task/version-bound, and verified by the Ledger using public-key-only verification.
- Key custody: separate from the Executor private key and from MCP/Owner credentials.
- Capability: submit a bounded validation result for a released task; no claim, renew, release, schedule, repository write, or arbitrary command capability.

The principal name is illustrative. No authority is granted by writing it into this document.

### 4.2 Evidence envelope

The validation result must be durable, canonical, bounded, and cryptographically bound to the exact released task version. At minimum, the schema should contain:

| Field | Required meaning |
|---|---|
| `taskId` | Exact immutable task identity |
| `expectedTaskVersion` | Version observed after Owner release; used for compare-and-swap |
| `ownerReleaseReceiptId` | Durable Owner release receipt / resolution lineage |
| `taskInputDigest` | Digest of the exact task input and relevant source revision |
| `validationPolicyId` | Immutable identifier/version of the validation rules |
| `validationRunId` | Unique, idempotent validation execution identity |
| `checks[]` | Named checks with explicit `PASS`, `FAIL`, `UNKNOWN`, or `DISPUTED` outcomes and evidence digests |
| `overallOutcome` | Explicit aggregate verdict; never inferred from Queue acknowledgement or timeout |
| `validatorPrincipal` | Fixed verified Validator identity |
| `evidenceDigest` | Digest over canonical evidence content |
| `issuedAt` | Trusted issuance time; Ledger time remains authoritative for mutation |
| `assertionJti` | One-time assertion identifier consumed atomically with accepted evidence |

Evidence references must be immutable and retrievable. Missing, mutable, contradictory, stale, oversized, caller-forged, or unverifiable evidence cannot produce `READY`.

A caller-supplied boolean such as `validated: true`, a Queue message, a CI green badge without immutable run/commit references, or an Owner release comment is not validation evidence.

### 4.3 Atomic transition and scheduling sequence

The preferred sequence is:

1. **Owner release:** preserve the existing `QUARANTINED → VALIDATING` transition, task-version increment, audit receipt, Outbox event, and lease revocation.
2. **Validator decision:** a dedicated Ledger operation verifies the Validator assertion, task ID, expected version, release receipt, input digest, evidence digest, policy version, and one-time JTI.
3. **Atomic validation commit:** in one Durable Object transaction, persist the immutable validation record, consume the accepted JTI, compare-and-swap the task version/state, append the audit event, and enqueue the transition event. Only a fully verified `PASS` can advance `VALIDATING → READY`.
4. **Non-pass outcomes:** `FAIL`, `UNKNOWN`, and `DISPUTED` must never produce `READY`, `SCHEDULED`, or a claimable lease. Their precise task-state mapping and human escalation semantics require an explicit decision before implementation.
5. **Scheduler:** only after a durable passing validation record exists may the fixed Scheduler promote `READY → SCHEDULED`, with its own exact operation-scoped assertion, idempotency, task-version CAS, fixed Executor assignment, audit, and Outbox event.
6. **Executor claim:** only the fixed Executor may claim the `SCHEDULED` task. The Ledger must create a new monotonically increasing Lease generation; the revoked Worker generation must remain invalid.
7. **Execution and verification:** all subsequent state-changing operations remain fenced by the current Lease generation. Completion still requires the repository's independent acceptance/reviewer contract.

The Validator must not create a Lease. The Scheduler must not run the task. The Executor must not validate its own release.

### 4.4 Required race semantics

| Race / adversarial input | Required result |
|---|---|
| Validator evidence uses a stale task version | Reject with a conflict reason; no task mutation |
| Owner quarantine/cancel races validation commit | Durable transaction ordering decides; if Owner revocation wins, validation cannot promote the quarantined/cancelled version |
| Duplicate identical validation delivery | Return the original durable validation result; do not append a second transition |
| Same validation ID with a different evidence digest | Reject as an idempotency conflict |
| Replayed Validator JTI | Reject; do not perform a second transition |
| Evidence claims PASS but one required check is missing/unknown | Reject promotion to `READY` |
| Evidence points to another task, branch, commit, or release receipt | Reject as a binding mismatch |
| Old Worker uses fresh operation assertion but stale Lease generation | Reject by Lease fencing; do not consume the JTI for a state mutation |
| Queue delivery is duplicated, delayed, reordered, or acknowledged | Never treat delivery state as validation or task-state authority |
| Validator, scheduler, key set, or evidence store is unavailable | Remain non-executable; classify unresolved outcome as `UNKNOWN` |

## 5. Mandatory hostile tests before implementation is accepted

The implementation slice must include real Durable Object / SQLite integration tests for:

1. Owner release followed by absent, failed, unknown, and disputed validation outcomes.
2. A valid signed Validator PASS bound to the exact task version and owner release receipt.
3. Validator assertion replay, wrong subject/role/operation, expiry, key mismatch, and cross-task use.
4. Evidence digest mismatch, missing mandatory check, changed source commit, and changed validation policy.
5. Duplicate delivery with identical content and idempotency-key rebinding with changed content.
6. Concurrent Owner quarantine/cancel and Validator commit, proving the linearization point.
7. Scheduler refusal before passing validation and acceptance only after an immutable PASS record exists.
8. Executor claim after scheduling, with a lease generation strictly greater than the revoked generation.
9. Stale Worker renew/release/transition attempts after the new claim.
10. Mutation checks that remove task-version CAS, JTI consumption, Lease fencing, or validation-evidence binding; each realistic mutation must make a focused test fail.

No test may mock the Ledger transaction, Durable Object storage, assertion verifier, or critical state transition under test.

## 6. Explicit non-goals and release gates

This audit does not:

- Add `VALIDATING` to the claimable-state set.
- Add or authorize `orchestrator-validator`.
- Widen the existing scheduler or Executor signer allowlists.
- Add an MCP validation, claim, lease, cursor, or evidence-minting surface.
- Reuse the Outbox Queue as an execution Queue.
- Create a new task to hide the blocked original task.
- Change Worker bindings, Wrangler configuration, Cloudflare resources, or secrets.
- Run a live Staging/Production operation.
- Merge any pull request or modify `main`.

Before implementation, the owner must approve the Validator trust source/key custodian, validation policy and required checks, non-pass state mapping, and the Scheduler's exact transition authority. Until those decisions are explicit and independently tested, a released task remaining in `VALIDATING` is the correct fail-closed outcome.

## 7. Audit conclusion

**Finding:** provisionally supported by direct source inspection and an executable regression test on the dependent branch.  
**Safety posture:** fail-closed.  
**Liveness:** unresolved / blocked.  
**Production readiness:** not assessed; no live environment test was performed.  
**Next engineering slice:** specify and approve the Validator identity and evidence contract, then implement one atomic validation-record + `VALIDATING → READY` Ledger transaction before touching scheduling or Executor runtime wiring.
