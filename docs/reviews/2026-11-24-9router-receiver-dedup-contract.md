# 9Router Receiver-Side Deduplication Contract

**Review date:** 2026-11-24  
**Status:** DESIGN ONLY — CHAT-ENDPOINT IDEMPOTENCY UNKNOWN  
**Related work:** PR #324 (Finding 67 reconciler), PR #431 (9Router redirect rejection)  
**Implementation authority:** NOT GRANTED

## 1. Decision

Do not claim that the 9Router chat-completions endpoint provides receiver-side idempotency until the exact deployed 9Router version, source revision, and endpoint behavior have been verified.

Do not add an `Idempotency-Key` header to the production review request merely because 9Router forwards that header on a different API family. No live 9Router request, provider call, ledger provisioning, secret change, or workflow permission change is authorized by this review.

The current evidence supports the following labels:

| Claim | Disposition | Basis |
|---|---|---|
| 9Router exposes an OpenAI-compatible chat API | PROVISIONALLY SUPPORTED | Public project site and architecture documentation |
| 9Router can route combo models and fall back between provider accounts | PROVISIONALLY SUPPORTED | Public architecture description; exact deployed behavior is version-dependent |
| 9Router forwards `Idempotency-Key` for video-generation creation endpoints | SUPPORTED FOR THAT ROUTE ONLY | Official repository change for `/v1/videos/{generations,edits,extensions}` |
| 9Router chat-completions route honors `Idempotency-Key` atomically | UNKNOWN | No chat-route contract, implementation proof, or deployment-specific test was established |
| One client POST implies one provider attempt | REJECTED | Public chat-core source includes a 401/403 credential-refresh path that can call `executor.execute()` again; model-combo/account fallback is also documented. Exact deployed behavior remains UNKNOWN |
| One provider attempt implies exactly one model execution | UNKNOWN | Provider-side acceptance, billing, retry, and deduplication semantics are outside the evidence collected |

## 2. Evidence boundary

### 2.1 Public router evidence

The public 9Router architecture document describes an OpenAI-compatible `/v1/` surface and a request path that can resolve combo models, select provider credentials, and use model/account fallback. The document identifies itself as last updated on 2026-02-06; it is architectural context, not proof of the user's deployed release.

An official 9Router change, commit `d6761c6fb003faf537c198ae206d4e9b9864dd65`, describes forwarding `Idempotency-Key` and disabling automatic retries for billable creation POSTs under the video-generation API. That evidence is scoped to `/v1/videos/{generations,edits,extensions}`; it must not be generalized to `/v1/chat/completions`.

References:

- https://github.com/decolua/9router/blob/master/docs/ARCHITECTURE.md
- https://github.com/decolua/9router/commit/d6761c6fb003faf537c198ae206d4e9b9864dd65
- https://9router.com

### 2.2 Current reviewer-client evidence

The reviewed client calls the configured HTTPS base URL plus `/chat/completions` with one POST and `redirect: "error"`. The request body contains the model, messages, temperature, streaming flag, and token limit. The request does not currently send `Idempotency-Key`.

The 307/308 regression tests prove that this Fetch call rejects those redirect responses and does not follow them to a second target in the controlled local test. They do not prove that an egress proxy, router, service mesh, or provider cannot replay or retry the request.

Reference: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/fix/9router-reject-redirects-2026-11-24/tools/9router-review/review.js

### 2.3 Required non-inference rule

OpenAI API compatibility describes request/response shape. It is not evidence of an idempotency implementation, an atomic uniqueness constraint, retention policy, replay response, or provider-side execution guarantee.

Until all receiver contract gates in this document pass for the exact deployed version, chat-route idempotency remains UNKNOWN.


### 2.4 Public chat-core retry path — additional hostile evidence

The public 9Router `master` source currently contains a concrete provider retry path in `open-sse/handlers/chatCore.js`: when a provider response has status 401 or 403, the handler attempts credential refresh (the inspected code calls `refreshWithRetry` with a maximum of three refresh attempts) and, if refreshed credentials are available, calls `executor.execute()` again using the request body. The public `open-sse/services/accountFallback.js` source separately evaluates fallback rules using status/text conditions and includes a default fallback decision for otherwise unmatched errors.

This is direct source evidence that one client POST can lead to more than one provider-executor invocation in the public source tree. It does **not** establish that each retry results in a billable model execution, nor does it establish that the user's deployed router version contains the same code. The exact deployed version, commit, and build digest remain UNKNOWN. The acceptance contract therefore continues to require provider-attempt telemetry and exact-version tests.

Additional public source references:

- https://github.com/decolua/9router/blob/master/open-sse/handlers/chatCore.js
- https://github.com/decolua/9router/blob/master/open-sse/services/accountFallback.js

## 3. Delivery layers and identities

The system must distinguish the following independently observable events:

1. **Logical review intent** — the canonical review tuple: repository ID, PR number, head SHA, and base SHA.
2. **Client dispatch** — the reviewer process decides to send one HTTP request.
3. **Router ingress acceptance** — the 9Router process accepts and durably records a request.
4. **Provider dispatch** — 9Router sends one or more upstream requests, potentially to multiple providers or model-combo members.
5. **Model execution** — an upstream provider accepts and performs billable or otherwise stateful inference.
6. **Client response receipt** — the reviewer receives and validates the router response.
7. **Report publication** — the reviewer publishes a report after its existing snapshot and duplicate checks.

These are different events. In particular, the public `master` chat-core source inspected for this addendum contains a credential-refresh retry path after provider 401/403, as well as model/account fallback. Therefore a single inbound client POST cannot be treated as a one-provider-attempt proof. This source is not pinned to the user's deployment, so the deployed behavior remains UNKNOWN. In particular:

- One client dispatch does not prove one router ingress if an intermediary can replay.
- One router ingress does not prove one provider dispatch if internal fallback or retry occurs.
- One provider dispatch does not prove exactly one provider-side execution if the provider's own acceptance outcome is ambiguous.
- A missing client response does not prove that the router or provider did not accept the request.

The existing redirect guard closes one Fetch behavior. It is not a distributed transaction and is not an end-to-end idempotency guarantee.

## 4. Required receiver contract for chat completions

This section defines acceptance criteria for a future 9Router receiver implementation. It is not a statement that current 9Router versions satisfy them.

### 4.1 Idempotency scope

The receiver must define a documented key scope that includes, at minimum:

- authenticated tenant or API-key principal;
- HTTP method;
- canonical route and API version;
- idempotency key;
- canonical request fingerprint.

The logical key for this review use case must be bound to the exact tuple:

`(repository_id, pull_request_number, head_sha, base_sha)`

A key must not collide across tenants, routes, or different logical review tuples.

The receiver must compute or validate a deterministic fingerprint of the canonical request payload. Reusing the same key with a different fingerprint must be rejected, not interpreted as a duplicate of the original request.

### 4.2 Atomic reservation before dispatch

The router must atomically create a durable reservation before any upstream provider call, combo iteration, account rotation, or billable operation begins.

A non-atomic sequence of “read key, then insert key” is insufficient. Concurrent duplicate requests must have exactly one reservation winner.

The reservation record must bind:

- tenant/principal scope;
- route and API version;
- idempotency key;
- canonical request fingerprint;
- unique router request/operation ID;
- creation time and retention deadline;
- state and schema version.

The receiver must persist the reservation strongly enough that a process restart or worker failover does not erase the uniqueness decision.

### 4.3 Duplicate request behavior

For the same scope, key, and request fingerprint:

- If the original request is in progress, the duplicate must not dispatch another provider request. The API must return a documented in-progress result or a stable operation handle.
- If the original request completed and its response is retained, the duplicate must return the same terminal result without another provider dispatch.
- If the original request is in an ambiguous state, the duplicate must return a documented UNKNOWN/in-progress response and must not start another provider attempt.

For the same scope and key but a different request fingerprint:

- Reject deterministically with a documented conflict response.
- Do not mutate the original reservation.
- Do not dispatch either payload again.

HTTP status codes alone are not sufficient evidence. The contract must specify response bodies, operation identifiers, and client interpretation.

### 4.4 Provider fallback and retry semantics

Router-level deduplication only prevents duplicate logical ingress handling. It does not automatically prevent multiple upstream provider attempts inside one accepted request.

The router must expose a machine-readable attempt record for each upstream dispatch, including:

- logical router request ID;
- provider/model identity (without credential values);
- attempt number and reason;
- whether dispatch began;
- whether the upstream accepted the request;
- whether a response was received;
- terminal or ambiguous disposition.

For billable chat inference, an ambiguous upstream outcome must not trigger an automatic second provider dispatch unless the router can prove the first provider did not accept the request, or the upstream provider itself provides a verified idempotency contract that is correctly applied.

Fallback on an explicit pre-acceptance rejection may be safe under a documented provider-specific rule. A timeout or connection loss after bytes may have reached the provider is not proof of non-acceptance.

The implementation must document which HTTP statuses and transport phases permit fallback. Generic “fallback on error” behavior is insufficient for an at-most-once provider-dispatch claim.

### 4.5 Retention and expiry

The router must document:

- reservation retention duration;
- response retention duration;
- behavior at and after expiry;
- whether retention survives deployment restarts and storage restoration;
- whether expiry can permit a duplicate dispatch.

Retention must exceed every client retry or replay window the system claims to support. For the scheduled reviewer, an expired receiver key must not silently authorize an automatic retry of an unresolved tuple. The separate durable attempt ledger remains authoritative for the automatic-dispatch policy.

### 4.6 Failure-state semantics

The receiver must distinguish at least:

- `REJECTED_BEFORE_DISPATCH` — proven no provider dispatch began;
- `IN_PROGRESS` — reservation exists and work is active;
- `COMPLETED` — terminal response is durably stored;
- `FAILED_SAFE_TO_RETRY` — only when non-acceptance is positively established by contract;
- `UNKNOWN` — provider acceptance or completion cannot be established.

A missing response, timeout, worker restart, or 5xx response must not be mapped to `FAILED_SAFE_TO_RETRY` without independent evidence.

## 5. Client policy until receiver support is proven

The reviewer must retain its current fail-closed behavior:

1. Do not automatically retry an ambiguous 9Router POST.
2. Do not interpret timeout, reset, or missing response as proof that no model was billed.
3. Do not publish a report without a valid response and the existing live-snapshot revalidation.
4. Keep the durable cross-run attempt-ledger gate from Finding 67 separate from router ingress idempotency.
5. Do not add an idempotency header unless the exact deployed chat endpoint's support is proven by source and black-box contract tests.
6. Do not claim at-most-once provider execution or exactly-once model execution.

A durable client-side reservation prevents the scheduled workflow from intentionally dispatching the same tuple again. Receiver-side atomic deduplication is an additional protection against duplicated ingress. Neither replaces the other.

## 6. Falsifiable acceptance matrix

| ID | Adversarial experiment | Required result |
|---|---|---|
| RX01 | Two concurrent POSTs with identical scope, key, and payload | One atomic reservation; no duplicate logical dispatch |
| RX02 | Duplicate arrives while first request is in progress | Stable in-progress response; no second provider dispatch |
| RX03 | Duplicate arrives after terminal completion | Same stored terminal result; no new provider dispatch |
| RX04 | Same key reused with a different payload fingerprint | Deterministic conflict; no new provider dispatch |
| RX05 | Same key used by a different tenant or API principal | No cross-tenant result leakage or deduplication collision |
| RX06 | Router crashes after reservation but before provider dispatch | Reservation survives; recovery does not create a second dispatch without a proven safe state |
| RX07 | Router crashes after provider acceptance but before client response | Duplicate client POST does not create a second provider dispatch |
| RX08 | Provider accepts request but response is lost | State is UNKNOWN unless the provider contract proves a safe retry; no blind fallback |
| RX09 | Model-combo first member fails before acceptance | Fallback follows a documented safe condition and records each provider attempt |
| RX10 | Model-combo first member may have accepted but response is lost | No second billable provider attempt without verified upstream idempotency |
| RX11 | Reservation store unavailable before acceptance | Fail closed before any provider dispatch |
| RX12 | Reservation store becomes unavailable after reservation | Preserve UNKNOWN; do not dispatch a duplicate logical request |
| RX13 | Reservation expires at retention boundary | Expiry behavior is deterministic and cannot silently re-arm an unresolved reviewer tuple |
| RX14 | Same key is replayed after process restart/deployment | Prior durable state is honored |
| RX15 | Intermediary repeats an identical POST | Router returns the original operation/result and records one logical ingress operation |
| RX16 | Router version is changed without re-running the contract suite | Capability status becomes UNKNOWN for the new version |

Every negative path must assert provider-dispatch count, not merely client Fetch invocation count. The test harness must record router ingress and upstream attempt counts independently.

## 7. Evidence required to change UNKNOWN

The chat idempotency claim may be upgraded only when all of the following are captured:

1. Exact deployed 9Router version, immutable source commit, and image/build digest.
2. The matching chat-completions handler and any idempotency middleware/storage implementation from that exact source revision.
3. A documented contract for header parsing, scope, fingerprint, atomicity, in-progress behavior, response replay, expiry, and error handling.
4. Automated RX01–RX16 results against the exact build, including parallel requests and crash/restart tests.
5. Provider-attempt telemetry proving the behavior under combo fallback and uncertain provider acceptance.
6. An independent review confirming that no test relied on a mock for the atomic uniqueness property.

A public feature in a different route or a newer unpinned branch is not sufficient. A successful happy-path POST is not sufficient. An HTTP response header alone is not sufficient.

## 8. Rollout and rollback boundary

No implementation, deployment, router configuration change, credential addition, API-key rotation, or production request is part of this design.

If an implementation is later authorized, it must first run against an isolated local or disposable router instance with synthetic provider adapters. A failed or unavailable receiver contract must leave the reviewer in dry-run/disabled dispatch mode. Rollback must disable automatic dispatch without deleting reservations or changing historical report comments.

## 9. Final disposition

- **Client redirect rejection:** PASS at the tested Fetch boundary.
- **Client-side automatic retry policy:** PASS as an explicit no-retry policy for ambiguous outcomes in the current path; does not cover unseen intermediaries.
- **Router chat idempotency:** UNKNOWN.
- **Router internal provider fallback multiplicity:** PROVISIONALLY SUPPORTED at the architecture level; exact deployed behavior UNKNOWN.
- **At-most-once provider dispatch:** NOT ESTABLISHED.
- **Exactly-once model execution:** NOT ESTABLISHED.
- **Scheduled reconciler inference:** BLOCKED until the durable ledger decision and all Finding 67 design gates are resolved.

No provider, external ledger, or permission model is selected by this document.
