# Master Brain — Gate 2P / R1-A Amendment 01

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
## پاسخ مهندسی به یافته‌های SR-01 تا SR-08

**شناسه:** MB-G2P-R1A-AMD01-2026-11-15  
**وضعیت:** PROPOSED AMENDMENT — NOT APPROVED — NOT IMPLEMENTED  
**سند پایه:** docs/MASTER_BRAIN_GATE2P_R1A_CONTRACT_DELTA_V2_PROPOSAL_2026-11-15.md  
**Blob SHA سند پایه در زمان تهیه:** d170f8d7bc99135d72f64ecd144aa1bf316ccefe  
**ممیزی مبنا:** docs/MASTER_BRAIN_GATE2P_R1A_ADVERSARIAL_SELF_REVIEW_2026-11-15.md  
**Blob SHA ممیزی در زمان تهیه:** 08b1691f53318fb0fa3f4f8e40f20814d481d2c3  
**دامنه:** اصلاح مستنداتی قرارداد؛ بدون تغییر کد، مجوز اجرا، PR، merge یا deployment.

## 0. اصل حاکم و محدودیت

این سند به‌جای بازنویسی بی‌ردپای سند پایه، یک amendment مستقل و قابل ردیابی است. سند پایه دست‌نخورده می‌ماند تا provenance حفظ شود. این amendment فقط پیشنهاد اصلاح است؛ نه تصمیم مالک و نه نتیجه بازبینی مستقل.

وضعیت آزمون‌های این سند و R2 همگی NOT_RUN است. هر رفتار خارجی که مشاهده و ثبت نشده UNKNOWN باقی می‌ماند.

## 1. SR-01 — fencing در مرز dispatch خارجی

### اصلاح پیشنهادی قرارداد

1. lease_generation فقط fencing برای تغییر state داخلی WriteControl است؛ به‌تنهایی GitHub را fence نمی‌کند.
2. تمام GitHub POSTها باید فقط از یک مسیر dispatch کنترل‌شده عبور کنند؛ هیچ worker یا adapter دیگری حق ارسال مستقیم write ندارد.
3. قبل از هر ارسال، dispatch gate باید این موارد را در یک عملیات اتمیک داخلی بررسی و ثبت کند:
   - operation_id و request_fingerprint؛
   - lease_generation جاری؛
   - dispatch permit یکتا و کوتاه‌عمر؛
   - مرحله و endpoint مجاز؛
   - authorization decision snapshot معتبر؛
   - عدم وجود dispatch قبلی حل‌نشده برای همان مرحله.
4. worker قدیمی با generation منقضی‌شده نمی‌تواند permit جدید بگیرد یا state را تغییر دهد.
5. پس از اخذ permit، شبکه خارجی خارج از تراکنش DO است. بنابراین حتی این طراحی نیز نمی‌تواند درخواست ارسال‌شده یا درخواست در فاصله نهایی check-to-send را از راه دور لغو کند.
6. اگر permit منقضی، نامعتبر یا متعلق به generation قدیمی باشد، dispatch جدید رد می‌شود. نتیجه dispatch مبهم باید UNKNOWN شود و فقط reconciliation مجاز است.
7. هر مسیر مستقیم GitHub write خارج از dispatcher باید در آزمون معماری و code review رد شود.

### مرز تضمین

- تضمین قابل ادعا: stale generation نمی‌تواند state داخلی را commit کند یا dispatch permit تازه بگیرد.
- تضمین غیرقابل ادعا: revoke یا lease expiry قادر است POSTای را که قبلاً ارسال شده یا در فاصله غیراتمیک نهایی است لغو کند.
- برای حذف کامل این race به پشتیبانی fencing در سمت مقصد نیاز است؛ در GitHub REST write معمول، چنین تضمینی را نباید فرض کرد.

### آزمون‌های الزامی

- SR01-T1: توقف worker قدیمی قبل از اخذ permit؛ افزایش generation؛ ازسرگیری worker؛ باید رد شود.
- SR01-T2: اخذ permit و توقف پیش از network send؛ expiry؛ سپس ازسرگیری؛ نتیجه باید مطابق permit expiry policy باشد و هیچ state قدیمی commit نشود.
- SR01-T3: تلاش adapter مستقیم برای POST خارج از dispatcher؛ باید در معماری/تست ممنوع باشد.
- SR01-T4: پاسخ شبکه مبهم پس از permit؛ state باید UNKNOWN شود، نه FAILED یا SUCCEEDED بدون evidence.

**نتیجه فعلی:** PROPOSED; NOT_RUN.

## 2. SR-02 — تفکیک سه digest با معناهای مستقل

### قرارداد canonical پیشنهادی

سه مفهوم جداگانه تعریف شود:

1. authorization_resource_digest
   - هویت canonical منبعی که policy درباره آن تصمیم می‌گیرد؛
   - شامل شناسه canonical repository، project، action و resource target؛
   - شامل title/summary صرفاً در صورتی که policy صریحاً محتوای آن‌ها را بخشی از منبع مجازشده تعریف کرده باشد.
2. request_fingerprint
   - fingerprint تمام ورودی‌هایی که اجرای دقیق عملیات خارجی را تعیین می‌کنند؛
   - شامل action/schema version، repository، base branch، title، summary، مرتب‌سازی قطعی pathها، digest محتوا، preconditions و expected blob SHAها؛
   - مبنای idempotency و تشخیص same-key/different-request.
3. content_digest
   - digest محتوای canonical فایل‌ها/درخت payload؛
   - در صورت نیاز به تطبیق محتوا و مستقل از هویت منبع نگهداری شود.

### قواعد

- TenantDirectory فقط authorization_resource_digest را برای تطبیق resource policy دریافت و ارزیابی می‌کند.
- WriteControl request_fingerprint را برای replay/conflict و reconciliation ذخیره می‌کند.
- content_digest برای اثبات تطبیق payload خارجی استفاده می‌شود.
- summary و title باید در request_fingerprint باشند، حتی اگر در authorization_resource_digest نباشند.
- هر سه digest دارای الگوریتم، canonicalization version و domain-separation prefix مستقل باشند.
- هیچ digestای جایگزین دیگری تلقی نشود.

### آزمون‌های الزامی

- تغییر summary: request_fingerprint تغییر کند؛ authorization_resource_digest فقط طبق تعریف resource policy تغییر کند.
- تغییر محتوای یک فایل: content_digest و request_fingerprint تغییر کنند.
- تغییر ترتیب ورودی‌هایی که canonicalization آن‌ها را unordered تعریف کرده: digest ثابت بماند.
- تغییر repository یا resource target: authorization_resource_digest تغییر کند.
- ورودی Unicode/line-ending/null/duplicate-path مطابق canonicalization version آزموده شود.

**نتیجه فعلی:** PROPOSED; canonicalization tests NOT_RUN.

## 3. SR-03 — تضمین replay و tombstone

### گزینه‌های قراردادی

**گزینه A — تضمین نامحدود:** کلیدهای استفاده‌شده یا tombstoneهای فشرده به‌صورت دائمی/تا پایان عمر namespace نگهداری شوند. هزینه storage و retention باید اندازه‌گیری و تصویب شود.

**گزینه B — تضمین محدود:** replay protection فقط تا افق retention مصوب تضمین شود. پس از پایان افق، کلاینت باید namespace epoch یا idempotency key جدید به‌کار ببرد. سیستم نباید ادعای جلوگیری از duplicate برای کلیدهایی کند که همه شواهد آن‌ها حذف شده است.

### قاعده fail-closed پیشنهادی تا زمان تصمیم مالک

- UNKNOWN و IN_PROGRESS هرگز با TTL عادی حذف نمی‌شوند.
- tombstone مربوط به عملیات حل‌شده تا تعیین افق retention مصوب حذف نمی‌شود.
- IDEMPOTENCY_EXPIRED فقط وقتی قابل بازگرداندن است که رکورد/tombstone/epoch کافی برای تشخیص کلید منقضی وجود داشته باشد.
- پس از حذف تمام شواهد، سیستم نمی‌تواند همان کلید را از یک کلید جدید تشخیص دهد؛ این محدودیت باید صریحاً اعلام شود.
- اگر retention یا replay horizon تعیین نشده، admission write غیرفعال می‌ماند.

### تصمیم باز مالک

مالک باید A یا B را انتخاب کند و برای B مدت دقیق، namespace epoch، رفتار کلاینت و مسئولیت migration را تعیین کند. این amendment به‌جای مالک انتخاب نمی‌کند.

### آزمون‌های الزامی

- replay پیش از expiry؛
- replay در دوره tombstone؛
- replay پس از expiry ولی پیش از tombstone purge؛
- replay پس از purge و تغییر epoch؛
- تلاش برای حذف UNKNOWN؛
- quota exhaustion ناشی از unresolvedها.

**نتیجه فعلی:** OWNER DECISION REQUIRED; NOT_RUN.

## 4. SR-04 — تکمیل R2 با fault injection پاسخ ازدست‌رفته

آزمایش duplicate POST با پاسخ دریافت‌شده، آزمون response-loss محسوب نمی‌شود.

### آزمایش‌های افزوده

برای tree، commit، ref و PR هرکدام یک سناریوی مستقل تعریف شود:

1. درخواست به endpoint آزمایشی GitHub ارسال شود.
2. harness کنترل‌شده تأیید کند upstream درخواست را پذیرفته/اثر را ایجاد کرده است.
3. پاسخ upstream پیش از رسیدن به caller عمداً drop یا connection reset شود.
4. caller باید نتیجه را UNKNOWN ثبت کند.
5. فقط GET/reconciliation اجرا شود؛ resend کورکورانه ممنوع.
6. evidence خارجی با repository، branch/ref، head/base، marker، request_fingerprint و content digest تطبیق داده شود.
7. نتیجه هر endpoint جداگانه طبقه‌بندی شود: IDEMPOTENT، DETECTABLE، AMBIGUOUS یا UNKNOWN.

### محدودیت

اگر harness نتواند پذیرش upstream و از دست رفتن پاسخ را مستقل اثبات کند، آن آزمایش معتبر نیست و نتیجه UNKNOWN باقی می‌ماند. تکرار درخواست از یک client عادی به‌تنهایی جایگزین fault injection نیست.

### ایمنی

- فقط repository آزمایشی غیرتولیدی؛
- credential محدود به همان repository؛
- داده بی‌خطر؛
- عدم استفاده از main یا داده مشتری؛
- ثبت شواهد غیرمحرمانه و حذف هر token از log.

**نتیجه فعلی:** R2 EXTENDED PROPOSAL; NOT_RUN.

## 5. SR-05 — محدوده و اتمیک بودن audit chain

### مدل پیشنهادی

1. chain باید partition scope صریح داشته باشد؛ پیشنهاد اولیه: هر WriteControl DO یک chain مستقل با partition_id ثابت داشته باشد.
2. sequence allocation، previous_hash، event_hash و append رویداد باید در همان مرز storage transaction تعریف‌شده انجام شود.
3. تغییر state عملیاتی که الزام audit دارد باید در همان DO transaction با append رویداد متناظر commit شود؛ یا هیچ‌کدام commit نشوند.
4. این ادعا فقط در محدوده همان DO و API تراکنشی واقعی مجاز است. هیچ atomicity بین دو DO یا بین DO و GitHub ادعا نمی‌شود.
5. برای رخدادهای cross-DO از outbox/inbox پایدار با event_id، deduplication و reconciliation استفاده شود؛ نه ادعای تراکنش توزیع‌شده.
6. verifier باید partition_id، sequence، previous_hash و event_hash را بررسی کند و محدوده اعتبار را در گزارش نشان دهد.
7. fork یا gap در chain باید INTEGRITY_FAILURE یا INTEGRITY_UNKNOWN مطابق شواهد تولید کند؛ هرگز VALID اعلام نشود.

### تصمیم باز

اگر مالک partition دیگری (مثلاً tenant-level) می‌خواهد، باید ظرفیت، ordering و atomicity آن جداگانه تحلیل شود. global chain بین چند DO در این سند فرض نشده است.

### آزمون‌های الزامی

- admission هم‌زمان پرتعداد؛
- crash بین ساخت event و commit؛
- storage failure هنگام sequence allocation؛
- duplicate event؛
- حذف/جابجایی event؛
- cross-DO outbox replay؛
- verifier روی chain سالم، ناقص و forkشده.

**نتیجه فعلی:** PROPOSED; NOT_RUN.

## 6. SR-06 — قالب قطعی operation_id و branch

### قالب پیشنهادی برای نسخه اولیه

- operation_id: پیشوند op_ به‌علاوه ۳۲ رقم hexadecimal کوچک، تولیدشده با مولد تصادفی رمزنگارانه ۱۲۸ بیتی.
- نمونه صرفاً نمایشی: op_0123456789abcdef0123456789abcdef
- یکتایی: دامنه سراسری سامانه به‌صورت احتمالاتی؛ collision check در admission الزامی.
- شناسه پس از admission immutable است.
- branch: assistant/op-{32-hex}؛ فقط حروف کوچک، ارقام و جداکننده‌های ثابت.
- branch name پیش از هر dispatch در WriteControl ذخیره می‌شود.
- شناسه نامعتبر، طول نامعتبر یا collision باید پیش از هر write خارجی رد شود.
- کوتاه‌سازی operation_id ممنوع است.

### محدودیت

این قالب پیشنهاد است و نیازمند تأیید مالک و اعتبارسنجی با قواعد Git ref و API مورد استفاده است. UUID/ULID یا قالب دیگر بدون ثبت تصمیم و آزمون جایگزین نشود.

### آزمون‌های الزامی

- alphabet/length validation؛
- collision simulation؛
- branch ref validation؛
- دو operation مستقل؛
- replay همان operation؛
- branch موجود با marker یا digest ناسازگار.

**نتیجه فعلی:** PROPOSED; NOT_RUN.

## 7. SR-07 — کمینه‌سازی مجوز reconciler

### مدل پیشنهادی

- هویت reconciler از dispatcher write جدا باشد.
- credential reconciler فقط read permission لازم برای مشاهده metadata، contents/commits/refs و pull requests در repositoryهای مجاز را داشته باشد؛ سطح دقیق permission باید با API endpointهای واقعی و نوع credential (GitHub App یا fine-grained token) تطبیق داده شود.
- reconciler نباید contents write، pull-request write، administration، workflow write یا delete permission داشته باشد.
- capability داخلی reconcile فقط GET/observation و ثبت evidence/state transition مجاز را پوشش دهد؛ هیچ dispatch جدیدی مجاز نیست.
- هر نیاز به endpointی که permission گسترده‌تر می‌خواهد باید به‌عنوان exception جداگانه ثبت و توسط مالک تصویب شود؛ پیش‌فرض deny است.
- secret value در سند، log یا audit ذخیره نشود؛ فقط credential identifier/version غیرمحرمانه ثبت شود.

### آزمون‌های الزامی

- همه GETهای لازم با credential read-only موفق باشند؛
- POST/PATCH/PUT/DELETE با همان credential رد شوند؛
- reconciler نتواند از capability داخلی به dispatcher write دسترسی پیدا کند؛
- credential revoke شده باعث fail-closed شود.

**نتیجه فعلی:** PROPOSED; endpoint permission verification NOT_RUN.

## 8. SR-08 — revoke race پس از dispatch-intent

این مورد با طراحی داخلی به‌طور کامل حذف‌شدنی نیست؛ چون GitHub و Durable Object تراکنش مشترک ندارند.

### قاعده پیشنهادی

1. پیش از dispatch permit، authorization تازه بررسی شود.
2. intent باید created_at و expires_at محدود داشته باشد؛ مقدار max-age باید توسط مالک تصویب شود.
3. intent منقضی‌شده هرگز dispatch نشود؛ ابتدا re-authorize و intent تازه ثبت شود.
4. در صورت امکان، یک re-authorization نهایی بلافاصله پیش از network send انجام شود.
5. پس از آخرین check نیز یک race بسیار کوتاه تا پذیرش upstream باقی می‌ماند؛ هیچ ادعای revocation اتمیک یا cancellation از راه دور مجاز نیست.
6. revoke پیش از آخرین check باید dispatch را متوقف کند.
7. revoke پس از ارسال/پذیرش upstream عملیات خارجی را خودبه‌خود لغو نمی‌کند؛ recovery و در صورت لزوم compensation فقط از مسیر مجاز و مستقل انجام می‌شود.

### تصمیم صریح مالک

مالک باید residual risk را با آگاهی از مرز زیر ACCEPT یا REJECT کند:
- ACCEPT: پذیرش race محدود و مستند بین آخرین authorization check و پذیرش upstream؛ با max-age، audit و reconciliation.
- REJECT: تا زمانی که راهکار مقصد-محور یا کنترل قوی‌تر فراهم نشده، write خارجی فعال نشود.

عدم پاسخ یا سکوت به معنی ACCEPT نیست.

### آزمون‌های الزامی

- revoke پیش از authorization check؛
- revoke پس از intent و پیش از final check؛
- revoke پس از final check و پیش از network send؛
- revoke پس از upstream acceptance؛
- intent expiry و جلوگیری از dispatch stale.

**نتیجه فعلی:** DISPUTED / OWNER DECISION REQUIRED; NOT_RUN.

## 9. ماتریس ردیابی SR به اصلاح و تست

| Finding | Amendment section | Required tests | Owner decision |
|---|---|---|---|
| SR-01 | §1 | SR01-T1..T4 | پذیرش محدودیت مقصد خارجی |
| SR-02 | §2 | digest/canonicalization suite | تأیید semantics digest |
| SR-03 | §3 | replay/retention suite | انتخاب A یا B |
| SR-04 | §4 | response-loss tests per endpoint | مجوز اجرای آزمایش غیرتولیدی |
| SR-05 | §5 | concurrency/transaction/verifier suite | تأیید chain partition |
| SR-06 | §6 | ID/ref validation suite | تأیید operation_id format |
| SR-07 | §7 | read-only permission suite | تأیید credential model |
| SR-08 | §8 | revoke-race suite | ACCEPT یا REJECT صریح |

## 10. وضعیت دروازه‌ها

- R1-A original: حفظ‌شده برای provenance.
- R1-A Amendment 01: PROPOSED؛ هنوز owner-approved نیست.
- R1-B: NOT_COMPLETE؛ D-01 تا D-16 و تصمیم‌های این amendment نیازمند تعیین تکلیف مالک‌اند.
- R1-C: NOT_RUN؛ بازبین مستقل باید هر دو سند پایه و amendment را روی blobهای دقیق بررسی کند.
- R2: NOT_RUN؛ تمام رفتارهای مشاهده‌نشده UNKNOWN هستند.
- Code implementation: NOT_AUTHORIZED.
- PR / merge / staging write / production deployment: NOT_AUTHORIZED.

## 11. معیار خروج

هیچ implementation gate باز نمی‌شود مگر اینکه:
1. مالک تصمیم‌های لازم را صریح ثبت کند؛
2. بازبین مستقل نسخه دقیق هر دو سند را بررسی کند؛
3. R2 در محیط غیرتولیدی اجرا و شواهد قابل بازتولید ارائه شود؛
4. آزمون‌های طراحی و امنیتی مشخص و سپس آزمون‌های پیاده‌سازی اجرا شوند؛
5. تمام BLOCKERها بسته یا به‌طور صریح با پذیرش ریسک مجاز تعیین تکلیف شوند.

**نتیجه:** PROPOSED AMENDMENT — NOT APPROVED — NOT IMPLEMENTED — NOT TESTED.
