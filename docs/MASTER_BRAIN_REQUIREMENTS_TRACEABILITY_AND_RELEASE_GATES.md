# Master Brain — Requirements Traceability and Delivery Gates
**Date:** 2026-10-11  
**Branch:** `master-brain/proof-protocol-v0`  
**Status:** Working traceability baseline; implementation and production verification are not implied.

> Purpose: connect product, scientific-integrity, safety, and cross-platform requirements to artifacts and explicit verification gates. Status labels describe the evidence currently recorded in this repository, not an assertion that the whole product is complete.

## 1. Status vocabulary

- **SPECIFIED** — documented as a requirement or intended design.
- **PARTIAL IMPLEMENTATION** — code exists for a bounded part of the requirement; important production properties may be absent.
- **TESTED (SCOPE-LIMITED)** — tests exist for the identified code path; this does not establish system-wide or production correctness.
- **NOT IMPLEMENTED** — no connected implementation has yet been established in this baseline.
- **NOT VERIFIED** — no sufficient test, deployment, or operational evidence has been recorded here.
- **BLOCKED BY DEPENDENCY** — should not be represented as delivered until an upstream contract or control exists.

Never promote a requirement to VERIFIED based only on documentation, model agreement, a successful commit, or the existence of a test file.

## 2. Requirement traceability matrix

| ID | Requirement | Current evidence / location | Current status | Verification gate / next action |
|---|---|---|---|---|
| SCI-001 | Important claims must be assessed with supporting and opposing evidence, limitations, and explicit uncertainty | `src/master_brain/evidence_protocol.py` | PARTIAL IMPLEMENTATION | Expand adversarial and boundary tests; review evidence eligibility and provenance end-to-end |
| SCI-002 | Evidence weights must not be presented as calibrated probabilities without calibration evidence | Evidence protocol documentation/code; experience design system | SPECIFIED + PARTIAL IMPLEMENTATION | Add API/UI contract prohibiting probability-style presentation of heuristic weights |
| SCI-003 | A counterexample must remain distinct from general counterevidence | `src/master_brain/falsification_engine.py`; `tests/test_falsification_engine.py` | TESTED (SCOPE-LIMITED) | Keep regression tests; verify serialization and UI preserve the distinction |
| SCI-004 | Unknown or unexecuted tests must not count as pass/fail or establish disconfirmation | Falsification engine and audit bridge; related tests | PARTIAL IMPLEMENTATION | Test every outcome mapping and ensure unknown blocks final completion |
| SCI-005 | Competing hypotheses, falsification criteria, and decision-change rationale must be recorded | `src/master_brain/falsification_audit.py` | PARTIAL IMPLEMENTATION | Verify persistence failure behavior and round-trip audit reconstruction |
| AUD-001 | Audit history must detect accidental or deliberate payload/link tampering within its threat model | `src/master_brain/audit_ledger.py`; `src/master_brain/audit_store.py` | PARTIAL IMPLEMENTATION | Test tampered history, duplicate IDs, broken links, append failure; document that hash chains alone do not prevent full-history rewrite |
| AUD-002 | Audit events must be durably persisted before a consequential action is reported as accepted | Audit store exists; execution gate is currently policy-only | BLOCKED BY DEPENDENCY | Make audit write failure fail closed; add persistence and recovery tests |
| SAFE-001 | High/critical-risk missions require approval before execution | `src/master_brain/mission_contract.py` and execution-gate implementation | PARTIAL IMPLEMENTATION | Bind authenticated approval to mission ID + canonical contract digest/version + expiry; reject stale/replayed/mismatched approvals |
| SAFE-002 | Client input alone must not authorize a consequential action | Current gate accepts an approval boolean and does not dispatch work | NOT PRODUCTION-READY | Implement server-side identity/authorization and audit-bound approval; test forged request, wrong mission, changed contract |
| MISSION-001 | Planner outputs must map to a canonical, versioned mission contract without silently replacing legacy planner behavior | `src/master_brain/mission_contract.py` | PARTIAL IMPLEMENTATION | Add contract compatibility tests and explicit schema migration/version policy |
| MISSION-002 | Planning must be distinguishable from dispatch, execution, completion, and independent verification | Mission contract and experience design system | SPECIFIED + PARTIAL IMPLEMENTATION | Define canonical persisted lifecycle and transition rules before UI wiring |
| MISSION-003 | Mission state must survive refresh, reconnect, and client switching | Product platform architecture document | SPECIFIED ONLY | Implement server-side persistence/API, then run reload/reconnect/recovery integration tests |
| PLAT-001 | One shared backend and canonical API must serve web, iOS, Android, and later desktop clients | `docs/MASTER_BRAIN_PRODUCT_PLATFORM_ARCHITECTURE.md` | SPECIFIED ONLY | Freeze API contracts and auth/session model; implement one end-to-end vertical slice |
| PLAT-002 | Desktop and mobile clients must present the same server-authoritative mission state | Platform architecture document | SPECIFIED ONLY | Contract tests plus cross-client integration tests against the same persisted mission |
| PLAT-003 | Persian-first RTL and mixed Persian/Latin technical content must be usable | `docs/MASTER_BRAIN_EXPERIENCE_AND_VISUAL_DESIGN_SYSTEM.md` | SPECIFIED ONLY | RTL component tests, mobile checks, accessibility review with representative mixed-direction content |
| UX-001 | Interface must be premium, scientifically honest, responsive, and accessible | Experience and visual design system | SPECIFIED ONLY | Implement shared tokens/components; visual, responsive, keyboard, and assistive-technology tests |
| UX-002 | No fabricated live operational metrics or unsupported confidence percentages | Experience design system + evidence protocol constraints | SPECIFIED + PARTIAL IMPLEMENTATION | UI/API review; demo data must be explicitly labeled and isolated |
| UX-003 | Users can inspect evidence provenance, counterevidence, unknowns, rival hypotheses, and audit history | Experience design system | SPECIFIED ONLY | Build claim/evidence review screen connected to actual API records |
| OPS-001 | A first vertical slice must create a mission, request clarification, require approval where appropriate, show status/result, and recover after reload | Platform architecture document | NOT IMPLEMENTED / NOT VERIFIED | Complete only after automated end-to-end tests pass against a running backend |
| OPS-002 | CI and tests must verify changes before delivery claims are made | Existing test files and prior workflow runs; latest design-doc commit has no CI result recorded in this document | NOT VERIFIED FOR LATEST HEAD | Inspect current workflow status and run the relevant test suite for each code change |

## 3. Architecture and delivery sequence

The implementation order is dependency-driven:

1. **Canonical contracts:** finalize mission schema, lifecycle transitions, idempotency, errors, and versioning.
2. **Trustworthy authorization:** authenticate actors; bind approval to exact mission contract digest/version and expiry; reject stale or replayed approvals.
3. **Durable state and audit:** persist mission state and append audit events transactionally or define a safe outbox/reconciliation pattern; fail closed for consequential operations if required audit persistence fails.
4. **Backend/API vertical slice:** create mission → clarification → approval → status/result → audit view → reload/reconnect recovery.
5. **Web experience:** implement the responsive, Persian/RTL-capable interface against the real API, including unknown/error/offline states.
6. **Cross-platform clients:** reuse the same contracts and server state for iOS and Android; do not create independent client-side mission truth.
7. **Independent verification:** automated unit, integration, security, accessibility, responsive, and end-to-end checks; record exact commands/results and commit SHA.

Do not begin by building a disconnected dashboard full of placeholder metrics. Visual quality and scientific integrity must be validated together.

## 4. Minimum release gates

A vertical slice is not releasable until all applicable gates are evidenced:

- [ ] Mission contract is versioned, validated, and persisted.
- [ ] Lifecycle transitions reject invalid or stale updates.
- [ ] Consequential execution fails closed without valid, authenticated, contract-bound approval.
- [ ] Approval is auditable and cannot be reused against a changed mission contract.
- [ ] Audit-write failure cannot be represented as a successful consequential operation.
- [ ] Unknown/unexecuted tests remain unresolved and cannot be silently promoted to pass.
- [ ] Refresh and reconnect recover authoritative server state without duplicate side effects.
- [ ] Errors, timeouts, offline states, and uncertain outcomes have safe recovery behavior.
- [ ] No live UI value is fabricated; heuristic weights are not shown as calibrated probabilities.
- [ ] Desktop/mobile responsive behavior and Persian/RTL are tested.
- [ ] Critical flows meet the accessibility target and have documented test evidence.
- [ ] CI results are checked for the exact delivered commit.

## 5. Known limitations to keep visible

- A local SHA-256 hash chain is tamper-evident only within its stated threat model; without an external trusted checkpoint/signature, an attacker able to rewrite the full history may recompute the chain.
- The current approval boolean is a policy input, not proof of authenticated human approval.
- A deterministic keyword planner is not semantic general intelligence and must not be marketed as such.
- Existing unit tests, where present, do not prove API integration, cross-platform consistency, production security, or operational reliability.
- The product architecture and design documents are specifications. They do not mean that a working website, mobile application, database, or production service already exists.

## 6. Change-control rule

For each meaningful requirement change, record:
1. the requirement ID and rationale;
2. affected contract, modules, and clients;
3. tests added or changed;
4. test command, result, and exact commit SHA;
5. known gaps and rollback/recovery considerations.

Preserve the original source-recovery work as a separate track. Do not treat this implementation branch or its prototype code as proof that the inaccessible original source has been recovered, deleted, or replaced.
