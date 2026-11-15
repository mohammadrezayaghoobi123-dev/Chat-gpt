# Master Brain — Unified Write Execution Contract v2 (DRAFT)

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Status:** DRAFT — پیش‌نویس هنجاری برای بازبینی مستقل. چیزی پیاده، آزموده یا deploy نشده؛ همهٔ تست‌ها NOT_RUN.
**Authority:** تصمیم‌های D-01..D-14 (MB-G2P-R1) توسط مالک در 2026-11-15 «تأیید» شدند؛ این سند آن‌ها را به قاعدهٔ هنجاری تبدیل می‌کند. D-04 مشروط به نتیجهٔ R2 است.
**Supersedes (پس از تأیید):** پیش‌نویس 2K. **Scope:** `create_change_pr` (service-only v1، 2M).
واژگان: MUST/MUST NOT/SHOULD طبق RFC 2119. «UNVERIFIED» = فرضیه‌ای که آزموده نشده و نباید مبنای ادعا شود.

## 1. اصول
1. GitHub مرجع نهایی حالت منابع خارجی است؛ WriteControl فقط **قصد، فاز و شاهد** را نگه می‌دارد.
2. هیچ حالت UNKNOWN خودکار به SUCCEEDED/FAILED تبدیل نمی‌شود؛ فقط شاهد یکتا و مستند.
3. هیچ ادعای Exactly-Once وجود ندارد؛ هدف: at-most-once-dispatch-per-phase با ثبت قصد پیش از ارسال و recovery مبتنی بر شاهد.
4. همهٔ بررسی‌ها fail-closed: خطای خواندن policy/membership/quota/ساعت ⇒ رد پیش از هر اثر جانبی.

## 2. مالکیت (A)
| Aggregate | مالک | ممنوع |
|---|---|---|
| عضویت و policy | TenantDirectory | WriteControl نباید policy را کش یا بازنویسی کند (D-14) |
| چرخهٔ عمر عملیات نوشتن (reserve، فاز، UNKNOWN، audit، quota) | WriteControl (DO جداگانه، یک نمونهٔ منطقی در v1) | استفاده از outbox/ledger tasks |
| tasks/outbox orchestration | OrchestratorLedger | نگه‌داری وضعیت نوشتن خارجی |
| وضعیت منبع خارجی | GitHub | ادعای وضعیت GitHub بدون شاهد |

## 3. هویت و شناسه‌ها (C)
- `operation_key` = SHA-256 دنبالهٔ length-prefixed: `MB-WRITE-OP`, version, action, principal.type, principal.id, tenant, project, resource.type, owner(lowercase), repo(lowercase), client_idempotency_key.
- `request_digest` = SHA-256 canonical از: همهٔ فیلدهای ارسالی به GitHub — owner/repo، base_branch، title، **summary**، لیست مسیرها (case-sensitive، مرتب) با digest محتوا (D-06).
- همان scope+key+digest ⇒ replay (نتیجهٔ قبلی، پس از re-check مجوز؛ D-08). همان scope+key، digest متفاوت ⇒ `IDEMPOTENCY_CONFLICT`. tenant/principal متفاوت ⇒ رکورد مستقل؛ هیچ پاسخی بین scopeها نشت نمی‌کند؛ خواندن با فقط hash کلید MUST NOT مجاز باشد.
- `operation_id` پایدار و مستقل از shard فیزیکی.
- شاخه (D-02): `assistant/` + ۱۶ نویسهٔ hex اول از `SHA-256("MB-WRITE-BRANCH"‖operation_id)`؛ در رکورد، **پیش از** `BRANCH_DISPATCHED` ذخیره می‌شود. تصادم با عملیات دیگر ⇒ رد.
- Marker (D-03): `operation_id` و `request_digest` غیرحساس در trailer پیام commit و بدنهٔ PR.

## 4. Authorization (D)
- Policy برای action های نوشتنی: فقط digest دقیق SHA-256؛ `*` رد می‌شود (D-01) و rule های `*` موجود با migration غیرفعال + audit می‌شوند. نبود rule/membership ⇒ deny.
- Decision record (D-05) در تراکنش admission: request_digest، tenant، principal، project، action، resource_digest، membership_version، policy_version، rule_decision_id، زمان DO.
- Re-check تازه (D-08): در replay، ادامهٔ UNKNOWN، و **پیش از هر** `*_DISPATCHED`. نقطهٔ linearization = commit فاز `*_DISPATCHED`. revoke پس از آن، درخواست ارسال‌شده را لغو نمی‌کند → ریسک باقیمانده MUST در release notes ثبت شود.
- cross-DO اتمیک نیست؛ ادعای آن ممنوع.

## 5. ماشین حالت و lease (B, E)
فازها: `RESERVED → TREE_DISPATCHED → TREE_WRITTEN → COMMIT_DISPATCHED → COMMIT_WRITTEN → BRANCH_DISPATCHED → BRANCH_WRITTEN → PR_DISPATCHED → PR_CREATED`؛ وضعیت‌ها: IN_PROGRESS, UNKNOWN, SUCCEEDED, FAILED.
1. **Admission (یک `transactionSync` در WriteControl):** اعتبار scope، یکتایی idempotency، شمارنده‌های quota (D-13)، reserve + lease generation اولیه، decision record، رویداد audit اولیه. هر شکست ⇒ rollback و هیچ dispatch.
2. **Dispatch:** فاز `*_DISPATCHED` (با dispatch_attempt_id) commit می‌شود، سپس فراخوانی GitHub **خارج** تراکنش، سپس `*_WRITTEN` در تراکنش جدا.
3. هر transition: CAS روی (operation_id، فاز قبلی، lease_holder، lease_generation)؛ generation قدیمی ⇒ `STALE_LEASE` (hard fence).
4. **ساعت (D-07):** تمام زمان‌ها فقط `Date.now()` داخل DO؛ هیچ `now` از فراخواننده پذیرفته نمی‌شود.
5. Crash/timeout/ابهام پس از `*_DISPATCHED` ⇒ UNKNOWN. پیش‌فرض: ارسال مجدد ممنوع.
6. D-04 (UNVERIFIED تا R2): اگر آزمایش ثابت کند tree/commit با date ثابت قطعی/تکرارپذیرند، بازتولید آن دو مرحله مجاز می‌شود؛ ref و PR فقط با GET + marker تشخیص داده می‌شوند.

## 6. UNKNOWN و reconciliation (F)
- Reconcile قابلیت جداگانه است (نه `project.create_pr`): تأیید هویت و credential فعال، re-check membership/policy، داشتن capability، فقط‌خواندن از GitHub.
- تطبیق دقیق: repo، base، شاخهٔ قطعی، commit/tree، marker، request_digest. ثبت: منبع شاهد، زمان مشاهده، شناسه‌های خارجی، digest شاهد، هویت reconciler، تصمیم.
- شاهد ناقص/متناقض/کهنه/غیریکتا ⇒ UNKNOWN می‌ماند. cleanup خودکار شاخه/commit/PR ممنوع (D-09)؛ رکورد ORPHAN نگه‌داری می‌شود.
- UNKNOWN/IN_PROGRESS هرگز prune نمی‌شود؛ سقف تعداد UNKNOWN (پارامتر، D-10/D-13)؛ رسیدن به سقف ⇒ رد admission.

## 7. Retention (D-10)
Terminal: نتیجه برای پنجرهٔ idempotency (پارامتر؛ عدد انتخاب نشده). پس از انقضا: فقط fingerprint تا پایان پنجرهٔ audit؛ replay ⇒ `IDEMPOTENCY_EXPIRED` (نه اجرای دوباره). migration فقط additive با rollback و آزمون.

## 8. Quota (G, D-13)
ابعاد: tenant، principal، repository، سراسری (emergency ceiling مستقل)، UNKNOWN. اعداد MUST از اندازه‌گیری/بودجه انتخاب شوند؛ **مقدار تنظیم‌نشده ⇒ admission بسته**. DO واحد در v1 فقط با طرح ظرفیت (peak، حداکثر UNKNOWN، blast radius) پذیرفته می‌شود؛ sharding بعدی نیازمند کلید پارتیشن نسخه‌دار، مهاجرت، و سقف سراسری با هماهنگی صریح است.

## 9. هویت سرویس (H, D-12)
principal نوع service فقط؛ هیچ انتساب انسانی. context شامل credential_id/version غیرسری. رویه‌های صدور، نگهداری، rotation، انقضا/هم‌پوشانی، revocation، emergency-disable مستند و بدون افشای secret. محدودیت «عدم انتساب به انسان» صریحاً در audit و PR body ذکر می‌شود.

## 10. Audit (I, D-11)
رویداد برای: admission، هر فاز، تصمیم authorization، UNKNOWN، reconcile، تغییر policy/membership. زنجیرهٔ hash (`previous_hash`/`event_hash`). ادعای tamper-proof ممنوع؛ anchoring/trusted timestamp خارجی = مرحلهٔ بعد. Secret هرگز لاگ نمی‌شود.

## 11. کدهای خطا
`IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_EXPIRED`, `STALE_LEASE`, `AUTHORIZATION_DENIED`, `AUTHORIZATION_UNAVAILABLE`, `QUOTA_EXCEEDED`, `QUOTA_UNCONFIGURED`, `OPERATION_UNKNOWN`, `RECONCILE_EVIDENCE_INSUFFICIENT`, `BRANCH_COLLISION`.

## 12. نگاشت به تست (همه NOT_RUN)
T-01/02 → §4 · T-03/04 → §3 · T-05/06 → §3,§5 · T-07 → §4 · T-08 → §5 · T-09/10/11 → §5–6 · T-12 → §5.1 · T-13 → §8 · T-14 → §7 · T-15 → §10.

## 13. وضعیت باز
R2 (رفتار GitHub)، اعداد quota، طرح ظرفیت DO، رویهٔ credential، نیاز به anchoring، سیاست cleanup آتی. تا بسته‌شدن، پیاده‌سازی و release ممنوع.
