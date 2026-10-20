# Master Brain — API contract v1 (Gate 1, first vertical slice)

Status: **TESTED (SCOPE-LIMITED)** schemas and validation only (`src/master_brain/api_contracts.py`, `tests/test_api_contracts.py`, golden files in `tests/golden/api_v1/`). There is **no server, no persistence layer and no authentication provider yet**; those are open decisions in `MASTER_BRAIN_PRODUCT_PLATFORM_ARCHITECTURE.md` §9 and are not guessed here. Requirement IDs: PLAT-001, OPS-001, MB-PLAT-004.

## Principles (frozen for v1)
1. **Identity comes from the session, never the body.** Requests are strict: any unknown field is rejected (`user_id`, `mission_id`, `approver_subject`, `approval_granted`, `state`, `role` …).
2. **Server-authoritative responses.** A client cannot invent status. `execution` distinguishes planning from execution (`not_started | started | unknown`; `unknown` when the audit history is inconsistent). `result_verification` is always `not_independently_verified` in v1: a dispatch response is not proof the effect occurred.
3. **Every state-changing request has an `idempotency_key`** (8–128 chars of `[A-Za-z0-9._:-]`). Replaying the same key with the same request returns the original outcome; reusing it with a different request is `conflict`.
4. **Errors are a closed set with fixed, client-safe messages**; internal reason text is never echoed. Unknown domain outcomes map to `outcome_unknown`, never to success.
5. **Audit view has no payload.** `AuditEventView` exposes only `event_id, event_type, recorded_at, actor, event_hash`; payload access is role-gated in a later gate.
6. Digests are 64-char lowercase hex SHA-256; timestamps are ISO-8601 with a UTC offset; text ≤ 4000 chars, no control characters (newline/tab allowed); arrays ≤ 50 items.

## Schemas
| Schema | Direction | Fields |
|---|---|---|
| `CreateMissionRequest` | in | `idempotency_key`, `objective`; optional `constraints[]`, `success_criteria[]`, `risk_tier` (low/medium/high/critical, default medium), `requires_approval` (bool, default false) |
| `MissionView` | out | `api_version, mission_id, objective, contract_schema_version, risk_tier, state, contract_digest, execution, approval_required, approval_status (not_required/required/granted), selected_islands[], clarification_questions[], anomalies[], result_verification` |
| `ApprovalChallengeRequest` | in | `contract_digest, signing_key_id, signature_alg`; optional `action_digest`, `expires_at` |
| `ApprovalChallenge` | out | `mission_id, contract_digest, approval_event_id, expires_at, action_digest, signing_message_hex` |
| `SubmitApprovalRequest` | in | `idempotency_key, approval_event_id, signing_key_id, signature_alg, signature_hex` |
| `AuditEventView` | out | see principle 5 |
| `ErrorResponse` | out | `{"api_version", "error": {code, message, retryable, correlation_id}}` |

`state` values are exactly `MissionState` (`unregistered, planned, approved, dispatch_unresolved, response_received, effect_reconciled, dispatch_failed_no_effect, inconsistent`). There is deliberately no `completed`/`verified`.

## Approval flow (two-phase, because the signature binds `event_id` and the payload incl. key id/alg; `recorded_at` is NOT signed, signature v2)
1. Client → `ApprovalChallengeRequest(contract_digest, …)`. The server compares `contract_digest` with the current contract (stale ⇒ `stale_contract`), takes the approver **from the authenticated session**, fixes `approval_event_id`, and returns the exact bytes to sign (`signing_message_hex`).
2. Client signs those bytes with its key and sends `SubmitApprovalRequest`. The server records the approval through `record_mission_approval` and verifies it through the configured verifier; HIGH/CRITICAL missions are refused without one.
3. Replay (same signed payload under another event id), wrong key/subject, revoked key, expired or already-consumed approval ⇒ `approval_invalid`; nothing executes.

## Error table (HTTP status is for a future transport; frozen now so clients can rely on it)
`invalid_request 400 · unauthenticated 401 · forbidden 403 · not_found 404 · conflict 409 · stale_contract 409 · approval_required 403 · approval_invalid 403 · clarification_required 422 · reconciliation_required 409 · duplicate_request 409 · dispatch_failed 502 · unavailable 503 (only retryable code) · outcome_unknown 500`.

Domain → API mapping (`error_from_execution_result`): every status `MissionExecutionResult` can return is mapped, and a test parses `mission_execution.py` so a new status cannot be added without a mapping. `rejected` is refined by reason text (first matching rule wins; unmatched ⇒ `forbidden`).

## Authorization requirements the server (Gate 2) must satisfy
- Authenticate every request; derive user and role from the session; check ownership/role per mission object.
- Fail closed when policy, the verifier, or audit persistence is unavailable (`unavailable`, nothing executed).
- No cross-user data exposure; client caches must be cleared on logout (client concern).

## Known limits / not done
- No transport, session model, rate limiting, persistence choice, or notifications.
- `MissionView.approval_status` must be derived by the server from the verified audit gate; the builder only checks consistency with the contract.
- Response parsing (`from_dict` for responses) is not provided; golden files pin the response shape instead.
- HTTP status choices for `outcome_unknown` (500) and `dispatch_failed` (502) should be revisited before Gate 2 ships.

## Gate 2a — local transport (implemented: `identity.py`, `mission_service.py`, `http_api.py`)
Stdlib only (no new dependency). Start: `make_server(MissionService(AuditStore(path)), StaticTokenAuthenticator({token: subject}))`; loopback by default (`allow_non_loopback=True` is explicit; there is no TLS here).

| Method + path | Success | Notes |
|---|---|---|
| `POST /v1/missions` | 201 created / 200 idempotent replay | same owner+`idempotency_key`+body ⇒ same mission; same key, different body ⇒ 409 `conflict` |
| `GET /v1/missions/{id}` | 200 `MissionView` | owner only; foreign and unknown ids are both 404 (no existence oracle) |
| `GET /v1/missions/{id}/audit` | 200 `{api_version, mission_id, events[]}` | payload-free events, owner only |

- Identity: `Authorization: Bearer <token>` only; checked **before** the body is read; never from body/headers. `mission_id = "mission-" + sha256(subject NUL key)[:16]`, so two users cannot collide.
- Intake: a mission without `success_criteria` is planned with a `clarification_questions` entry; creating a mission never executes anything (`state=planned`, `execution=not_started`). `approval_status` is `required` for approval-requiring missions and is never reported `granted` until Gate 2b derives it from the verified gate.
- The closed error set has no 405/411/413: wrong method or query string ⇒ 400 `invalid_request`; unknown route ⇒ 404; oversize (>64 KiB), chunked/missing/odd `Content-Length`, wrong `Content-Type`, invalid UTF-8/JSON, duplicate keys, NaN/Infinity ⇒ 400 `invalid_request`. Any audit/IO failure or unexpected exception ⇒ 503 `unavailable` with a fixed message (no internals).
- Every response: `X-Correlation-Id` (server generated), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; errors that leave an unread body (and 503) close the connection.
- **Not in 2a:** approval/execute endpoints (Gate 2b), TLS, rate limiting, a real auth provider/session store (Gate 2c; open decisions §9).
