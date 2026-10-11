# Master Brain — Product Platform Architecture
**Status:** Proposed architecture baseline for review and incremental implementation  
**Date:** 2026-10-11  
**Branch:** `master-brain/proof-protocol-v0`  
**Scope:** Cross-platform product surfaces and shared application/backend boundaries  
**Important:** This is a specification, not evidence that any UI, API, database, mobile build, or production deployment already exists.

## 1. Product decision

Master Brain is one product with multiple clients, not separate products with separate brains. It must be usable from:
- desktop browsers on Windows, macOS, and Linux;
- mobile browsers;
- native iOS and Android applications;
- optionally, installable desktop wrappers later if there is a demonstrated need.

All clients must use the same authenticated application API and canonical mission/state contracts. Policy, model credentials, orchestration, evidence assessment, durable mission state, and audit decisions belong on the trusted server side. Clients are presentation and interaction surfaces; they must not independently reimplement authoritative policy.

## 2. Product principles

1. **One brain, multiple surfaces:** shared missions, evidence, permissions, and status across devices.
2. **Progressive delivery:** build a narrow end-to-end vertical slice before broad UI or provider expansion.
3. **Preserve existing work:** add this specification without overwriting the existing integrated architecture, historical recovery records, or prototype modules.
4. **Explicit maturity:** distinguish PROPOSED, SPECIFIED, IMPLEMENTED, TESTED, INDEPENDENTLY_VALIDATED, and PRODUCTION_VERIFIED.
5. **Secure by default:** deny consequential actions unless the server-side policy gate permits them; never trust a client-supplied approval boolean as identity proof.
6. **Durable long-running work:** closing a browser/app or losing mobile connectivity must not silently erase server-side mission state.
7. **Honest execution state:** planned, selected, queued, running, completed, failed, cancelled, and verified are distinct states. A selected island/model is not evidence it ran.
8. **Portable infrastructure:** avoid binding domain logic to a single UI framework, provider, hosting company, or database implementation.
9. **Accessible and internationalized:** responsive layouts, keyboard accessibility, screen-reader semantics, timezone-aware timestamps, and Persian/RTL support are product requirements.
10. **Cost-aware:** provider calls, retries, storage, and notifications require budgets, limits, and visible usage records.

## 3. Logical architecture

```text
Web client / Mobile client / optional Desktop shell
                    |
             Authenticated API
                    |
       Application & Mission Lifecycle
                    |
  Supreme Command + Meta-Intelligence Coordinator
                    |
      Specialist islands / provider adapters
                    |
 Intelligence Plane <-> Proof Plane
                    |
 Mission state / Evidence / Memory / Audit / Policy
                    |
       Database + artifact storage + queue
```

This is a logical boundary map, not a mandate to split every component into a separate service. Start with a modular backend and split processes only when measured security, scale, or reliability requirements justify it.

### 3.1 Client layer
Responsibilities:
- responsive presentation and navigation;
- mission creation, clarification, approval prompts, and status viewing;
- rendering evidence, limitations, competing hypotheses, test outcomes, and audit history;
- client-side form validation for usability only;
- secure session handling through platform-appropriate mechanisms;
- offline drafts and cached read-only views only when their privacy and staleness are clearly indicated.

Clients must not hold provider master keys, bypass the policy gateway, decide final authorization, or claim a server-side action succeeded before receiving confirmation.

### 3.2 Application/API layer
Responsibilities:
- authentication and server-side authorization;
- versioned API contracts;
- idempotency for retryable create/approve/cancel requests;
- input validation, rate limits, request size limits, and abuse controls;
- mission lifecycle operations and status subscriptions/polling;
- consistent error envelopes and correlation IDs;
- server-side authorization on every object access to prevent cross-user data exposure.

The API must be transport-neutral enough for browser and native clients. Candidate API style: versioned REST for commands/queries, with server-sent events or WebSocket only where live status materially improves UX. Begin with polling if it is simpler and reliable.

### 3.3 Mission lifecycle service
The service coordinates the canonical MissionContract and its lifecycle. It must enforce explicit transitions, record who/what caused each transition, persist state before acknowledging durable acceptance, and fail closed when required policy/audit operations fail.

Minimum lifecycle vocabulary:
- DRAFT
- NEEDS_CLARIFICATION
- READY_FOR_REVIEW
- AWAITING_APPROVAL
- QUEUED
- RUNNING
- COMPLETED
- FAILED
- CANCEL_REQUESTED
- CANCELLED
- NEEDS_RECOVERY
- VERIFIED (separate from COMPLETED; requires defined verification evidence)

Exact enum names may be adapted to existing contracts after compatibility review; do not introduce a second competing mission state model without a migration plan.

### 3.4 Intelligence and Proof planes
Keep the A+B integration:
- Intelligence proposes plans, hypotheses, options, and specialist assignments.
- Proof evaluates evidence quality, source independence, counterevidence, explicit counterexamples, unknowns, test validity, and limitations.
- The Supreme Command layer synthesizes the final answer and respects global policy.
- Specialist islands cannot grant themselves permissions.
- Provider agreement is not independent corroboration when sources or training/evidence are shared.
- The system must preserve uncertainty and be allowed to abstain.

### 3.5 Persistence and background execution
A mission accepted for asynchronous execution must be persisted with a stable ID and recoverable status. Use a durable queue/worker when the first real background workload requires it. Define retry policy, timeout, cancellation semantics, deduplication, dead-letter/recovery path, and idempotent side-effect handling before consequential actions.

Candidate storage choices such as PostgreSQL and an object store are proposals only. Final selection must account for the recovered code, hosting constraints, local payment/access limitations, backups, data residency, operational burden, and cost. Do not add infrastructure merely because it is fashionable.

## 4. Recommended client strategy

### Initial recommendation
- **Web:** responsive TypeScript web application (Next.js is a candidate).
- **Native mobile:** React Native with Expo is a candidate for iOS and Android.
- **Shared packages:** typed API client, generated/shared schemas where practical, design tokens, validation rules that are safe to share, and domain display helpers.
- **Desktop:** first deliver the web client in desktop browsers. Evaluate Tauri or another desktop shell only if offline access, OS integration, or distribution requirements justify it.
- **Backend:** preserve the current Python domain core; evaluate FastAPI as an API boundary after inspecting the current package and adding contract tests.

This is a technology recommendation, not a commitment to begin four separate applications at once. Keep business rules on the server and share client contracts so native/web clients cannot drift in their interpretation of mission status.

### Why not build every client immediately?
A full native/web/desktop release in parallel would multiply testing and deployment surfaces before a reliable mission lifecycle exists. The intended outcome remains cross-platform; implementation proceeds in vertical slices, with responsive web as the first end-to-end surface and native clients following the same stable API.

## 5. Shared capability requirements

### MB-PLAT-001 — Cross-platform access
Users can access core mission capabilities from desktop browser, mobile browser, iOS, and Android. Acceptance: the same test mission can be created and viewed from each surface using the same server record.

### MB-PLAT-002 — One source of truth
Mission state, approval records, evidence references, and audit events are server-authoritative. Acceptance: changes from one authorized client appear consistently on another; clients cannot invent authoritative status.

### MB-PLAT-003 — Durable asynchronous missions
An app closing or network interruption does not erase accepted work. Acceptance: after restart/reconnect, the client can retrieve the same mission ID and current status; recovery behavior is tested.

### MB-PLAT-004 — Secure authorization
Every API operation verifies identity, resource ownership, role, and policy. High-risk approval is bound to the exact mission contract version/digest and authenticated approver identity. Acceptance: unauthorized, stale-contract, wrong-user, and replay attempts are denied and audited without executing the action.

### MB-PLAT-005 — Evidence and decision transparency
Users can inspect claims, evidence provenance, counterevidence, unknowns, limitations, and decision history subject to permissions. Acceptance: unknown and not-run states remain visible and cannot be rendered as successful verification.

### MB-PLAT-006 — Accessible responsive UI
Core workflows work at narrow mobile widths and desktop sizes, support keyboard navigation and assistive technology, and correctly handle Persian/RTL and timestamps. Acceptance: automated accessibility checks plus manual smoke tests on representative browsers/devices.

### MB-PLAT-007 — Operational controls
Admin-authorized users can inspect provider availability, budgets, error rates, mission queue health, and audit status without seeing secrets unnecessarily. Acceptance: role-based access and redaction tests.

### MB-PLAT-008 — Versioned compatibility
Client/server schemas are versioned, with documented compatibility and migration behavior. Acceptance: contract tests prevent breaking existing clients without an explicit version or migration strategy.

### MB-PLAT-009 — Resilience and observability
Requests have correlation IDs; durable state transitions and errors are traceable; retries are bounded and idempotent. Acceptance: injected API, queue, provider, and persistence failures produce explicit states and no false success.

### MB-PLAT-010 — Cost and privacy controls
Users can configure or see applicable budgets and data-handling settings; secrets and unnecessary sensitive content are redacted from logs. Acceptance: tests cover budget exhaustion, redaction, and access-control boundaries.

## 6. First vertical slice

Do not start with a decorative dashboard. Build one complete, inspectable workflow:

1. An authenticated user creates a mission from the web client.
2. The server validates and persists the canonical contract and returns a stable mission ID.
3. The mission service records an initial audit event.
4. The UI shows clarification questions or a policy/approval requirement when applicable.
5. The user can inspect the planned islands and see that planning is not execution.
6. A controlled, non-destructive offline task runs through the lifecycle.
7. The system stores the actual result, test outcome, limitations, and audit event.
8. The user can reload the page and retrieve the same state.
9. Automated tests prove unauthorized access, failed persistence, duplicate submission, stale approval, and unknown outcomes do not produce false success.
10. Only after this slice is stable should the same contracts be consumed by iOS/Android clients.

## 7. Delivery gates

### Gate 0 — Preserve and reconcile
- Record branch/head and current test status.
- Preserve the current prototype and architecture docs.
- Do not modify `main` or run destructive recovery/bootstrap steps.
- Reconcile this product spec with existing MissionContract and requirements matrices.

### Gate 1 — Domain/API contracts
- Define or adapt versioned request/response schemas for Mission, MissionStatus, Approval, EvidenceSummary, AuditEvent, and Error.
- Add schema validation and contract tests.
- Avoid duplicate competing enums and models.
- Document idempotency and authorization requirements.

### Gate 2 — Backend vertical slice
- Implement a narrow application service and API over existing domain code.
- Add durable mission persistence only after selecting a store based on actual deployment constraints.
- Verify failure handling and audit semantics.
- No live external side effects in this gate.

### Gate 3 — Responsive web
- Implement mission creation, clarification/approval, progress, result, evidence, and audit views.
- Add responsive/RTL/accessibility checks.
- No fake live data presented as real execution.

### Gate 4 — Native mobile
- Consume the same API and state contracts from iOS/Android.
- Add secure session management, reconnect behavior, notifications only after permission design, and mobile-specific UX.
- Verify cross-client consistency and revocation/logout behavior.

### Gate 5 — Desktop packaging (optional)
- Evaluate only after browser experience is proven.
- Define update signing, secure storage, permissions, and supported OS versions before release.

### Gate 6 — Production readiness
- Add authenticated approval records bound to contract digest, key/identity lifecycle, access controls, audit checkpoints, backups/restore drills, monitoring, rate limits, cost controls, incident response, and release rollback.
- Perform independent security and reliability review.
- Verify in the actual deployment environment before using PRODUCTION_VERIFIED.

## 8. Security invariants

- Server is authoritative for identity, authorization, policy, mission state, and audit.
- No provider secret is embedded in browser bundles or mobile app binaries.
- Approval must identify the authenticated approver, exact scope, mission ID, contract digest/version, time, and expiry/replay policy.
- A bare `approval_granted=True` flag is not production authorization.
- Sensitive operations fail closed if policy or required audit persistence is unavailable.
- Use least privilege and object-level authorization; do not trust client-supplied user IDs.
- Keep secrets, tokens, and unnecessary personal content out of audit payloads.
- Backups must be restorable and periodically tested; a hash chain alone is not a backup or proof against privileged full-history rewriting.
- Client cache must not expose private mission content after logout or account switching.
- Any external/destructive/financial/public action requires a separately defined action policy and, where required, explicit human approval.

## 9. Open decisions (do not guess)

1. Hosting target and affordable always-on deployment.
2. Authentication provider or self-managed identity approach.
3. Database and object-store choice after inspecting current persistence needs.
4. Whether the first release needs installable PWA behavior or native mobile from the first public beta.
5. Notification provider and platform permissions.
6. Data retention, export, deletion, privacy, and residency requirements.
7. Exact admin roles and which audit details each role may see.
8. The legacy source recovery outcome, which remains a separate preservation concern.

## 10. Explicit non-goals for the first slice

- Rewriting the existing domain core to fit a UI framework.
- Microservices for every logical module.
- Live automation of high-impact actions.
- Supporting every model/provider before budgets, adapters, and evaluations exist.
- Claiming a selected island/provider actually ran without execution records.
- Declaring production readiness based on unit tests, a mock screen, or CI alone.
- Replacing the existing integrated architecture or treating this document as evidence that the historical implementation has been recovered.

## 11. Required next engineering action

Review this spec against the current MissionContract, architecture baseline, and requirements traceability documents. Add links and requirement IDs to the canonical traceability record, identify overlap/conflict, and propose the smallest non-destructive implementation step. Do not build the UI until the API/lifecycle contract and acceptance tests are clear enough to prevent a throwaway front end.
