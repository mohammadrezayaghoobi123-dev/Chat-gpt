# Master Brain — Gate 2O-C: بازبینی مستقل خصمانه (WriteControl / Unified Write Execution)

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Review ID:** MB-G2O-C-2026-11-15 · **نوع:** فقط‌خواندنی (بدون تغییر کد/تنظیمات/secret/deploy/PR/merge) · **اجرای تست:** هیچ تستی اجرا نشد؛ همه موارد اجرایی `NOT_RUN`

---

## 1. Snapshot identity and provenance verification

| مورد | مقدار مورد انتظار | مشاهده‌شده | نتیجه |
|---|---|---|---|
| شاخه | `integration/master-brain-unification-2026-11-15` | ref موجود (`origin/uni2` در clone محلی) | MATCH |
| Commit هدف | `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` | head دقیقاً همین | MATCH |
| main | `919b19ca3d3887352cdef06b03c668ead04fbce7` | همین | MATCH |
| رابطه | — | ۲۱ commit جلوتر، ۰ عقب‌تر | — |
| تغییر نسبت به main | — | ۲۰ فایل، همه `docs/*.md`، ۴۲۵۲+ خط؛ **صفر فایل غیرمستند** | کد = کد main |

**پنج blob پین‌شده (Gate 2O-B):** هر پنج با جدول Gate 2O-B برابر است و با main یکسان است (`worker.js`, `orchestrator-ledger.js`, `identity/tenant-directory.js`, `identity/tenant-context.js`, `wrangler.toml`). هیچ mismatch گزارش نمی‌شود.

**Provenance:** تفاوت SHA اسناد بین مراحل به‌تنهایی نقص تلقی نشد. هشت سند اصلی از همین snapshot خوانده شد (2K, 2L, 2M, 2N، ADR، brief، 2O-A، 2O-B؛ 2J نیز برای زمینه). **محدودیت‌های ممیزی (صادقانه):** metadata/CI مربوط به PRهای Chat-gpt قابل دریافت نبود (`NOT_VERIFIED`)؛ فایل‌های جانبی ledger (`orchestrator-worker-identity.js`, `orchestrator-reconciliation-evidence.js`) در blobهای پین‌شده نیستند و بررسی نشدند؛ بخش‌هایی از `orchestrator-ledger.js` (۱۰۳KB) با grep هدفمند و خواندن بخش‌های کلیدی بررسی شد نه خط‌به‌خط.

**نکتهٔ حیاتی:** WriteControl در هیچ کدی روی main یا این snapshot وجود ندارد (`git grep` نتیجهٔ خالی). یعنی هر ادعای «پیاده‌شده» دربارهٔ WriteControl نادرست است؛ فقط طراحی است.

---

## 2. Executive verdict

# **BLOCKED**

- **جهت معماری** (WriteControl مستقل، DO واحد برای v1، TenantDirectory به‌عنوان مرجع policy، GitHub به‌عنوان مرجع حقیقت): **PROVISIONALLY SUPPORTED**. اسناد با خودشان صادق‌اند (همه draft/NOT_RUN، blockerها صریحاً باز).
- **قرارداد Unified Write Execution** هنوز قابل freeze نیست: چند خلأ *طراحی* (نه فقط پیاده‌سازی) پیدا شد (بخش ۳: F-04, F-05, F-06, F-09).
- **پیاده‌سازی:** مسیر نوشتن واقعی (`createChangePr`) هیچ‌یک از الزامات قرارداد را ندارد؛ هیچ تست مرتبط اجرا یا شاهد داده نشده.
- **امنیت اجرایی کنونی:** wildcard allow در کد پذیرفته می‌شود (F-02) → حتی بدون WriteControl، مسیر فعلی با یک rule گسترده قابل سوءاستفاده است.

**چرا REJECT نه:** هیچ تناقض بنیادی که جهت معماری را باطل کند پیدا نشد؛ مشکلات قابل‌رفع و عمدتاً توسط خود اسناد پیش‌بینی شده‌اند.
**چرا CONDITIONAL نه:** شرط‌ها فقط سندی نیستند؛ کل لایهٔ اجرایی و شواهد تست غایب است، و خلأهای طراحی جدید یافت شد.

**شواهدی که حکم را تغییر می‌دهند:**
- به **CONDITIONAL**: (۱) بستن F-04/F-05/F-06/F-09 در قرارداد (نسخهٔ جدید + بازبینی مستقل)، (۲) تصمیم صریح و مکتوب برای open decisions بخش ۸ (credential authority، clock، branch determinism، quota numbers)، (۳) تصمیم دربارهٔ wildcard (F-02) با کد/تست نه فقط سند.
- به **PROVISIONALLY ACCEPTED**: علاوه بر بالا، پیاده‌سازی staging-only پشت feature flag + اجرای واقعی ماتریس تست بخش ۶ (tenant isolation، idempotency collision/concurrency، revocation، wildcard، stale fencing، crash injection در هر مرحله) با شواهد قابل بازتولید و بازبینی مستقل.
- **ACCEPTED**: فقط پس از اجرای staging، رویهٔ rotation/revocation مستند و آزموده‌شده، و رفع/پذیرش صریح ریسک‌های باقیمانده.

---

## 3. Findings ranked by severity

> قالب فشرده: هر یافته همهٔ فیلدهای خواسته‌شده را دارد. «Falsification test» برای همهٔ موارد اجرایی `NOT_RUN` است؛ نتیجه فقط از **مطالعهٔ ایستا** است.

### F-01 — BLOCKER — مسیر نوشتن فعلی: بدون idempotency، بدون وضعیت پایدار
- **Claim under test:** «create_change_pr دارای کنترل عملیاتی کافی است / retry امن است.»
- **Evidence:** `worker.js` تابع `createChangePr`: پس از authorize، پنج فراخوانی GitHub به‌صورت ترتیبی (tree POST → commit POST → ref POST → PR POST)؛ نام branch با `crypto.randomUUID().slice(0,8)` ساخته می‌شود؛ هیچ پارامتر/ذخیرهٔ idempotency (grep: «idempotency» فقط در متن سؤالات `worker.js` خط ۸۰)؛ `wrangler.toml` فقط سه DO دارد (KNOWLEDGE_STORE، ORCHESTRATOR_LEDGER، TENANT_DIRECTORY). `git grep WriteControl` روی main: خالی.
- **Failure scenario:** کلاینت timeout می‌گیرد و retry می‌کند → دو branch + دو PR. Crash بعد از ref POST و قبل از PR → branch یتیم بدون رکورد.
- **Counter-hypothesis:** GitHub خودش تکراری را رد می‌کند. **رد شد** چون نام branch هر بار تصادفی است، پس ref POST دوم موفق می‌شود.
- **Falsification test:** فراخوانی دوبار با ورودی یکسان؛ انتظار: دو نتیجهٔ مستقل. **NOT_RUN** (ایستا).
- **Expected / Actual:** قرارداد 2K: replay یکسان ⇒ نتیجهٔ قبلی. / کد: هیچ مکانیزم replay.
- **Outcome:** PROVISIONALLY SUPPORTED · **Confidence:** High
- **Remediation:** پیاده‌سازی WriteControl طبق ADR (reserve قبل از اولین POST) + شاخهٔ قطعی (F-04).

### F-02 — BLOCKER — wildcard resource در کد DENY نیست؛ فقط در سند ممنوع است
- **Claim:** «wildcard برای `project.create_pr` DENY است و fail-closed.»
- **Evidence:** `tenant-directory.js` `upsertProjectPolicy`: `resourceDigest !== "*" && !SHA256.test(...)` → `"*"` پذیرفته می‌شود. `authorizeProjectAction`: `resource_digest IN (?, '*') ORDER BY CASE WHEN resource_digest=? THEN 0 ELSE 1 END LIMIT 1` → wildcard-allow بدون rule دقیق، مجوز می‌دهد. `tenant-context.js:317` فقط `effect !== "allow"` را رد می‌کند. (۲N §14 خودش «OPEN BLOCKER» ثبت کرده.)
- **Failure scenario:** یک rule `*` allow برای principal سرویس = اجازهٔ ساخت PR با هر عنوان/فایل/repository-resource-digest در آن project؛ هر digest دقیق دیگر بی‌اثر است.
- **نکتهٔ طراحی (جدید نسبت به 2J–2N):** با ترتیب «exact اول»، یک wildcard **deny** نمی‌تواند exact **allow** را بپوشاند؛ پس «wildcard DENY» به‌عنوان قاعدهٔ precedence معنا ندارد. باید در **زمان نوشتن policy** `*` برای `project.create_pr` رد شود، نه با precedence.
- **Fail-closed؟** نبود rule/membership ⇒ `defaultDeny` ✔ (شاهد ایستا). نبودِ deny برای wildcard-allow ✘.
- **Falsification test:** upsert با `*` allow سپس authorize با digest دلخواه — **NOT_RUN** (می‌شد در lab اجرا شود؛ اجرا نشد).
- **Outcome:** PROVISIONALLY SUPPORTED (ایستا) · **Confidence:** High
- **Remediation:** رد `*` برای اکشن‌های نوشتن در `upsertProjectPolicy` و migration برای حذف rules موجود؛ تست رد؛ (تغییر کد خارج از اجازهٔ این ممیزی).

### F-03 — HIGH — هر تصمیم authorization ثبت نمی‌شود؛ `decisionId` ثابتِ rule است
- **Claim:** «هر تصمیم authorization قابل ردیابی است.»
- **Evidence:** `authorizeProjectAction` (td.js ~244–263) فقط می‌خواند؛ هیچ audit append ندارد. `decisionId` = `rule.decision_id` که هنگام upsert rule ساخته می‌شود (`"policy-"+randomUUID`) — برای همهٔ تصمیم‌های آن rule یکی است. بدنهٔ PR همین id را به‌عنوان «Authorization decision» می‌نویسد. Audit فقط تغییر membership/policy را ثبت می‌کند (با trigger append-only روی UPDATE/DELETE ✔).
- **Failure scenario:** دو PR مختلف با یک decision id؛ نمی‌توان اثبات کرد کدام درخواست، در چه زمان، با کدام نسخهٔ membership مجاز شد. Revoke بعدی rule هم نمی‌تواند تصمیم گذشته را بازسازی کند.
- **Counter-hypothesis:** WriteControl این snapshot را ذخیره می‌کند (2N §10.2). **درست، ولی طراحی‌شده نه موجود**؛ و TenantDirectory هنوز decision قابل‌ثبت (per-request) تولید نمی‌کند.
- **Outcome:** PROVISIONALLY SUPPORTED · **Confidence:** High
- **Remediation:** تعریف «decision record» (digest درخواست + membership version + policy version + زمان) به‌عنوان بخشی از قرارداد؛ ذخیره در WriteControl؛ نسخهٔ membership به context برگردانده شود (2L F-07).

### F-04 — HIGH — طراحی recovery: نام branch/marker قطعی نیست؛ دسته‌بندی «non-idempotent» بیش‌ازحد کلی است
- **Claim:** «UNKNOWN پس از ابهام قابل reconciliation است و resend ممنوع.»
- **Evidence:** 2N §8.3/§9: «Do not automatically resend an ambiguous non-idempotent GitHub POST»؛ §9.5 به «generated branch» و «operation marker» ارجاع می‌دهد، ولی **هیچ سندی** (grep روی 2K/2N/ADR) تعریف نمی‌کند branch قطعی از operation_key مشتق شود. کد فعلی: UUID تصادفی.
- **Failure scenario:** crash/timeout پس از `BRANCH_DISPATCHED`؛ اگر نام branch فقط در پاسخ GitHub یا حافظهٔ worker بود، reconciler چیزی برای جست‌وجوی دقیق ندارد → UNKNOWN دائمی و ورود دستی.
- **تحلیل مستقل (نیازمند اثبات):** GitHub Git-Data عملیات tree (محتوا-آدرسی) در عمل قابل تکرار بدون اثر جانبی معنادار است؛ commit با timestamp ثابت قطعی می‌شود؛ ref با نام قطعی در تکرار خطای «already exists» می‌دهد و PR برای یک جفت head/base یکتا است. اگر این‌ها درست باشند، بسیاری از مراحل «ambiguous» با **نام قطعی + GET** تصمیم‌پذیرند و ممنوعیت کلی resend لازم نیست. **این‌ها UNKNOWN/NOT_VERIFIED هستند** — رفتار واقعی GitHub آزموده نشده.
- **Falsification test:** در یک repo آزمایشی غیرتولیدی: tree/commit/ref/PR تکراری با ورودی یکسان؛ پاسخ‌ها مقایسه شوند. **NOT_RUN**.
- **Outcome:** DISPUTED (نقص طراحی محتمل، نیازمند آزمایش) · **Confidence:** Medium
- **Remediation:** تعریف branch قطعی از `operation_id`، persistence آن پیش از `BRANCH_DISPATCHED`، marker در commit/PR (در body)، و جدول «هر مرحله: idempotent / detectable / ambiguous» مبتنی بر آزمایش.

### F-05 — HIGH — clock و fencing: `now` از فراخواننده می‌آید
- **Claim:** «fencing token جلوی worker قدیمی را می‌گیرد.»
- **Evidence:** ledger: شرط fencing به‌درستی `worker_id`+`lease_generation`+`lease_until <= now` در WHERE/CAS است (مثلاً renew/release/complete خطوط ~1278–1506) ✔ و generation هنگام claim افزایش می‌یابد (خط ~1113). **اما** `now` پارامتر ورودی (`timestamp()` فقط «عدد صحیح مثبت» را بررسی می‌کند؛ خط ۳۶) و برخی مسیرها `Date.now()` داخلی دارند (۵۷۴/۶۲۱/۶۷۷) → clock مختلط.
- **Failure scenario:** worker قدیمی با `now` عقب‌تر، lease منقضی‌شده را معتبر نشان می‌دهد؛ generation هنوز مانع می‌شود **فقط اگر** دیگری claim کرده باشد؛ در بازهٔ انقضا بدون claim جدید، نوشتن بعد از انقضا پذیرفته می‌شود.
- **Counter-hypothesis:** فراخواننده فقط Worker مورد اعتماد است. **قابل‌قبول** اما 2N می‌گوید «timestamp از trusted runtime»؛ تضمین همان باید در WriteControl با `Date.now()` داخل DO باشد.
- **Falsification test:** renew با `now` قدیمی بعد از انقضا. **NOT_RUN**.
- **Outcome:** DISPUTED · **Confidence:** Medium
- **Remediation:** در WriteControl زمان فقط داخل DO؛ تست stale-lease.

### F-06 — HIGH — رزرو admission و authorization دو DO جدا؛ پنجرهٔ TOCTOU باقی‌ست (قبول‌شده ولی ناکامل مشخص)
- **Evidence:** `createChangePr`: authorize (TenantDirectory) → سپس GitHub؛ طراحی 2N §10.2 re-check قبل از هر dispatch را می‌خواهد و می‌پذیرد که cross-DO atomicity نیست.
- **Failure scenario:** revoke بین `COMMIT_WRITTEN` و `BRANCH_DISPATCHED`: طراحی re-check می‌کند ✔؛ اما revoke پس از **ارسال** ref POST ولی پیش از پاسخ قابل لغو نیست (خود سند می‌پذیرد). نتیجه: بازهٔ زمانی مرزی و محدود، ولی **قابل‌اندازه‌گیری نیست** چون فاصلهٔ propagation تعریف نشده است.
- **Open:** سیاست برای شیء‌های نیمه‌ساخته (tree/commit) پس از revoke — پاک‌سازی ممنوع (2N §9) → ماندگاری artefact؛ باید تصمیم صریح شود.
- **Outcome:** PROVISIONALLY SUPPORTED (به‌عنوان ریسک باقیمانده باید ثبت شود) · **Confidence:** Medium
- **Remediation:** تعریف linearization point مکتوب، re-check قبل از هر dispatch، سیاست artefact پس از revoke.

### F-07 — MEDIUM — fingerprint/authorization resource خلاصهٔ PR را شامل نمی‌شود
- **Evidence:** `createChangePr` resource = `{repository, baseBranch, title, files}`؛ `args.summary` بیرون است (2L F-06 و 2N §14 همین را «OPEN BLOCKER» ثبت کرده‌اند). Summary در body PR نوشته می‌شود.
- **Scenario:** policy برای digest دقیق صادر شده؛ محتوای summary دلخواه می‌ماند (ریسک content-injection/دور زدن review).
- **Outcome:** PROVISIONALLY SUPPORTED · **Confidence:** High · **Remediation:** افزودن summary به canonical resource و request digest.

### F-08 — MEDIUM — هویت v1: shared bearer، بدون چرخهٔ عمر credential در کد
- **Evidence:** `worker.js` (~خط ۲۱۶): احراز موفق ⇒ principal ثابت `service:shared-mcp-bearer`؛ `createChangePr` همین را شرط می‌کند ✔ (تفکیک service/human برقرار). 2M خودش lifecycle را «implementation must define» می‌گذارد؛ `wrangler.toml`/`worker.js` هیچ credential-id/version/expiry/emergency-disable ندارد. Rate limit بر اساس IP (`cf-connecting-ip`)، نه principal/tenant.
- **Scenario:** افشا/rotation → همهٔ tenantها یک credential؛ revoke یعنی قطع همه؛ audit نمی‌تواند «کدام نسخهٔ credential» را بگوید.
- **Counter:** برای عرضهٔ اولیهٔ کنترل‌شده با یک اپراتور و allowlist قابل‌دفاع است **به شرط** اثبات رویهٔ rotation/revocation (2M چک‌لیست خودش آن را «open» می‌گذارد).
- **Outcome:** PROVISIONALLY SUPPORTED (به‌عنوان محدودیت پذیرفته‌شده مشروط) · **Confidence:** Medium
- **Remediation:** credential id/version در context و audit؛ رویهٔ emergency-disable؛ محدود کردن tenant/projectهای مجاز. **توجه:** ممیزی این مورد را با خواندن secret بررسی نکرد و نباید بکند.

### F-09 — MEDIUM — audit ثبت‌شده در TenantDirectory زنجیره/anchor ندارد
- **Evidence:** `tenant_directory_audit_events`: trigger append-only روی UPDATE/DELETE ✔، اما بدون `previous_hash/event_hash`؛ در مقابل `orchestrator_audit_events` فیلد `previous_hash`/`event_hash` دارد (الگوی قابل‌بازاستفاده). هیچ anchoring/trusted-timestamp در هیچ‌یک.
- **Scenario:** کسی با دسترسی storage/DO-admin می‌تواند جدول را بازنویسی کند؛ trigger فقط SQL-سطح را می‌بندد.
- **Outcome:** PROVISIONALLY SUPPORTED · **Confidence:** Medium · **Remediation:** hash-chain برای رکوردهای WriteControl و تصمیم‌های authorization؛ anchoring خارجی دورهای (مثلاً digest روی commit مخزن) به‌عنوان مرحلهٔ بعد؛ بدون ادعای tamper-proof.

### F-10 — MEDIUM — retention: رکورد UNKNOWN/IN_PROGRESS «حذف نمی‌شود» ولی سقف ندارد
- **Evidence:** 2K §retention: پاکسازی ۳۰ روزه فقط برای terminal؛ UNKNOWN دائمی. ledger فعلی شواهد reconciliation مصرف‌شده را پس از ۶۰۰ ثانیه (بعلاوهٔ margin) prune می‌کند (خطوط ۱۱۱/۱۷۳–۱۷۸) — الگوی متفاوت.
- **Scenario:** UNKNOWNهای انباشته → سقف quota ناکارآمد/ذخیره بی‌پایان؛ یا برعکس، پس از ۳۰ روز idempotency terminal منقضی و replay باعث نوشتن دوباره می‌شود (جدا از حفظ audit).
- **Outcome:** UNKNOWN (طراحی ناقص‌تعریف، عددی انتخاب نشده) · **Confidence:** Medium
- **Remediation:** سقف تعداد/سن UNKNOWN، هشدار، و تعریف رفتار replay پس از انقضای idempotency (رد صریح یا نگه‌داری fingerprint).

### F-11 — MEDIUM — مرز آسیب‌پذیری GitHub credential مشترک
- **Evidence:** `github(env, …)` از یک credential مشترک برای همهٔ tenantها استفاده می‌کند (مقدار secret خوانده نشد). جداسازی tenantها فقط در لایهٔ policy است، نه GitHub.
- **Outcome:** UNKNOWN (ایستا؛ دامنهٔ مجوز token تأیید نشد) · **Confidence:** Low-Medium · **Remediation:** مستندسازی دامنهٔ token (repo allowlist)، یا GitHub App به‌ازای installation.

### F-12 — LOW — DO واحد WriteControl: تمرکز قابل‌دفاع برای v1، با شرط ظرفیت
- **Evidence:** 2N §6: DO واحد، بدون عدد ظرفیت ("No numeric quotas are invented"). ممیزی تأیید می‌کند که quota اتمیک سراسری با چند DO ممکن نیست و پذیرفتن DO واحد برای حجم پایین منطقی است؛ sharding زودهنگام هزینه/پیچیدگی اضافه می‌کند.
- **Outcome:** PROVISIONALLY SUPPORTED · **Confidence:** Medium · **Remediation:** ثبت طرح ظرفیت (peak admission، حداکثر UNKNOWN، blast radius، پشتیبان) پیش از implementation approval.

### INFO-01 — نقاط قوت مشاهده‌شده
- `defaultDeny` برای نبود membership/rule ✔؛ suspend/revoke membership، rule‌های principal را در همان تراکنش `disabled` می‌کند ✔ (td.js revokeMembership/upsertMembership).
- Ledger الگوی lease/generation + CAS + outbox idempotency scope (tenant+project+key، conflict صریح) + hash-chain audit دارد؛ **قابل‌الگوبرداری** ولی نه مالک این aggregate (2N §10.3 درست استدلال می‌کند که outbox مبتنی بر task مناسب نیست).
- اسناد همه `NOT_RUN`/draft را صادقانه اعلام می‌کنند.

---

## 4. Evidence matrix

| فرضیه | موضوع | شاهد کد (main = snapshot) | شاهد سند | وضعیت | یافته |
|---|---|---|---|---|---|
| A | مرزبندی | TenantDirectory = membership/policy ✔؛ Ledger = tasks/outbox ✔؛ WriteControl ✘ | ADR G2N-01، 2N §4–5 | جهت PROVISIONALLY SUPPORTED، پیاده‌سازی غایب | F-01, F-12, INFO-01 |
| B | atomicity | auth و admission در دو DO؛ GitHub POSTها خارج از تراکنش | 2N §10 | طراحی صریح؛ اجرا غایب | F-06 |
| C | idempotency | ledger: scope tenant+project+key + conflict ✔؛ write path: ✘ | 2K §5 | غایب در مسیر نوشتن | F-01, F-07 |
| D | TOCTOU/wildcard | wildcard-allow پذیرفته؛ defaultDeny برای نبود rule ✔ | 2L F-02، 2N §14 | در کد تأیید شد | F-02, F-06 |
| E | lease/fencing | ledger: generation CAS ✔؛ `now` از caller | 2N §8 | ledger الگوی خوب؛ WriteControl نبود | F-05 |
| F | UNKNOWN/recovery | write path فقط متن خطا و «branch retained» برای PR 5xx/نامعلوم | 2N §9 | طراحی؛ branch قطعی نیست | F-04, F-10 |
| G | multi-tenant/quota | rate limit فقط per-IP؛ سقف per-tenant ✘ | 2N §6, §12 | عدد انتخاب نشده | F-08, F-12 |
| H | service-only | principal ثابت؛ lifecycle ✘ | 2M | محدودیت پذیرفته‌شده مشروط | F-08, F-11 |
| I | audit | policy/membership append-only بدون chain؛ تصمیم‌ها ثبت نمی‌شوند | 2N §10 | ناکامل | F-03, F-09 |

---

## 5. Contradiction and counter-hypothesis analysis

1. **«DO واحد برای اتمیک بودن quota» در مقابل «سقف سراسری مستقل با sharding»:** 2N خودش این را می‌پذیرد که quota سراسری سخت با چند DO بدون هماهنگی صریح ممکن نیست → **سازگار** (نه تناقض).
2. **«TenantDirectory مرجع policy» و «WriteControl snapshot نگه می‌دارد»:** snapshot ≠ مالکیت دوگانه به شرط اینکه فقط *شاهد تصمیم* باشد، نه منبع policy؛ در سند چنین است ✔. خطر: اگر WriteControl بعدها policy را کش کند، مالکیت دوگانه رخ می‌دهد → باید در قرارداد ممنوع شود.
3. **«UNKNOWN پایدار» در مقابل «retention 30 روزه»:** UNKNOWN prune نمی‌شود ✔؛ اما ایدمپوتنسی terminal پس از ۳۰ روز منقضی است → replay بعد از آن می‌تواند نوشتن تازه ایجاد کند (F-10). تناقض *جزئی*، نه باطل‌کننده.
4. **«تجدید authorization پیش از هر dispatch» در مقابل «revoke پس از dispatch نامحدود نیست»:** سند صادقانه می‌پذیرد → ریسک باقیمانده باید در release criteria ثبت شود نه پنهان.
5. **Counter-hypothesis کلی:** «WriteControl جداگانه لازم نیست؛ Ledger کافی است.» **رد شد:** outbox ledger به task وابسته است و audit hash-chain آن task_id می‌خواهد؛ عملیات نوشتن بدون task وجود دارد (2N §10.3؛ ساختار جدول `orchestrator_audit_events.task_id NOT NULL` این را تأیید می‌کند).

---

## 6. Failure injection and test results

**هیچ تستی اجرا نشد.** هیچ نتیجهٔ pass/fail ادعا نمی‌شود.

| تست | وضعیت | یادداشت |
|---|---|---|
| tenant/principal isolation | NOT_RUN | ledger: scope tenant+project ایستا تأیید؛ مسیر نوشتن: بدون رکورد |
| idempotency collision / concurrent duplicates | NOT_RUN | مسیر نوشتن: بدون کلید؛ دو بار اجرا = دو branch (استنتاج ایستا) |
| authorization revocation | NOT_RUN | revokeMembership ایستا: rules غیرفعال در همان تراکنش |
| wildcard resource denial | NOT_RUN | ایستا: اجازه می‌دهد (F-02) |
| stale lease / fencing | NOT_RUN | ledger ایستا ✔ برای tasks؛ WriteControl ✘ |
| crash injection در tree/commit/ref/PR | NOT_RUN | وضعیت پایدار وجود ندارد |
| ambiguous response | NOT_RUN | فقط شاخهٔ PR 5xx/نامعلوم متن خطا می‌دهد |
| UNKNOWN recovery | NOT_RUN | WriteControl ✘ |
| audit failure | NOT_RUN | — |
| quota exhaustion | NOT_RUN | فقط rate limit per-IP |
| retention/migration | NOT_RUN | — |
| retry/reconciliation | NOT_RUN | — |

**دلیل:** هیچ بخش اجرایی WriteControl وجود ندارد که قابل آزمایش باشد؛ اجرای کد Workers/DO نیازمند harness است و در این ممیزی (فقط‌خواندنی، بدون deploy) انجام نشد. نبود شواهد = موفقیت نیست.

---

## 7. Differences from Gates 2J–2N

- **تأیید می‌شود (هم‌راستا):** F-02 (2L F-02)، F-07 (2L F-06)، نبود WriteControl (2L F-01)، وضعیت credential (2M/2N).
- **جدید/تعمیق‌یافته:** (۱) wildcard-**deny** با ترتیب exact-first عملاً غیرممکن است ⇒ باید رد در write-time باشد (F-02)؛ (۲) نبودِ **branch قطعی** و ابهام دسته‌بندی «non-idempotent» (F-04)؛ (۳) `decisionId` ثابت rule، نه per-request (F-03)؛ (۴) `now` caller-supplied (F-05)؛ (۵) TenantDirectory audit بدون hash-chain در حالی که ledger دارد (F-09)؛ (۶) تناقض جزئی retention/idempotency (F-10).
- **اختلاف با اسناد:** هیچ ادعای نادرست «پیاده‌شده» در اسناد پیدا نشد؛ اسناد با کد سازگارند.

---

## 8. Open architectural decisions

1. branch قطعی از `operation_id` و marker در commit/PR؟ (F-04)
2. رفتار قطعی GitHub برای تکرار tree/commit/ref/PR (نیازمند آزمایش)
3. رد wildcard در write-time برای اکشن‌های نوشتن + migration
4. credential authority، issuer، رویهٔ rotation/revocation/emergency disable، credential id/version در audit
5. clock: تمام زمان‌ها داخل DO
6. عددهای quota (per tenant/principal/repo/global، سقف UNKNOWN)، طرح ظرفیت DO
7. رفتار replay پس از انقضای idempotency
8. سیاست artefactهای نیمه‌ساخته پس از revoke/FAILED (cleanup)
9. چه کسی/با چه capability حق reconcile دارد
10. نیاز و دامنهٔ anchoring خارجی audit
11. دامنهٔ GitHub token (یا GitHub App)

---

## 9. Minimal remediation sequence

1. **R1 — قرارداد v2:** بستن F-04, F-05, F-06, F-07, F-10 در سند + decision record (F-03) → بازبینی مستقل.
2. **R2 — آزمایش GitHub (غیرتولیدی):** رفتار تکرار tree/commit/ref/PR؛ جدول idempotent/detectable/ambiguous.
3. **R3 — بستن wildcard (کد):** رد `*` برای اکشن نوشتن + تست؛ نیازمند PR جداگانه و مجوز.
4. **R4 — credential lifecycle:** رویهٔ مکتوب و آزمون‌پذیر برای secrets بدون افشا؛ context شامل credential id/version.
5. **R5 — WriteControl staging-only پشت feature flag:** reserve → dispatch/written → UNKNOWN → reconcile؛ audit hash-chain؛ quota.
6. **R6 — اجرای ماتریس تست بخش ۶** با شواهد، سپس بازبینی مستقل مجدد (Gate 2P).

---

## 10. Release recommendation

**NO-GO برای هر انتشار تولیدی و برای شروع پیاده‌سازی WriteControl تا زمان بستن R1–R4.**
- Gate بعدی (مجوز پیاده‌سازی staging-only) **مسدود است** به‌دلیل: نبود تصمیم برای F-04/F-05/F-06، wildcard باز در کد، نبود تصمیم credential lifecycle، و صفر شواهد تست.
- مسیر فعلی `create_change_pr` (بدون WriteControl) پیش‌تر در 2L «PRODUCTION NO-GO» اعلام شده؛ این ممیزی آن را **تأیید** می‌کند و ریسک wildcard را برجسته می‌کند.
- هیچ ادعای «تأیید‌شده/آماده» از این گزارش استخراج نشود.

*پایان گزارش. هیچ کد، تنظیم، secret، PR، merge یا deploy تغییر نکرد؛ هیچ secret خوانده نشد.*
