# Master Brain — Gate 2P / R1: پیشنهاد Delta قرارداد v2 (پیش‌نویس تصمیم‌ها)

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**وضعیت:** PROPOSAL — هیچ تصمیمی اعمال‌شده نیست؛ همهٔ موارد نیازمند تأیید مالک و بازبینی مستقل. هیچ کد/PR/merge/deploy انجام نشد. همهٔ تست‌ها NOT_RUN.
**مبنا:** گزارش MB-G2O-C-2026-11-15 (snapshot `5d55336`)، یافته‌های F-02..F-10.

## 1. تصمیم‌های پیشنهادی (هر کدام: قاعده ← یافتهٔ مرتبط ← معیار پذیرش)

| ID | قاعدهٔ پیشنهادی | یافته | معیار پذیرش (قابل‌آزمون) |
|---|---|---|---|
| D-01 | **wildcard ممنوع در write-time:** `upsertProjectPolicy` برای هر action نوشتنی (شروع با `project.create_pr`) فقط digest SHA-256 دقیق می‌پذیرد؛ `*` با خطای صریح رد می‌شود. rule های `*` موجود با migration غیرفعال و در audit ثبت می‌شوند. precedence **راه حل نیست**. | F-02 | upsert با `*` ⇒ رد؛ authorize با rule `*` قدیمی ⇒ deny؛ migration idempotent |
| D-02 | **branch قطعی:** نام branch = `assistant/` + prefix ثابت‌طول از `operation_id` (نه UUID تصادفی)؛ پیش از `BRANCH_DISPATCHED` در رکورد عملیات ذخیره می‌شود. | F-04 | دو اجرای یکسان ⇒ همان نام؛ تصادم دو عملیات مختلف ⇒ رد |
| D-03 | **marker:** commit message و بدنهٔ PR شامل `operation_id` و request-digest (غیرحساس) باشد تا reconciler بتواند تطبیق دهد. | F-04 | reconciler فقط با marker + نام branch منحصربه‌فرد را تشخیص دهد |
| D-04 | **tree/commit قطعی (فرضیه):** commit با author/committer date ثابت از لحظهٔ reserve ساخته شود. **UNVERIFIED** تا آزمایش R2. تا آن زمان قاعدهٔ «resend ممنوع» پابرجاست. | F-04 | نتیجهٔ R2 (بخش ۳) |
| D-05 | **decision record per-request:** WriteControl در تراکنش admission ذخیره کند: request-digest، tenant، principal، project، action، resource-digest، membership version، policy version، rule decision_id، زمان (از DO). `decisionId` فعلی فقط «rule id» نامیده شود. | F-03, F-07 | هر عملیات یک رکورد decision یکتا؛ دو PR ⇒ دو رکورد |
| D-06 | **resource digest شامل summary** (و هر فیلد ارسالی به GitHub). | F-07 | تغییر یک بایت summary ⇒ digest متفاوت ⇒ deny یا conflict |
| D-07 | **clock:** فقط `Date.now()` داخل DO WriteControl؛ ورودی `now` از فراخواننده پذیرفته نشود. | F-05 | تلاش renew با now قدیمی ⇒ نادیده/رد؛ stale lease بعد از انقضا رد |
| D-08 | **re-check authorization** قبل از هر `*_DISPATCHED` جدید و در replay/ادامهٔ UNKNOWN؛ ناتوانی در گرفتن تصمیم تازه ⇒ fail-closed. linearization point = commit شدن فاز `*_DISPATCHED`؛ revoke بعد از آن لغو‌کنندهٔ درخواست ارسال‌شده نیست و باید در release notes ریسک باقیمانده ثبت شود. | F-06 | revoke بین مراحل ⇒ توقف پیش از dispatch بعدی |
| D-09 | **artefact پس از revoke/FAILED:** پاک‌سازی خودکار ممنوع؛ رکورد UNKNOWN/ORPHAN با شناسهٔ اشیاء خارجی نگه‌داری شود تا سیاست cleanup جداگانه بازبینی شود. | F-06 | هیچ DELETE خودکار در کد |
| D-10 | **retention:** UNKNOWN/IN_PROGRESS حذف نمی‌شود؛ سقف تعداد UNKNOWN (پارامتر، عدد انتخاب‌نشده) → رسیدن به سقف ⇒ رد admission جدید. پس از انقضای idempotency، **fingerprint** (نه نتیجه) تا پنجرهٔ audit نگه‌داری شود و replay بعد از انقضا رد صریح شود، نه اجرای دوباره. | F-10 | replay پس از انقضا ⇒ `IDEMPOTENCY_EXPIRED` نه نوشتن |
| D-11 | **audit:** رکوردهای WriteControl با hash-chain (الگوی `previous_hash/event_hash` ledger)؛ ادعای tamper-proof ممنوع؛ anchoring خارجی مرحلهٔ بعد. | F-09 | زنجیره‌ٔ قطع‌شده توسط verifier شناسایی شود |
| D-12 | **credential:** context شامل credential id/version غیرسری؛ رویهٔ emergency-disable مستند؛ هیچ secret در لاگ. صدور/نگهداری توسط مالک؛ این گزارش به secret دست نمی‌زند. | F-08 | چک‌لیست 2M (rotation/revocation) با شواهد بدون افشا |
| D-13 | **quota:** ابعاد: tenant، principal، repository، سراسری، UNKNOWN. **اعداد انتخاب نشدند** (نیاز به اندازه‌گیری/بودجه). مقدار نامشخص ⇒ admission بسته (fail-closed)، نه نامحدود. | F-12 | پیکربندی بدون عدد ⇒ رد |
| D-14 | **WriteControl policy را کش نکند** (فقط snapshot شاهد). | بخش ۵ گزارش | بازبینی کد: نبود خواندن policy محلی |

## 2. جدول وضعیت هر مرحلهٔ GitHub (فرضیه‌ها؛ همه UNVERIFIED)

| مرحله | ابهام پس از timeout | راه تشخیص پیشنهادی | تکرار امن؟ |
|---|---|---|---|
| tree POST | شیء ممکن است ساخته شده باشد | محتوا-آدرسی؛ SHA قابل محاسبه | UNVERIFIED |
| commit POST | با date ثابت قطعی (D-04) | GET commit با SHA محاسبه‌شده | UNVERIFIED |
| ref POST | branch ممکن است ساخته شده باشد | GET ref با نام قطعی (D-02) | خیر تا R2؛ تشخیص‌پذیر |
| PR POST | PR ممکن است ساخته شده باشد | جست‌وجوی PR با head/base + marker (D-03) | خیر تا R2؛ تشخیص‌پذیر |

## 3. R2 — پروتکل آزمایش رفتار GitHub (برای اجرا توسط **مالک** روی repo آزمایشی غیرتولیدی)
من نمی‌توانم (شبکهٔ shell بسته و نوشتن بیرونی خارج از محدودهٔ ممیزی). آزمایش‌ها:
1. tree POST دو بار با ورودی یکسان ⇒ SHA یکسان؟
2. commit POST دو بار با parents/tree/message/date یکسان ⇒ SHA یکسان؟
3. ref POST دوم با همان نام ⇒ کد/پیام خطا؟ (انتظار 422؛ ثبت واقعی)
4. PR POST دوم برای همان head/base ⇒ خطا؟ پیام؟
5. پاسخ GET ref/pulls?head= پس از هر کدام ⇒ سازگار؟
خروجی: جدول مشاهده‌شده با تاریخ و نسخهٔ API؛ جای هر نتیجهٔ مشاهده‌نشده «UNKNOWN».

## 4. ماتریس تست قابل‌اجرا پس از پیاده‌سازی (مشخصات — همه NOT_RUN)
T-01 wildcard رد در upsert · T-02 migration wildcard · T-03 tenant isolation کلید یکسان · T-04 principal isolation · T-05 idempotency: همان درخواست ⇒ نتیجهٔ قبلی؛ درخواست متفاوت ⇒ CONFLICT · T-06 دو درخواست هم‌زمان ⇒ یک عملیات · T-07 revoke بین فازها · T-08 stale lease/fencing با now ناسازگار · T-09 crash پس از هر `*_DISPATCHED` ⇒ UNKNOWN · T-10 پاسخ مبهم ⇒ UNKNOWN نه FAILED/SUCCEEDED · T-11 reconcile چندباره بی‌اثر جانبی · T-12 شکست audit ⇒ rollback admission · T-13 quota exhaustion ⇒ رد · T-14 replay پس از انقضا · T-15 زنجیرهٔ audit قطع‌شده.

## 5. ترتیب اجرا و دروازه‌ها
1. مالک D-01..D-14 را تأیید/اصلاح کند (تصمیم‌ها مالک راست).
2. R2 توسط مالک اجرا شود؛ D-04 بر اساس نتیجه نهایی شود.
3. نسخهٔ v2 قرارداد در Chat-gpt **فقط با اجازهٔ جداگانه** (PR) نوشته شود؛ بازبین مستقل بررسی کند.
4. تا آن زمان: پیاده‌سازی WriteControl و هر deploy ممنوع.

## 6. تعهدهای عدم‌ادعا
هیچ بخش این پیشنهاد اجرا یا تست نشده؛ فرضیه‌های GitHub آزموده نشده‌اند؛ اعداد quota انتخاب نشده‌اند.
