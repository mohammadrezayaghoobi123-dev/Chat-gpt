# Master Brain — Gate 2P / R1-B Owner Decision Record

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
## SR-08: Reject residual authorization-to-dispatch race

**Decision ID:** MB-G2P-R1B-OD-SR08-2026-11-15  
**Decision date:** 2026-11-15  
**Decision authority:** Project owner (explicit instruction in conversation)  
**Status:** OWNER DECISION RECORDED — REJECT  
**Scope:** Gate 2P proposed WriteControl / GitHub external-write contract only  
**Related proposal:** `docs/MASTER_BRAIN_GATE2P_R1A_CONTRACT_DELTA_V2_PROPOSAL_2026-11-15.md`  
**Related amendment:** `docs/MASTER_BRAIN_GATE2P_R1A_AMENDMENT_01_SR01_SR08_2026-11-15.md`  
**Amendment blob SHA reviewed:** `6034625a4b2b161b6e35c1665f17d31e258aa865`

## 1. Explicit owner decision

The owner selects **REJECT** for SR-08.

The owner does **not** accept the residual race between the final authorization check / dispatch-intent and GitHub's external acceptance of a write request.

Accordingly, the proposed Gate 2P contract must not treat a short-lived permit, a local lease/fencing generation, a final re-authorization check, audit logging, or reconciliation as eliminating this race. Those controls may reduce exposure and improve detection/recovery, but they do not provide destination-side atomic fencing or guaranteed cancellation of a request already in flight.

## 2. Required safety consequence

For any future implementation governed by Gate 2P:

1. External GitHub write dispatch remains **DENY / NOT AUTHORIZED** until a stronger mitigation is designed, independently reviewed, and explicitly approved by the owner.
2. No write path may infer acceptance from silence, timeout, local lease validity, or a successful local state transition.
3. Ambiguous dispatch outcomes remain `UNKNOWN`; blind resend is prohibited.
4. Read-only inspection and reconciliation may be designed separately, subject to least-privilege credentials and their own approval gates.
5. A future proposal to reopen writes must state the exact threat model, destination-side guarantees (if any), residual race, failure semantics, recovery protocol, and evidence required to prove the mitigation.
6. If no destination-side mechanism can close the race, the proposal must present that limitation explicitly and return to the owner for a new decision. This record does not pre-approve a weaker alternative.

## 3. Meaning and limits of this decision

This decision is a **design / authorization decision for the Gate 2P contract**. It is not an operational kill switch.

It does not:
- change, disable, or claim to disable any currently deployed Worker, Cloudflare route, credential, GitHub integration, or existing service;
- revoke or rotate any secret;
- modify source code, configuration, bindings, or infrastructure;
- authorize a PR, merge, staging write, or production deployment;
- approve D-01 through D-16 as a group;
- approve the remaining SR-01 through SR-07 amendments;
- claim that any test, R2 experiment, or independent review has passed.

Any operational change to an existing deployment requires a separately scoped instruction, impact assessment, and verification plan.

## 4. Acceptance criteria for a future reconsideration

A new write-enablement proposal must provide all of the following:

- A clearly stated adversary and failure model, including stale workers, lease expiry, credential revocation, network partition, request timeout, and upstream acceptance with response loss.
- A mechanism that prevents or safely contains stale/unauthorized external dispatch, preferably enforced by the destination or a trusted serialization boundary; local fencing alone is insufficient.
- A precise statement of what is atomic and what is not across WriteControl, TenantDirectory, dispatcher, and GitHub.
- Explicit treatment of the final check-to-send race and any residual risk; no claim of zero race without independently verifiable destination-side evidence.
- Fault-injection tests for each write endpoint, including upstream acceptance followed by response loss.
- Independent adversarial review of the exact pinned document/code blobs.
- A least-privilege authorization and credential model.
- A separate explicit owner decision before implementation or enabling any write path.

## 5. Gate status after this decision

| Gate / item | Status |
|---|---|
| SR-08 owner choice | **DECIDED: REJECT** |
| SR-08 residual-risk acceptance | **REJECTED** |
| Gate 2P external write authorization | **DENY / NOT AUTHORIZED** |
| R1-B overall (D-01..D-16 and remaining owner decisions) | **INCOMPLETE** |
| R1-C independent review | **NOT_RUN** |
| R2 non-production experiments | **NOT_RUN** |
| Implementation / PR / merge / deployment | **NOT_AUTHORIZED** |

## 6. Audit rule

This decision is immutable as a historical decision record. A later change requires a new, separately identified owner decision that supersedes this record; do not silently edit or reinterpret it.

**Final classification:** OWNER DECISION RECORDED — REJECT — DESIGN-LEVEL FAIL-CLOSED — NOT IMPLEMENTED — NOT TESTED.
