# Master Brain — Gate 2M Service-Only v1 Identity Decision
**Date:** 2026-11-15  
**Decision ID:** MB-ADR-G2M-SERVICE-ONLY-V1-2026-11-15-001  
**Applies to:** Gate 2K unified write-execution contract and Gate 2L findings  
**Branch:** integration/master-brain-unification-2026-11-15  
**Status:** OWNER-ACCEPTED DIRECTION — DESIGN DRAFT — NOT IMPLEMENTED — NOT RELEASE-AUTHORIZED

## 1. Decision

The first controlled write-path release will be **service-to-service only**. Human OIDC is deferred from v1.

The existing shared bearer is treated exclusively as a service credential whose principal type is service and whose identity is service:shared-mcp-bearer for the currently reviewed compatibility path. It is not a human identity, must not be relabelled as a human, and must not be used to claim individual human attribution.

This decision accepts a temporary release scope. It does not waive tenant/project authorization, write-operation safety, audit, revocation, or evidence requirements.

## 2. Explicit non-goals for v1

- No direct end-user use or distribution of the shared bearer.
- No human OIDC, email OTP, phone/SMS, or social-login claim in this write path.
- No inference of human identity from IP address, user-agent, email text, request body, tenant selector, or project selector.
- No automatic translation from service principal to a tenant member or human operator.
- No weakening of exact tenant membership and project/action/resource authorization.
- No automatic enabling of production writes.

If a future product flow requires attribution to a human operator, it must introduce a separately authenticated, integrity-protected actor assertion with issuer, audience, subject, expiry, replay protection, and audit binding. That is a later design gate; it is not present merely because a service bearer is accepted.

## 3. Required service identity contract

The following are mandatory design requirements for any v1 implementation:

1. **Server-derived principal:** the Worker derives the service principal only after successful server-side credential validation. Client-supplied principal IDs/types are ignored or rejected.
2. **Fixed identity semantics:** the credential maps to a service principal, never to a human principal. Unknown or malformed principal types fail closed.
3. **No selector privilege:** tenant/project selectors are routing/context inputs only. They never grant membership, role, or permission.
4. **Independent authorization gates:** current service-principal tenant membership and exact project/action/resource policy are checked for each new operation and each replay/reconciliation decision as defined by the approved contract.
5. **No wildcard write by default:** wildcard resource policy for project.create_pr remains DENY until the owner explicitly approves a separately governed capability. This is a conservative security default, not a claim that the existing code already enforces it.
6. **Credential lifecycle:** the implementation must define issuance, secure storage, rotation, revocation, expiry/overlap, emergency disable, and audit. Secret values must never be logged or committed.
7. **Constrained service scope:** the service credential must have the minimum approved action and resource scope. A single bearer must not silently confer all-tenant or all-project authority.
8. **Explicit service attribution:** audit records identify the service principal and credential/key version or non-secret credential identifier. They must not invent a human actor.
9. **Fail-closed dependency behavior:** credential validation, membership lookup, project policy lookup, or required audit admission failure blocks the external GitHub write.
10. **No unaudited fallback:** no fallback to owner-wide access, wildcard writes, stale positive authorization cache, or unauthenticated write path.

## 4. Compatibility and migration constraints

- Preserve the existing service:shared-mcp-bearer identity label only as an explicit legacy compatibility identifier until a versioned service-principal migration is approved.
- Do not rotate, replace, expose, read, or modify any live secret as part of this documentation decision.
- Do not change current production or staging bindings, routes, Worker configuration, or Durable Object schema.
- A later implementation must support a versioned service credential identity so that rotation and revocation do not require changing the principal's semantic identity or exposing secret material.
- A service-only v1 must not prevent a later additive human OIDC path. Human and service principal namespaces remain separate.
- Do not auto-link a human to a service principal by email or other mutable profile data.

## 5. Security limitations accepted temporarily

This decision accepts that the current write path cannot independently attribute a request to a specific human. Consequently:
- individual human revocation is outside the v1 Worker trust boundary;
- per-human quotas and human-level audit attribution are not claimed;
- the upstream system operating the service credential becomes a critical trust boundary and must be documented and independently reviewed;
- any compromise of the shared service credential may affect every tenant/project to which that service principal is authorized.

These are explicit limitations, not resolved risks. Before staging use, the service credential's distribution boundary, operator access, rotation, emergency revocation, and allowed tenant/project scope must be evidenced.

## 6. Acceptance criteria before implementation authorization

- [ ] Service-only scope and limitations accepted by owner.
- [ ] Credential issuer/owner and storage boundary identified.
- [ ] Credential rotation and revocation procedure defined and tested without exposing secret values.
- [ ] Exact tenant membership and project/action/resource authorization for the service principal specified.
- [ ] Wildcard write behavior explicitly decided and negative tests specified.
- [ ] WriteControl operation owner and durable storage boundary selected.
- [ ] Service identity and credential version included in immutable operation/audit context.
- [ ] Replay and UNKNOWN reconciliation re-check current service authorization.
- [ ] No end-user client receives the shared bearer.
- [ ] Independent reviewer confirms the service-only boundary and tests.

The owner acceptance of service-only direction does not satisfy the other checkboxes.

## 7. Consequences

**Positive**
- Reduces v1 identity scope and avoids prematurely exposing an unverified human OIDC path.
- Preserves a clear distinction between machine identity and human identity.
- Allows the write-control state machine to be designed against one explicit principal class initially.

**Negative / residual**
- No individual human attribution or per-human revocation at this boundary.
- Shared credential compromise has potentially broad blast radius.
- Upstream service credential custody and tenant scoping become mandatory assurance topics.
- Human OIDC remains a later additive migration, not an implied capability.

## 8. Gate status

Gate 2M has recorded the service-only v1 direction. It has **not** implemented the contract, validated the live secret lifecycle, or authorized a release.

Implementation remains blocked on the acceptance criteria above and the open Gate 2L findings. No source code, tests, Worker, Durable Object, secrets, bindings, routes, DNS, database, pull request, main branch, or production resource was modified by this decision record. No tests were run.

**Decision:** SERVICE-ONLY V1 DIRECTION ACCEPTED.  
**Implementation:** NOT AUTHORIZED.  
**Staging/production write release:** NO-GO pending evidence and independent review.
