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
`invalid_request 400 · unauthenticated 401 · forbidden 403 · not_found 404 · conflict 409 · stale_contract 409 · approval_required 403 · approval_invalid 403 · clarification_required 422 · reconciliation_required 409 · duplicate_request 409 · dispatch_failed 502 · unavailable 503 (retryable) · outcome_unknown 500 · rate_limited 429 (retryable)`.

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
- **Not in 2a:** approval/execute endpoints (approval: 2b-1 below; execution: 2b-2), TLS, rate limiting, a real auth provider/session store (Gate 2c; open decisions §9).

## Gate 2b-1 — approvals over the API (implemented)
| Method + path | Success | Notes |
|---|---|---|
| `POST /v1/missions/{id}/approval-challenges` | 201 `ApprovalChallenge` | body: `contract_digest, signing_key_id, signature_alg`, optional `action_digest, expires_at` |
| `POST /v1/missions/{id}/approvals` | 201 recorded / 200 replay → `MissionView` | body: `idempotency_key, approval_event_id, signing_key_id, signature_alg, signature_hex` |

- The approver is **always the session identity**; there is no approver field. An approval over the API exists only as a signature by a key the configured `ApprovalVerifier` has bound to that subject. **Without a verifier the server accepts no approvals** (503; nothing written).
- Challenge: stale `contract_digest` ⇒ 409 `stale_contract`; a mission that needs no approval ⇒ 409 `conflict`; the server fixes `approval_event_id` (random) and, when the client gives no `expires_at`, a 1-hour expiry (max 7 days, never in the past). The challenge is persisted as audit event `mission.approval_challenged`; it grants nothing.
- Submit: signature is verified **before** anything is written, so a bad signature (wrong key, other subject, tampered, verifier error) ⇒ 403 `approval_invalid` and leaves no trace; the challenge stays usable until its expiry (rate limiting is Gate 2c). Key id/algorithm must equal the challenge's. A challenge belongs to its requester (others get 404). Replay of the same signature ⇒ 200 with the same view; a different signature for an already-approved challenge ⇒ 409. `idempotency_key` is validated but the challenge's `approval_event_id` is the effective idempotency key.
- `approval_status` is `granted` **only** if a recorded approval passes the real execution gate with the configured verifier (authenticated, unexpired, bound to this contract digest, action binding satisfied) and — for action-bound approvals — is not yet consumed by a dispatch. Otherwise `required`. It lapses back to `required` on expiry, key revocation, or consumption. Note: pending clarification also keeps the gate (and so the status) at `required`.

## Gate 2b-2 — controlled execution (implemented: `task_catalog.py`, `MissionService.execute_mission/get_result`)
| Method + path | Success | Notes |
|---|---|---|
| `GET /v1/tasks` | 200 `{tasks[]}` | `task_id, description, action_digest, risk_level, limitations`; `[]` when execution is not configured |
| `POST /v1/missions/{id}/executions` | 201 `ResultView` | body: `idempotency_key, task_id` only — never an adapter, integration or payload |
| `GET /v1/missions/{id}/result` | 200 `ResultView` | `state, execution, attempts[], result_verification, notes[]` |

- **Operator-defined catalogue.** The client can only choose a `task_id` from `GET /v1/tasks`; the server executes exactly that (integration, payload) pair. `action_digest` is the digest an approver must bind (`approval-challenges.action_digest`), so "approve this action" is verifiable: approval for another task's digest never authorises this one.
- **Approval.** Missions that need approval run only with a recorded, signed, unexpired, unconsumed approval bound to this task's digest (otherwise 403 `approval_required`); the approval is consumed atomically by the dispatch (second run needs a fresh one). Clarification pending ⇒ 422. Registry-level duplicates (same key, or same intent under a new key) never re-run the task (409).
- **Results.** After a successful dispatch the (bounded, policy-screened) output is stored as audit event `mission.result_recorded` with its SHA-256; a reload returns the same `ResultView`. Output that is too large or looks like a secret is **withheld** (`output: null`) while the dispatch outcome stays honest. Free-text adapter reasons are never exposed. `result_verification` is always `not_independently_verified`; `external_effect_confirmed` is true only after a reconciliation with evidence.
- **Unknown outcomes.** Adapter exception/timeout/audit gap ⇒ the attempt stays `unresolved` (mission state `dispatch_unresolved`), response is `outcome_unknown` (HTTP 500, `retryable:false`, fixed message) and any further dispatch is refused (409 `reconciliation_required`) until reconciled. **HTTP-code decision (closes the open item):** 500 is kept for `outcome_unknown` and 502 for `dispatch_failed`. Rationale: the code is part of the frozen contract (golden-tested); `retryable` is the machine-readable retry signal, not the HTTP class; and a retry cannot cause a second dispatch (same key ⇒ 409 `duplicate_request`, new key ⇒ 409 `reconciliation_required`) — a test proves the adapter is invoked once.
- Not in 2b-2: reconciliation endpoint (needs an operator role distinct from the mission owner — an owner clearing their own unknown outcome would be self-attestation), asynchronous/background execution, real (non-offline) integrations.

## Gate 2b-3 — operator role and reconciliation (implemented)
| Method + path | Success | Notes |
|---|---|---|
| `POST /v1/missions/{id}/reconciliations` | 201 recorded / 200 replay → `ResultView` | body: `idempotency_key, attempt_id, resolution (effect_occurred \| effect_did_not_occur), evidence_ref (≤500 chars)` |

- **Roles.** `Identity` now has a closed `roles` set (`operator` only). The auth seam supplies it (`StaticTokenAuthenticator({token: (subject, ("operator",))})`); a request body can never grant a role.
- **Separation of duties (root fix for the unknown-outcome dead end).** Previously an unresolved attempt could only be cleared by writing to the log directly. Now only an **operator** may reconcile, and **never the mission's own owner** (an owner clearing their own unknown outcome would be self-attestation): owner/non-operator ⇒ 403 `forbidden`; someone with no relation to the mission ⇒ 404 (no existence oracle); an operator who owns the mission ⇒ 403.
- **Operator access is deliberately narrow:** read `GET …/result` and `GET …/audit` of any mission (needed to find the attempt) plus reconcile. Operators cannot read the mission view, execute, or request/submit approvals for missions they do not own (404).
- **Semantics.** The claim is recorded as `mission.dispatch_reconciled` with the **operator's identity** as actor. Only an attempt that is really unresolved can be reconciled (unknown/already-resolved ⇒ 409 `conflict`). Identical replay ⇒ 200 (also under concurrent submission); a different claim for the same attempt ⇒ 409. `effect_occurred` sets `external_effect_confirmed=true` and state `effect_reconciled`; `effect_did_not_occur` does not confirm anything. After either, the mission is unblocked for a new dispatch. **It remains an operator's assertion with an evidence reference: `result_verification` stays `not_independently_verified`.** Secret-like evidence text is refused by the audit policy (400) and not stored.

## Gate 3a — وب‌کلاینت (`/app/`)
- سرو فقط‌خواندنی و بدون احراز: `GET /app/`, `/app/app.js`, `/app/app.css`, `/app/strings.json` (فایل‌های ثابت بدون هیچ دادهٔ ماموریت). روش‌های دیگر ⇒ `invalid_request`، مسیرهای دیگر ⇒ `not_found`، query ⇒ `invalid_request`. `GET /` همچنان `not_found` است.
- سرصدها: CSP سخت (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)، `X-Frame-Options: DENY`، `Referrer-Policy: no-referrer`، `nosniff`، `no-store`.
- کلاینت هیچ حقیقتی نمی‌سازد: همهٔ مقادیر از API می‌آیند؛ مقدار ناشناخته به‌صورت «مقدار ناشناخته (خام)» نشان داده می‌شود؛ برچسب راستی‌آزمایی فقط از فیلد سرور.

## Gate 2c-1 — محدودیت نرخ (`rate_limited`، 429)
- کد جدید و بستهٔ خطا: `rate_limited` ⇒ HTTP 429 با هدر `Retry-After` (ثانیهٔ صحیح، رو به بالا، حداقل ۱). مثل `unavailable` قابل‌تکرار است، چون رد پیش از هر کاری رخ می‌دهد (بدنه خوانده نمی‌شود، چیزی ثبت یا اجرا نمی‌شود). تلاش دوباره با همان `idempotency_key` بی‌خطر است.
- دو سد مستقل (ماژول `rate_limit.py`، ساعت تزریقی، حافظهٔ کران‌دار با حذف کم‌استفاده‌ترین): ۱) **ضدِ حدس‌زدن نشانه**: ورود ناموفق به‌ازای نشانی کلاینت در پنجرهٔ لغزان (پیش‌فرض ۲۰ در ۶۰ ثانیه)؛ پس از رسیدن به حد، همهٔ تلاش‌ها از آن نشانی، **حتی با نشانهٔ درست**، تا لغزیدن پنجره رد می‌شود (بدون oracle). ۲) **سطل توکن به‌ازای هویت**: پیش‌فرض ۲۰ درخواست در ثانیه، انفجار ۱۲۰.
- فایل‌های ثابت `/app/` از سطل هویت کم نمی‌کنند (عمومی و بدون داده).
- حدود شناخته‌شده: حافظهٔ فرایند (با راه‌اندازی دوباره صفر می‌شود)؛ نشانی کلاینت همان همتای TCP است (`X-Forwarded-For` عمداً قابل‌اعتماد نیست؛ پشت پراکسی همه یک نشانی‌اند)؛ مهاجم با نشانی‌های بسیار زیاد به‌ازای نشانی کند نمی‌شود؛ قفل‌شدنِ کاربر مشروع پشت NAT مشترک با مهاجم، بده‌بستان آگاهانه است.

## Gate 2c-2 — حساب محلی و نشست امن (`/v1/session`)
فعال فقط وقتی `make_server(..., accounts=AccountStore(...))` داده شود؛ وگرنه این مسیرها `not_found` هستند. احراز با `ChainAuthenticator(static, SessionAuthenticator(accounts))`.

| درخواست | رفتار |
|---|---|
| `POST /v1/session` `{subject, password}` | ورود (عمومی). موفق ⇒ 201 + بدنهٔ `SessionView` (`subject, roles, expires_at, idle_timeout_seconds`) و `Set-Cookie: mb_session=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` (+`Secure` با `secure_cookies=True`). **توکن هرگز در بدنه نیست.** هر شکست (ناشناخته/غیرفعال/گذرواژهٔ غلط) ⇒ 401 یکسان. |
| `GET /v1/session` | هویت و انقضای نشست جاری؛ برای توکن ثابت (بدون نشست) ⇒ 404. |
| `DELETE /v1/session` | خروج: نشست در سرور باطل و کوکی پاک (`Max-Age=0`). |

- **حساب‌ها:** بدون ثبت‌نام عمومی. اپراتور با `python -m master_brain.accounts --db … add|passwd|disable|enable --subject … [--operator] [--password-stdin]` می‌سازد (گذرواژه هرگز در argv). نقش‌ها فقط از حساب می‌آیند و **در هر درخواست** دوباره خوانده می‌شوند؛ لغو نقش/غیرفعال‌سازی/تغییر گذرواژه فوراً اثر می‌کند.
- **گذرواژه:** `scrypt` (N=2^14, r=8, p=1، نمک ۱۶ بایتی تصادفی، رکورد خود‌توصیف). سیاست: ۱۲ تا ۲۵۶ نویسه، ≥۵ نویسهٔ متمایز، برابر نام‌کاربری نباشد. ورود با حساب ناشناخته/غیرفعال هم یک هش می‌پردازد (بدون oracle زمانی/پاسخی).
- **نشست:** توکن ۲۵۶ بیتی تصادفی؛ فقط SHA-256 آن ذخیره می‌شود؛ بیکاری ۳۰ دقیقه، عمر مطلق ۸ ساعت (با فعالیت تمدید نمی‌شود)، حداکثر ۱۰ نشست به‌ازای هر حساب.
- **CSRF:** درخواست تغییردهنده‌ای که با کوکی احراز شده باید `Origin` هم‌مبدأ (`http(s)://<Host>`) داشته باشد وگرنه 403 `forbidden`؛ ورود با `Origin` بیگانه هم 403. توکن‌های `Authorization: Bearer` محیطی نیستند و نیازی ندارند. هدر `Authorization` (حتی نادرست) بر کوکی مقدم است.
- **DNS-rebinding:** هدر `Host` هر درخواست (شامل `/app/`) باید در `allowed_hosts` باشد (پیش‌فرض `127.0.0.1:<port>` و `localhost:<port>`)؛ bind غیرحلقه‌ای **بدون فهرست صریح** خطای شروع می‌دهد.
- **سد ضدِ حدس‌زدن:** علاوه بر سد نشانیِ Gate 2c-1، شکست ورود به‌ازای *حساب* هم شمرده می‌شود (پیش‌فرض ۲۰ در ۱۰ دقیقه؛ مهاجم توزیع‌شده یک حساب را نمی‌تواند حدس بزند). بده‌بستان: مهاجم می‌تواند حساب قربانی را موقتاً قفل کند (۴۲۹)؛ پذیرفته‌شده و مستند.

## Gate 2c-3 — تأییدکنندهٔ تعیین‌شده (`approvers.py`، `GET /v1/approvals`)
**تصمیم مالک پروژه:** تأیید یک ماموریت پرریسک وظیفهٔ جداگانه است و فقط «تأییدکنندهٔ تعیین‌شده» می‌تواند بدهد؛ ماموریت‌ساز بودن به‌تنهایی کافی نیست. مالک ماموریت از تأیید خودش منع نشده است (اگر تنها تأییدکننده هم باشد، باید بتواند ماموریت خودش را تأیید کند).

- **سیاست:** `MissionService(..., approvers=ApproverPolicy)`. پیش‌فرض `NoApprovers` ⇒ **هیچ‌کس تأیید نمی‌دهد** (بسته‌به‌طور‌پیش‌فرض). پیاده‌سازی‌ها: `StaticApprovers({...})` (فهرست ثابت)، `AccountApprovers(accounts)` (حساب فعال دارای نقش `approver`، در هر فراخوانی دوباره خوانده می‌شود).
- **دو بار بررسی از یک منبع حقیقت:** (۱) هنگام `approval-challenges` و `approvals` فراخواننده باید همان لحظه تأییدکننده باشد؛ (۲) هنگام قضاوت دربارهٔ تأییدهای ثبت‌شده (اجرا و `approval_status`) فقط تأییدی شمرده می‌شود که تأییدکنندهٔ آن **هنوز** تأییدکننده است. لغو نقش، تأییدهای استفاده‌نشدهٔ او را بی‌اثر می‌کند.
- **کدهای خطا:** مالکِ غیرتأییدکننده ⇒ 403 `forbidden`؛ غریبه (نه مالک، نه تأییدکننده) و ماموریت ناشناخته ⇒ 404 `not_found` (بدون oracle وجود). فقط صادرکنندهٔ challenge می‌تواند آن را ثبت کند.
- **دسترسی تأییدکننده:** `GET /v1/missions/{id}` را می‌بیند (باید ببیند چه چیزی را تأیید می‌کند)، ولی `audit` و `result` را نه (حداقل دسترسی). اجرا فقط برای مالک است.
- **`GET /v1/approvals`** (فقط تأییدکننده؛ وگرنه 403): `{api_version, missions: [MissionView…]}`؛ ماموریت‌هایی که تأیید لازم دارند، تأیید معتبری ندارند و هنوز اجرا نشده‌اند؛ جدیدترین اول، حداکثر ۱۰۰. هر عضو همان `MissionView` موجود است (golden جدید لازم نبود).
- **وضعیت صادق:** اگر تأییدی ثبت شده ولی دیگر نمی‌شمارد (نقش لغو شد)، `state` دیگر `approved` نشان داده نمی‌شود بلکه `planned` است و `approval_status=required` (پیش‌تر `state` فقط به وجود رویداد نگاه می‌کرد).
- **حساب‌ها:** `python -m master_brain.accounts --db … add --subject … --approver` و `roles --subject … [--operator] [--approver]` (نقش‌ها را **دقیقاً** همین‌ها قرار می‌دهد؛ بدون گزینه ⇒ حذف همهٔ نقش‌ها).
- **وب‌کلاینت:** بخش «در انتظار تأیید شما» فقط برای تأییدکننده؛ حساب غیرتأییدکننده یادداشت «فقط تأییدکنندهٔ تعیین‌شده…» می‌بیند و فرم challenge پنهان است. فرم challenge اکنون **کار مشخص** را هم انتخاب می‌کند (`action_digest`) و برای ریسک بالا/بحرانی بدون آن ارسال نمی‌شود.

## Gate 2c-4 — لاگ امنیتی زنجیره‌ای (`security_log.py`)
لاگ جدا از ممیزی ماموریت‌ها، با همان موتور `AuditStore` (زنجیرهٔ هش، لنگر سر زنجیر، قفل، بدون پس‌تاریخ، فهرست مجاز کلیدها و غربال رازها). به‌صورت پیش‌فرض کنار پایگاه حساب‌ها: `<نام>.security.jsonl`. **هیچ مسیر HTTP برای خواندن آن وجود ندارد** (فقط ابزار اپراتور).

| رویداد | چه وقت | محتوا |
|---|---|---|
| `security.login_succeeded` | ورود موفق (**پیش از** ساخت نشست) | `address` |
| `security.login_failed` | گذرواژهٔ غلط/حساب ناشناخته یا غیرفعال | `address`, `reason=bad_credentials` |
| `security.login_throttled` | رد شدن با ۴۲۹ | `address`, `scope=address|account` |
| `security.logout` | خروج | `address` |
| `security.account_changed` | ساخت/نقش/غیرفعال/فعال/تغییر گذرواژه (**پیش از** اعمال) | `change`, `roles` (فقط برای ساخت و تنظیم نقش) |
| `security.events_suppressed` | خلاصهٔ رویدادهای حذف‌شده با سقف | `count`, `window_seconds` |

- **قاعده برای آنچه قدرت می‌دهد (fail closed):** اگر رویداد نوشته نشود، ورود رد می‌شود (`unavailable`) و تغییر حساب اعمال نمی‌شود. خروج هرگز منتظر لاگ نمی‌ماند (نیت کاربر برای خروج مهم‌تر است).
- **قاعده برای آنچه فقط ردّ را ثبت می‌کند (best effort):** شکست ورود و throttle را هر کسی می‌تواند تولید کند؛ پس سقف ۶۰ رویداد در هر پنجرهٔ ۶۰ ثانیه دارد و مازاد در یک رویداد `events_suppressed` شمرده می‌شود (مهاجم نمی‌تواند دیسک را پر کند یا لاگ را کند کند).
- **ورودی مهاجم هرگز خام ذخیره نمی‌شود:** نام حساب فقط اگر نحو معتبر داشته باشد، وگرنه `account:invalid`؛ نشانی فقط اگر الگوی نشانی باشد، وگرنه `unknown`؛ **واژگان بسته** (`change`، `scope`، `reason`، نقش‌ها) هنگام نوشتن اجبار می‌شود و مقدار بیرون از آن رد می‌شود. گذرواژه/توکن/کوکی هرگز نوشته نمی‌شود (تست).
- **اپراتور:** `python -m master_brain.security_log --path … verify` (زنجیره و لنگر؛ خروجی ≠ ۰ در دست‌کاری، حذف از انتها یا فایل ناموجود) و `tail [--count N]` (فقط اگر کل لاگ درست تأیید شود). عاملِ تغییر حساب در CLI: `operator:<کاربر سیستم‌عامل>` (CLI ورود جدا ندارد).

## Gate 2d-1 — بازیابی بعد از قطعی: دمِ نیمه‌نوشتهٔ لاگ (`audit_recovery.py`)
اگر فرایند وسط `append` کشته شود، آخرین خطِ لاگ ممکن است بدون newline بماند. `AuditStore` عمداً چنین لاگی را رد می‌کند (هرگز خودکار ترمیم نمی‌کند)، پس **همهٔ** درخواست‌ها `unavailable` (۵۰۳) می‌شوند تا اپراتور دخالت کند. راه صریح: `python -m master_brain.audit_recovery --path <لاگ>` (پیش‌فرض dry-run؛ `--apply` برای اجرا). کار می‌کند روی لاگ ماموریت‌ها و لاگ امنیتی.
- **فقط وقتی عمل می‌کند** که همهٔ رکوردهای کامل پیش از دم با قواعد واقعی (زنجیره و لنگر) تأیید شوند؛ لاگِ دست‌کاری‌شده، کوتاه‌شده (کوتاه‌تر از لنگر) یا خراب در میانه **رد** می‌شود و چیزی تغییر نمی‌کند. دمِ بیش از ۱ MiB رد می‌شود.
- **شواهد حذف نمی‌شود:** بایت‌های کنارگذاشته در `<لاگ>.torn-<UTC>-<sha>.bin` (ساخت انحصاری؛ هرگز رونویسی) ذخیره می‌شود؛ خود بازیابی با رویداد `audit.tail_recovered` (چه کسی، چند بایت، sha256) در زنجیره ثبت می‌شود؛ در طول کار قفل نویسنده نگه داشته می‌شود.
- **چرا حذف دم ایمن است:** `append` رکورد+newline را می‌نویسد و فقط بعد لنگر را به‌روز می‌کند و برمی‌گردد؛ رکوردِ بی‌newline هرگز به هیچ فراخواننده‌ای تأیید نشده است. (قطعیِ بین نوشتن رکورد و به‌روزرسانی لنگر نیازی به بازیابی ندارد؛ لاگِ بلندتر از لنگر پذیرفته می‌شود.)

## Gate 2d-2 — نقطهٔ ورود اجرایی (`python -m master_brain.serve`)
```
python -m master_brain.accounts --db DIR/accounts.sqlite add --subject user:you --approver --password-stdin
python -m master_brain.serve --data-dir DIR [--port 8765] [--approval-keys KEYS.json] [--demo-echo-task]
# سپس: http://127.0.0.1:8765/app/
```
- **همه‌چیز زیر یک پوشهٔ داده** (ساخت با مجوز `0700`): `audit.jsonl`، `accounts.sqlite` + `accounts.security.jsonl`، `registry.sqlite`.
- **شروع fail-closed** (کد خروج ۲ و دلیل): پوشه‌ای که کاربران دیگر به آن راه دارند؛ لاگ ناخوانا/دست‌کاری‌شده؛ فایل کلید ناقص یا قابل‌نوشتن توسط گروه/دیگران. دمِ نیمه‌نوشته (قطعی) هم رد می‌شود **با اشاره به ابزار بازیابی**؛ سرور هرگز خودش تاریخچه را ترمیم نمی‌کند.
- **احراز هویت فقط حساب محلی + نشست** (در نمونهٔ سرو‌شده توکن ایستا وجود ندارد). تأییدکننده = حسابِ دارای نقش `approver`.
- **کلیدهای تأیید:** `{"keys":[{"key_id","subject","public_key_hex"}]}` فقط کلید **عمومی** Ed25519 (۶۴ نویسهٔ hex)، حداکثر ۱۰۰، فقط همین سه فیلد، هر کلید به یک موضوع گره خورده؛ فقط هنگام شروع بارگیری می‌شود (تغییر = restart). بدون این فایل هیچ تأییدی ثبت نمی‌شود (هشدار چاپ می‌شود). کلید خصوصی هرگز اینجا نمی‌آید.
- **اجرا:** بدون `--demo-echo-task` هیچ کاری اجرا نمی‌شود؛ با آن، یک کار آفلاین (`echo`، محدودیت «offline only») ثبت می‌شود. تلفیق واقعی گام جدا و بازبینی‌شده است.
- **شبکه:** پیش‌فرض loopback. غیرحلقه‌ای نیازمند `--allow-non-loopback` و `--allowed-host` (ضد DNS-rebinding) است؛ TLS اینجا پایان نمی‌یابد (پراکسی جلوی آن + `--secure-cookies`). `SIGTERM/SIGINT` ⇒ توقف تمیز.
