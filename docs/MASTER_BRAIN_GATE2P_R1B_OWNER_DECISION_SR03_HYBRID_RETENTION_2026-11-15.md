# Master Brain — Gate 2P / R1-B: Owner Decision SR-03 — Hybrid Idempotency Retention

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Date:** 2026-11-15  
**Status:** OWNER DECISION RECORDED — HYBRID POLICY SELECTED; PARAMETERS OPEN  
**Scope:** Gate 2P idempotency/replay retention only.

## 1. Decision

The owner selects a hybrid of options A and B:

- Preserve durable evidence that an idempotency key has been consumed within its namespace, so an expired operation key cannot silently become a fresh operation in that same namespace.
- Bound the retention of bulky operational details for terminal, fully reconciled operations. Those details may be compacted, archived, or deleted only under an approved retention schedule and after integrity-checked archival where required.
- Use an explicit, versioned idempotency namespace/epoch. Epoch rollover must be controlled, auditable, and must not silently reinterpret an old key as a new operation.

This is not a decision to retain every full operation record forever, nor permission to delete all evidence after a fixed TTL.

## 2. Mandatory invariants

1. UNKNOWN, IN_PROGRESS, ORPHAN, and otherwise unresolved operations MUST NOT be removed by routine TTL cleanup, compaction, or epoch rollover.
2. A namespace/key pair already consumed MUST NOT become reusable in that same namespace merely because bulky details expired.
3. A replay against an expired/closed namespace MUST return a deterministic non-executing outcome (for example, IDEMPOTENCY_EXPIRED or NAMESPACE_CLOSED); it MUST NOT create a new operation.
4. A new namespace epoch MUST be explicit in the operation identity and request protocol. The system MUST NOT silently retry an old request in a new epoch.
5. Epoch rollover is prohibited while any operation in the old epoch remains UNKNOWN, IN_PROGRESS, ORPHAN, or otherwise unresolved.
6. If tombstone integrity, archive availability, capacity, namespace state, or retention metadata cannot be established, admission MUST fail closed. No write may proceed on an unproven replay state.
7. Compaction/archive must preserve sufficient non-secret evidence for audit and replay decisions, including namespace/epoch, a non-reversible key representation or keyed digest, request fingerprint, terminal outcome, and relevant timestamps/record references. Exact fields and cryptographic key lifecycle remain subject to design review.
8. The design MUST state the precise guarantee horizon and its limits. It MUST NOT claim global or perpetual exactly-once execution; external GitHub side effects remain subject to ambiguity and reconciliation constraints.

## 3. Split retention classes

### Class A — durable replay-prevention evidence
Retain a compact, integrity-protected tombstone or equivalent durable index for every consumed key for the lifetime of its namespace, or provide an independently verified archival lookup with equivalent semantics. The tombstone must be sufficient to reject reuse and distinguish a legitimate replay from a conflicting request, subject to the approved digest/key design.

### Class B — bounded operational detail
For terminal, fully reconciled operations only, detailed payloads, verbose phase history, and other bulky records may have a bounded hot-retention period. After that period they may be compacted or archived according to a separately approved schedule. Deletion is allowed only after the durable replay-prevention evidence and required audit evidence are verified.

Unresolved records are outside Class B cleanup eligibility.

## 4. Epoch lifecycle requirements

Before an epoch can be closed:
- Stop new admissions into that epoch.
- Prove there are no unresolved operations.
- Reconcile all terminal/ambiguous external effects.
- Verify tombstone and audit-index integrity and recoverability.
- Record the closure decision, epoch identifier, counts, digest/root, and archival references.
- Make old-epoch replay deterministically non-executing.

A later epoch is a distinct namespace. Reuse of the same client key in a later epoch must not be treated as a replay of the old operation; nor may it be used as an automatic retry path for that old operation. Client/API semantics must make the epoch boundary explicit.

## 5. Parameters deliberately left OPEN

This owner decision does not select:
- Hot-detail retention duration.
- Audit/archive retention duration and legal requirements.
- Tombstone representation (plain digest vs keyed HMAC, key rotation and verification strategy).
- Namespace/epoch identifier format and distribution to clients.
- Maximum tombstone count, per-tenant/global quotas, storage budget, and admission thresholds.
- Archive technology, independent verification, restore drills, and external anchoring.
- Exact response codes and compatibility/migration behavior.

These must be specified with capacity estimates, threat analysis, recovery tests, and independent adversarial review before implementation.

## 6. Gate effect

- SR-03 is resolved at the policy level by the hybrid decision.
- Detailed parameters remain OPEN.
- D-01..D-16 are not thereby approved as a whole.
- Remaining SR-01..SR-07 are not thereby approved or closed.
- R2 experiments remain separate and are not authorized by this decision.
- No implementation, source-code modification, PR, merge, deployment, credential change, Cloudflare/Supabase change, or laptop change is authorized.
- Tests and operational experiments remain NOT_RUN unless separately evidenced.

## 7. Acceptance rationale

The hybrid policy avoids the unbounded growth of retaining every full operation record indefinitely while preserving the key property needed for replay safety: an expired key cannot silently become a new operation in the same namespace. It also avoids treating a TTL as proof that an external side effect did not occur. The policy is conditional on durable tombstone/archive integrity, explicit epoch semantics, bounded capacity, and fail-closed admission.

**Decision label:** APPROVED BY OWNER — POLICY DIRECTION ONLY  
**Implementation status:** NOT IMPLEMENTED  
**Verification status:** NOT TESTED  
