# راهنمای اپراتوری اجرای CTP (آزمون‌های ثبت‌شده)

**وضعیت:** اجرای محلی/توسعه ✅ آزموده‌شده؛ staging ⚠️ مشروط؛ production ⛔ غیرفعال/ناکافی (بخش ۸).
هیچ نقطهٔ پایانی اجرای عمومی بدون احراز هویت وجود ندارد؛ هیچ کد، فرمان، فایل اجرایی یا اسکریپتی از مشتری پذیرفته نمی‌شود — فقط `test_id` یک آزمون **بازبینی‌شدهٔ ثبت‌شده** در `ctp_registry.py`.

## ۱. نقش‌ها و هویت‌ها
| نقش | چه می‌کند | کلید/هویت | کجا اجرا می‌شود |
|---|---|---|---|
| درخواست‌دهنده | `operator` یا approver؛ درخواست اجرا می‌دهد و اجرا را راه می‌اندازد | نشست/توکن | وب/API |
| تأییدکننده | approver تعیین‌شده (حساب محلی با پرچم approver)؛ challenge را با **کلید رمزدار خودش** امضا می‌کند | `user:<نام>` ↔ `k-…` در trust store | رایانهٔ خود تأییدکننده (`approval_keys`) |
| اجراکننده | فرایند سرور؛ actor = `ctp-runner`؛ کلید ندارد | — | سرور |
| تأییدکنندهٔ مستقل | فرایند جدا `ctp_verify` با کلید `verifier:<id>` | کلید جدا (رمزدار) | **فرایند جدا**؛ ترجیحاً ماشین جدا |

هویت‌ها از نظر رمزنگاری متمایزند و فرایندها جدا هستند؛ اگر هر دو روی یک میزبان باشند **استقلال محیط وجود ندارد** (مدیر میزبان هر دو را کنترل می‌کند).

## ۲. تدارک کلید (خارج از مخزن)
```bash
# روی رایانهٔ تأییدکننده (کلید هرگز از آن بیرون نمی‌رود)
python -m master_brain.approval_keys keygen --key-id k-boss --subject user:boss --out ~/boss.key
python -m master_brain.approval_keys public --key ~/boss.key        # فقط ورودی عمومی را به سرور بدهید
# کلید تأییدکنندهٔ مستقل: subject باید با verifier: شروع شود
python -m master_brain.approval_keys keygen --key-id k-ver --subject verifier:v1 --out ~/ver.key
python -m master_brain.approval_keys public --key ~/ver.key
```
فایل `keys.json` (فقط **کلیدهای عمومی**، مجوز 0600): `{"keys": [ {"key_id": "...", "subject": "...", "public_key_hex": "..."}, ... ]}`.
عبارت عبور ≥ ۱۲ نویسه؛ فایل کلید 0600؛ هرگز در گیت، لاگ یا پاسخ API نمی‌آید.

## ۳. راه‌اندازی
```bash
pip install -e ".[signing]"
python -m master_brain.serve --data-dir ./data --approval-keys ./keys.json --ctp-builtin-tests
```
شروع **رد می‌شود** اگر: sandbox کار نکند، `--approval-keys` نباشد، یا فایل کلید قابل‌نوشتن توسط دیگران باشد. پرچم `--ctp-builtin-tests` نباشد، مسیرهای `/v1/ctp/*` اصلاً وجود ندارند (۴۰۴).
پیش‌نیاز: لینوکس با user namespace بدون امتیاز، `unshare`، `setpriv`، `mount`، `pivot_root`، پایتون ≥ 3.11 (در CI: ۳.۱۱؛ محلی: ۳.۱۳). روی Ubuntu ≥ 24.04 ممکن است `kernel.apparmor_restrict_unprivileged_userns=0` لازم باشد (گردش‌کار CI همین را تنظیم می‌کند).

## ۴. مسیر کار (فرمان‌های واقعی)
```bash
H=http://127.0.0.1:8765 ; T="Authorization: Bearer <session-or-token>"
curl -s $H/v1/ctp/tests -H "$T"                                               # فهرست آزمون‌های ثبت‌شده (فقط digest و سقف‌ها)
curl -s -X POST $H/v1/ctp/runs -H "$T" -H 'Content-Type: application/json' -d '{"test_id":"sha256-known-answer"}'
#   => request_id (ctpreq-…) و spec_digest که سرور خودش حساب کرده
# تأییدکننده:
curl -s -X POST $H/v1/ctp/runs/$RID/approval-challenges -H "$TA" -H 'Content-Type: application/json' \
     -d '{"signing_key_id":"k-boss","signature_alg":"ed25519"}'               # => signing_message_hex, approval_event_id, expires_at (پیش‌فرض ۱۵ دقیقه، حداکثر ۱ ساعت)
python -m master_brain.approval_keys sign --key ~/boss.key --message-hex <signing_message_hex>
#   ابزار نشان می‌دهد: request_id، test_id، spec_digest، requester، approver، expiry — و فقط با «yes» امضا می‌کند
curl -s -X POST $H/v1/ctp/runs/$RID/approvals -H "$TA" -H 'Content-Type: application/json' \
     -d '{"approval_event_id":"…","signing_key_id":"k-boss","signature_alg":"ed25519","signature_hex":"…"}'
curl -s -X POST $H/v1/ctp/runs/$RID/executions -H "$T" -H 'Content-Type: application/json' -d '{}'
python -m master_brain.ctp_verify --data-dir ./data --approval-keys ./keys.json --verifier-key ~/ver.key --request-id $RID
curl -s $H/v1/ctp/runs/$RID -H "$T"                                           # وضعیت و شواهد
```

## ۵. معنای وضعیت‌ها (`status` / `final_ctp_status`)
| status | final | معنا |
|---|---|---|
| `awaiting_approval` / `approval_challenged` | not_run | منتظر امضا |
| `approved` | not_run | امضا معتبر؛ هنوز اجرا نشده |
| `approval_expired` | not_run | مهلت تمام شد؛ درخواست جدید لازم است |
| `executed_unverified` | **inconclusive** | اجرا شد ولی تأیید مستقل نشده؛ `provisional_outcome` نتیجه نیست |
| `verified_pass` / `verified_fail` | pass / fail | بازاجرای مستقل با اثر انگشت یکسان؛ **فقط برای همین آزمون ثبت‌شده** |
| `not_reproduced` / `not_confirmable` | inconclusive | بازاجرا متفاوت بود یا اجرا ناتمام بود |
| `outcome_unknown` | inconclusive | claim ثبت شد ولی نتیجه ثبت نشد؛ **هرگز خودکار دوباره اجرا نمی‌شود** (درخواست جدید بدهید) |
| `aborted` | not_run | runner امتناع کرد؛ چیزی اجرا نشد |
| `inconsistent` | inconclusive | زنجیرهٔ تأیید/اجرا معتبر نیست؛ `problems` را ببینید و **بدون بررسی انسانی استفاده نکنید** |

کدهای خطا (جدول بسته‌ی API): `unauthenticated 401`، `forbidden 403`، `not_found 404` (نبود دسترسی و نبود درخواست یکسان‌اند)، `approval_required 403`، `approval_invalid 403` (امضا نامعتبر/منقضی/تأییدکننده دیگر تعیین‌شده نیست)، `stale_contract 409` (spec یا مفسر عوض شده؛ تأیید باطل است)، `duplicate_request 409` (claim قبلاً ثبت شده)، `conflict 409`، `rate_limited 429` (سقف ۱۰ درخواست باز برای هر درخواست‌دهنده)، `unavailable 503` (sandbox/trust store/ثبت ممیزی در دسترس نیست، **چیزی اجرا نشد**)، `outcome_unknown 500` (ممکن است اجرا شده باشد؛ تلاش مجدد نزنید).

## ۶. دسترسی به شواهد و ممیزی
- پاسخ‌های API فقط digestها، اندازه‌ها، کد خروج/سیگنال، مشخصات sandbox و شناسه‌ها را می‌دهند؛ **هیچ مسیر فایل، کلید یا خروجی خام** برنمی‌گردد.
- خروجی خام (stdout/stderr) در `data/ctp-evidence/<sha256>` (پوشه 0700، فایل 0600، محتوا‌نشانی با بررسی دست‌کاری) می‌ماند و فقط با دسترسی به میزبان خوانده می‌شود.
- زنجیرهٔ ممیزی: `data/audit.jsonl` (هش‌زنجیره‌ای). بازسازی کامل: به‌ترتیب `ctp.run_requested → run_challenge_issued → run_approved → run_claimed → test_executed → test_verified`.

## ۷. پشتیبان‌گیری، بازیابی، ظرفیت
- پشتیبان: `data/audit.jsonl` (+ `.head`)، `data/accounts.sqlite`، `data/ctp-evidence/` را هم‌زمان و در حالت خاموش/بدون نوشتن کپی کنید؛ بازیابی را با `python -m master_brain.audit_recovery` (فقط دم پارهٔ ناشی از crash) و راه‌اندازی دوباره (تأیید کامل زنجیره در شروع) بیازمایید. **بازیابی خودکار آزموده‌شده نداریم.**
- حد هم‌زمانی: ۱ اجرای sandbox هم‌زمان (اجرای بعدی `unavailable` می‌گیرد، صف نمی‌شود)؛ هر اجرا ≤ ۶۰ ثانیه، ≤ ۱GiB، خروجی ≤ ۱MiB.
- ظرفیت زنجیره: سنجش‌شده فقط تا ۲۰ هزار رویداد.

## ۸. سطوح آمادگی (شواهد)
1. **توسعهٔ محلی — آمادهٔ آزمایش.** شواهد: آزمون‌های `tests/test_ctp_*.py` با sandbox واقعی، root و non-root؛ CI.
2. **Staging — مشروط.** لازم: کلید verifier روی ماشین/حساب جدا؛ runner با userns؛ TLS جلوی سرور و `--secure-cookies`؛ آزمون بازیابی واقعی؛ هنوز **انجام نشده**.
3. **Production — ⛔ مجاز نیست.** موانع تأییدنشده: cgroup (CPU/حافظه/تعداد فرایند)، seccomp، TLS و پایش، تأییدکنندهٔ منفرد (SPOF)، هم‌میزبانی اجراکننده/تأییدکننده، نبود بازیابی/پشتیبان آزموده‌شده، نبود ارزیابی امنیتی مستقل. اگر اجرای ایمن ممکن نباشد `--ctp-builtin-tests` را روشن نکنید.

## ۹. مدل تهدید (و آنچه پوشش نمی‌دهد)
| تهدید | کنترل | آزمون | باقی‌مانده |
|---|---|---|---|
| کد دلخواه از اینترنت | فقط `test_id` ثبت‌شده؛ فیلد اضافه ⇒ ۴۰۰ | `test_malformed_oversized_and_injecting_bodies`, `test_unregistered_or_injected_requests…` | کد ثبت‌شده باید بازبینی شود |
| دور زدن تأیید/جعل | امضای Ed25519 مقید به request/test/spec/expiry/key/approver، بررسی هنگام ثبت و هنگام اجرا | `ApprovalBinding.*` | کلید تأییدکننده فاش شود ⇒ تأییدهای جعلی |
| replay / استفادهٔ دوباره | claim یک‌بارمصرف (شناسهٔ ثابت)، یک تأیید برای هر درخواست | `SingleUseAndFaults.*` | — |
| تغییر spec پس از تأیید | digest دوباره هنگام اجرا؛ مفسر در digest | `test_changed_spec_or_interpreter_voids…` | — |
| فرار از sandbox | namespaceها، pivot_root، no_new_privs، capability خالی، RLIMIT، probe واقعی | `tests/test_ctp_runner.py` | **اکسپلویت هسته، مدیر میزبان، side-channel، نبود cgroup/seccomp** |
| پایان‌دادن بی‌صدا به PASS | PASS فقط پس از بازاجرای مستقل و زنجیرهٔ سالم | `OutcomeSemantics.*` | فرض قطعی‌بودن خروجی |
| دست‌کاری لاگ | زنجیرهٔ هش و توقف ارزیابی | `test_tampered_audit_log_stops_evaluation` | مدیر میزبان می‌تواند کل زنجیره را بازنویسی کند (بدون لنگر بیرونی) |
| نشت کلید/مسیر | پاسخ‌ها فقط digest؛ CLI خطاهای عمومی | `test_views_never_leak…` | — |
| DoS | یک اجرا هم‌زمان، سقف درخواست باز، rate limit | `test_global_concurrency_limit…`, `test_open_request_quota` | حملهٔ توزیع‌شده/منابع میزبان |
