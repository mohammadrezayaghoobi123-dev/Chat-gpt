# Master Brain — Gate 2N Independent Adversarial Review Brief
**Date:** 2026-11-15  
**Review ID:** MB-G2N-INDEPENDENT-REVIEW-2026-11-15-001  
**Target branch:** integration/master-brain-unification-2026-11-15  
**Target head at packet creation:** 96ed08401b63f3b67d489528ab23b7efcb4d2acf  
**Review type:** Independent architecture/security challenge  
**Requested reviewer:** External reviewer (for example, Claude) who did not author Gate 2N  
**Status:** PACKET PREPARED — EXTERNAL REVIEW NOT REQUESTED/NOT RECEIVED — NOT_RUN

## 1. Purpose

Independently challenge the proposed Gate 2N architecture. Do not assume the proposal is correct because it is documented. Attempt to falsify its core claims and identify a safer or simpler alternative.

The reviewer must not implement code, change repository files, deploy, access secrets, or modify infrastructure. This is a read-only design review.

## 2. Exact materials to inspect

Review these files from the target branch, not from main or another historical branch:

1. `docs/MASTER_BRAIN_GATE2K_UNIFIED_WRITE_EXECUTION_CONTRACT_DRAFT_2026-11-15.md`
2. `docs/MASTER_BRAIN_GATE2L_WRITE_PATH_ADVERSARIAL_REVIEW_2026-11-15.md`
3. `docs/MASTER_BRAIN_GATE2M_SERVICE_ONLY_V1_DECISION_2026-11-15.md`
4. `docs/MASTER_BRAIN_GATE2N_WRITECONTROL_OWNERSHIP_LIFECYCLE_REVIEW_2026-11-15.md`
5. `docs/ADR_G2N_01_DEDICATED_WRITECONTROL_BOUNDED_CONTEXT_2026-11-15.md`

Inspect source files at the exact blob identities recorded in Gate 2N:
- Worker: `8911b4fc7df279ecbea7689506e0f814b2414dff`
- OrchestratorLedger: `ba32281b3698d40917505096d2a61501f8c0f9e4`
- TenantDirectory: `47647f84afc03c554b808060b6adce200d31e13d`
- Tenant context: `2282a056d1b0436ad8e573f7c8d7873d4fe5c34b`
- Wrangler configuration: `6c81ef6761497f6e8889a1ed8aa715b70922a949`

If any blob or document is unavailable or differs, stop and report the provenance discrepancy rather than silently substituting another version.

## 3. Required adversarial questions

### A. Aggregate ownership
1. Is a dedicated WriteControl aggregate actually justified, or can OrchestratorLedger safely own this lifecycle without violating domain boundaries?
2. Is the evidence about task-linked outbox and task-associated audit sufficient? What counter-evidence or missing code could falsify that conclusion?
3. Is TenantDirectory the correct and sole authority for membership and project policy?

### B. Durable Object topology
4. Is one logical global WriteControl DO defensible for a controlled v1? Identify serialization, availability, cost, storage, hot-key, and noisy-neighbor risks.
5. Is the global emergency ceiling truly atomic in the proposed topology?
6. Would per-tenant sharding be safer or cheaper? If yes, explain how to preserve global emergency controls, idempotency, UNKNOWN recovery, and migration safety without hand-waving.

### C. Cross-DO authorization and TOCTOU
7. Is the proposed authorization linearization rule adequate when TenantDirectory and WriteControl are separate DOs?
8. What exact revocation race remains between authorization and an external GitHub dispatch?
9. Is re-checking before each external phase sufficient, and what should happen if revocation occurs after TREE or COMMIT creation but before branch/PR creation?
10. What evidence must be immutable in the operation record to reconstruct the decision later?

### D. Idempotency and canonicalization
11. Is the proposed operation identity scope complete? Identify missing security-relevant fields or fields that should not be included.
12. Is separating operation identity from request fingerprint correct?
13. Are title, summary, branch, paths, file digests, and expected blob SHA bound exactly to the payload sent to GitHub?
14. Can Unicode, case folding, URL/repository normalization, path aliases, or delimiter attacks create collisions or bypasses?

### E. External side effects and UNKNOWN
15. Are the proposed DISPATCHED/WRITTEN phase pairs sufficient for all GitHub operations?
16. Which GitHub endpoints are idempotent, conditionally idempotent, or non-idempotent?
17. Can exact reconciliation evidence distinguish a request's own commit/branch/PR from pre-existing or concurrent objects?
18. What should happen when evidence is partial, duplicated, delayed, or contradictory?
19. Is any cleanup of uncertain external objects safe? Under what separate authorization and evidence?

### F. Credential and service-only boundary
20. Does service-only v1 meaningfully reduce risk, or does the shared bearer remain an unacceptable blast-radius concentration?
21. What credential ID/version, overlap, revocation propagation, emergency-disable, and audit design is required?
22. Can any end-user obtain the shared bearer indirectly through the current upstream path? The reviewer must not infer an upstream boundary without evidence.

### G. Audit, outbox, retention, recovery
23. Is atomic operation reservation + local audit/outbox enough to guarantee no unaudited write?
24. What happens if the external audit sink is unavailable but the local outbox is durable?
25. Are hash chaining, backup/restore, restore epochs, tombstone retention, and UNKNOWN retention adequately specified?
26. What failure injection and end-to-end integration evidence is missing?

### H. Quotas and operational safety
27. Are the proposed quota dimensions complete?
28. What measurements are necessary before setting values?
29. Does a single coordinator permit denial-of-service or starvation by one tenant?
30. What health metrics, alerts, kill switch, and recovery runbooks are mandatory before staging?

## 4. Required reviewer output

The reviewer must return:
1. An independent verdict: ACCEPT / ACCEPT WITH CONDITIONS / REJECT / UNKNOWN.
2. Findings classified BLOCKER / HIGH / MEDIUM / LOW / UNKNOWN.
3. Evidence for every finding: exact file, symbol/line or blob SHA.
4. Counter-evidence and rival hypotheses for every major claim.
5. Falsification conditions and the minimum test that would distinguish competing explanations.
6. A corrected architecture if the proposal is rejected or materially incomplete.
7. A prioritized implementation/test sequence that preserves rollback and does not alter main.
8. Explicit statement of what was not inspected or not tested.

Do not accept a generic statement such as “looks good” or “best practice.” Every approval must be tied to evidence and testable conditions.

## 5. Reviewer independence and safety

- Reviewer must not be the author of the Gate 2N report or ADR.
- Reviewer must challenge the design from first principles and may disagree.
- No source code edits, commits, PR creation, merges, deployments, secrets access, or live production probes.
- Do not ask for or reproduce secret values.
- Do not claim tests were executed unless commands were run and outputs captured.
- The review packet is not an approval, attestation, or security certification.
- If the reviewer lacks access to the exact source revision, verdict must be UNKNOWN for affected claims.

## 6. Current state

- Packet prepared in repository.
- External reviewer not yet engaged through this packet.
- External findings: NOT_RECEIVED.
- Independent review: NOT_RUN.
- Gate 2N architecture: PROPOSED, NOT_FROZEN.
- Implementation: NOT_AUTHORIZED.
- Tests: NOT_RUN.
- Staging/production: NO-GO.
