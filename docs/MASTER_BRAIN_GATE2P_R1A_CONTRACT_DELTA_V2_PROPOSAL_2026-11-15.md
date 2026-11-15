# Master Brain — Gate 2P / R1-A: قرارداد Delta v2 (پیش‌نویس تکمیل‌شده)

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**شناسه:** MB-G2P-R1A-2026-11-15  
**وضعیت:** PROPOSAL — FOR OWNER DECISION AND INDEPENDENT REVIEW  
**مبنای ممیزی:** Gate 2O-C / MB-G2O-C-2026-11-15  
**Snapshot مبنا:** 5d55336feef7f27c3ec8b02bb7b8dab4dab0d768  
**شاخه مبنا:** integration/master-brain-unification-2026-11-15  
**مرجع main:** 919b19ca3d3887352cdef06b03c668ead04fbce7

## 0. وضعیت، دامنه و محدودیت

این سند تکمیل پیشنهادی Deltaهای قرارداد Unified Write Execution است. این سند:
- تصمیم مالک محسوب نمی‌شود؛
- قرارداد v2 نهایی یا frozen نیست؛
- مجوز پیاده‌سازی، تغییر کد، PR، merge یا deployment صادر نمی‌کند؛
- هیچ تستی را اجراشده یا موفق اعلام نمی‌کند؛
- هیچ secret، credential یا مقدار محرمانه‌ای را نمی‌خواند یا تغییر نمی‌دهد.

تمام آزمون‌های اجرایی این سند در وضعیت NOT_RUN هستند. هر رفتار GitHub که در R2 مشاهده نشده باشد UNKNOWN باقی می‌ماند.

### اصول غیرقابل‌تغییر

1. TenantDirectory مرجع policy و membership است؛ WriteControl فقط شاهد immutable تصمیم مجوز را نگه می‌دارد و policy را cache یا مالکیت نمی‌کند.
2. WriteControl مالک lifecycle عملیات write خارجی است؛ OrchestratorLedger مالک task/outbox orchestration باقی می‌ماند.
3. GitHub مرجع حقیقت وضعیت اشیای خارجی است؛ state داخلی باید با شواهد GitHub reconcile شود.
4. UNKNOWN نه موفقیت است نه شکست و نباید با retry کورکورانه به نتیجه دیگری تبدیل شود.
5. هر مرحلهٔ خارجی باید از نظر retryability، detectability و ambiguity جداگانه طبقه‌بندی شود.
6. نبود شاهد یا اجرای‌نشدن تست، نتیجه را UNKNOWN / NOT_RUN نگه می‌دارد.

## 1. تصمیم‌های پیشنهادی

### D-01 — ممنوعیت wildcard در write-time

**قاعده پیشنهادی:** برای هر action نوشتنی، ابتدا project.create_pr، تابع upsertProjectPolicy باید resource digest دقیق SHA-256 را الزام کند. مقدار '*' برای write action باید با خطای مشخص رد شود. این ممنوعیت در write-time اعمال می‌شود؛ precedence جایگزین آن نیست.

**داده‌های قدیمی:** ruleهای wildcard موجود نباید بی‌صدا حذف یا بازتفسیر شوند. migration باید:
- rule را به حالت disabled منتقل کند؛
- شناسه و مشخصات غیرمحرمانه rule را در audit ثبت کند؛
- تعداد و نتیجه migration را گزارش کند؛
- در اجرای مجدد idempotent باشد؛
- در صورت شکست audit یا migration، transaction را rollback کند یا وضعیت migration را صریحاً ناقص و fail-closed نگه دارد.

**معیار پذیرش:** upsert با '*' برای write action رد؛ authorize با wildcard قدیمی deny؛ migration تکراری بدون اثر مضاعف؛ exact digest معتبر مطابق policy بررسی شود.

**یافته مرتبط:** F-02.  
**وضعیت:** PROPOSED; implementation and tests NOT_RUN.

### D-02 — branch قطعی و مالکیت بدون ابهام

**قاعده پیشنهادی:** operation_id در زمان admission ساخته و immutable شود. نام branch از شناسه کامل operation مشتق شود، نه UUID تصادفی تازه در هر retry. قالب پیشنهادی: assistant/op-{operation_id}. تا زمانی که قالب و charset نهایی نشده، هیچ کوتاه‌سازی یا prefix دلخواه مجاز نیست.

**قواعد ایمنی:**
- operation_id باید یکتا، غیرقابل‌تغییر و به‌صورت امن تولید شود.
- نام branch پیش از ثبت BRANCH_DISPATCHED در رکورد پایدار WriteControl ذخیره شود.
- اگر branch وجود دارد، reconciler باید operation marker و request digest را با رکورد محلی تطبیق دهد.
- branch موجود با marker یا digest متفاوت، CONFLICT است؛ هرگز تصاحب، force-update یا بازنویسی نشود.
- هرگونه کوتاه‌سازی آینده باید تحلیل احتمال تصادم، دامنه یکتایی و تست collision داشته باشد؛ در نسخه اولیه استفاده از شناسه کامل ارجح است.

**معیار پذیرش:** retry همان operation همان branch را می‌سازد؛ دو operation مستقل branch متفاوت دارند؛ branch موجود متعلق به operation دیگر باعث توقف CONFLICT می‌شود.

**یافته مرتبط:** F-04.  
**وضعیت:** PROPOSED; GitHub behavior NOT_VERIFIED.

### D-03 — marker قابل تطبیق، نه اثبات مستقل

**قاعده پیشنهادی:** commit message و PR body باید شامل operation_id و request_digest غیرحساس باشند. marker باید canonical، versioned و قابل parse باشد.

**محدودیت امنیتی:** marker به‌تنهایی مدرک اصالت نیست؛ باید با branch name، head SHA، base، repository، operation record و محتوای مورد انتظار تطبیق داده شود. marker قابل جعل یا کپی است و نباید به‌تنهایی مبنای پذیرش موفقیت باشد.

**معیار پذیرش:** reconciler فقط در صورت تطبیق کامل مجموعه شواهد، operation را به مرحله بعد ببرد؛ mismatch به CONFLICT یا UNKNOWN منجر شود، نه success.

**یافته مرتبط:** F-04.  
**وضعیت:** PROPOSED; tests NOT_RUN.

### D-04 — determinism مربوط به tree/commit مشروط به R2

**قاعده پیشنهادی:** تا پایان R2، resend کورکورانه برای هر POST با نتیجه مبهم ممنوع است. deterministic بودن commit صرفاً با ثابت بودن timestamp ادعا نمی‌شود.

برای بررسی determinism، تمام ورودی‌های مؤثر باید ثبت و ثابت باشند:
- tree SHA؛
- ordered parent commit SHAها؛
- commit message و marker؛
- author identity؛
- author timestamp و timezone؛
- committer identity؛
- committer timestamp و timezone؛
- encoding و هر فیلد دیگری که در serialization commit اثر می‌گذارد.

**طبقه‌بندی موقت:** tree، commit، ref و PR هرکدام باید جداگانه در یکی از این دسته‌ها قرار گیرند:
- IDEMPOTENT: تکرار همان درخواست، اثر خارجی جدید و متفاوت ایجاد نمی‌کند؛
- DETECTABLE: نتیجه مبهم با GET و شواهد کافی قابل کشف است؛
- AMBIGUOUS: شواهد کافی برای تصمیم قطعی وجود ندارد.

یک مرحله ممکن است هم detectable و هم non-idempotent باشد؛ این دو ویژگی مترادف نیستند.

**معیار پذیرش:** فقط نتایج مشاهده‌شده R2 می‌توانند طبقه‌بندی نهایی را تعیین کنند. هر مورد آزموده‌نشده UNKNOWN می‌ماند.

**یافته مرتبط:** F-04.  
**وضعیت:** OPEN UNTIL R2.

### D-05 — decision record مستقل برای هر درخواست

**قاعده پیشنهادی:** در admission، یک authorization decision snapshot مستقل برای هر operation ذخیره شود. این snapshot حداقل شامل موارد زیر است:
- operation_id؛
- request_digest؛
- tenant_id؛
- principal_type و principal_id؛
- project_id؛
- action؛
- resource_digest؛
- membership_version؛
- policy_version؛
- rule_id؛
- decision_id یکتای همان درخواست؛
- decision outcome و reason code؛
- زمان تصمیم از مرجع مجاز سمت سرور؛
- شناسه/نسخه credential غیرمحرمانه در صورت وجود.

شناسه فعلی که در سطح rule تولید می‌شود باید rule_id نامیده شود، نه decisionId. decision_id برای هر درخواست مستقل است.

**مالکیت:** TenantDirectory تصمیم مجوز را تولید می‌کند؛ WriteControl snapshot پاسخ را به‌عنوان evidence ذخیره می‌کند. ذخیره snapshot به معنی cache کردن policy یا واگذاری authority نیست.

**معیار پذیرش:** دو درخواست مستقل تحت یک rule دو decision record متمایز دارند؛ امکان بازسازی اینکه چه نسخه‌ای از membership/policy برای هر operation پاسخ داده است وجود دارد.

**یافته مرتبط:** F-03 و F-07.  
**وضعیت:** PROPOSED; tests NOT_RUN.

### D-06 — پوشش کامل resource و request fingerprint

**قاعده پیشنهادی:** canonical resource و request fingerprint باید همه فیلدهایی را پوشش دهند که بر مجوز، محتوای خارجی یا اثر عملیات اثر می‌گذارند؛ از جمله:
- repository canonical identity؛
- base branch؛
- title؛
- summary؛
- pathهای فایل؛
- محتوای فایل یا digest محتوای canonical؛
- expected blob SHA و preconditionها؛
- action و schema version.

Canonicalization باید versioned، deterministic و دارای قواعد روشن برای Unicode normalization، ترتیب pathها، separatorها، newlineها، encoding، null/empty و duplicate path باشد. دو JSON که از نظر معنایی یکسان‌اند باید fingerprint یکسان داشته باشند؛ ورودی‌های معنایی متفاوت نباید به‌علت حذف فیلد fingerprint یکسان بگیرند.

**معیار پذیرش:** تغییر یک بایت summary یا هر فیلد مؤثر، digest متفاوت تولید کند؛ تغییر صرفاً ظاهری که طبق canonicalization بی‌اثر تعریف شده digest را تغییر ندهد.

**یافته مرتبط:** F-07 و F-03.  
**وضعیت:** PROPOSED; canonicalization specification and tests NOT_RUN.

### D-07 — مرجع زمان و fencing

**قاعده پیشنهادی:** caller حق ارسال یا override کردن now را ندارد. زمان تصمیم‌گیری lease فقط از داخل WriteControl DO خوانده شود.

تفکیک مفاهیم:
- server_wall_clock: زمان دیواری خوانده‌شده در محیط WriteControl؛
- lease_generation: شمارنده افزایشی و مرجع اصلی fencing؛
- lease_until: زمان انقضای lease بر مبنای server_wall_clock؛
- observed_at: زمان ثبت رویداد audit.

**قواعد:**
- هر claim موفق generation را افزایش می‌دهد.
- تمام mutationهای وابسته به lease باید worker_id و generation فعلی را در CAS بررسی کنند.
- renew پس از expiry مجاز به احیای lease منقضی نیست.
- worker با generation قدیمی حتی اگر ساعت عقب‌افتاده ارائه کند، حق تغییر state ندارد.
- Date.now ساعت دیواری است و monotonic بودن آن فرض نمی‌شود؛ در صورت مشاهده زمان نامعتبر/عقب‌گرد غیرقابل‌قبول، عملیات حساس fail-closed و audit شود.
- زمان ورودی از worker یا caller برای اعتبارسنجی lease پذیرفته نشود.

**معیار پذیرش:** stale worker و stale generation رد؛ renew پس از انقضا رد؛ آزمون clock rollback و boundary اجرا شود.

**یافته مرتبط:** F-05.  
**وضعیت:** PROPOSED; tests NOT_RUN.

### D-08 — re-authorization و مرز dispatch

**قاعده پیشنهادی:** قبل از هر dispatch خارجی جدید و در هر replay یا ادامه UNKNOWN، authorization تازه از TenantDirectory درخواست شود. عدم دسترسی به Directory، timeout یا پاسخ نامعتبر به معنی deny موقت و fail-closed است؛ عملیات به حالت قابل‌بازیابی/UNKNOWN منتقل شود و write جدید dispatch نشود.

**محدودیت توزیع‌شده:** چون TenantDirectory و WriteControl دو DO جدا هستند، بررسی policy و ثبت dispatch در یک تراکنش اتمیک مشترک نیست. بنابراین نمی‌توان ادعا کرد revoke در تمام فاصله‌ها به‌صورت اتمیک با GitHub POST رقابت می‌کند.

**مرز پیشنهادی:** WriteControl پس از دریافت تصمیم تازه، یک dispatch-intent پایدار و غیرقابل‌تغییر ثبت می‌کند. ثبت این intent نقطه تصمیم داخلی برای پذیرش تلاش dispatch است؛ اما ارسال شبکه‌ای ممکن است پس از آن انجام شود. revoke پس از این نقطه، درخواست در حال ارسال یا ارسال‌شده را به‌طور جادویی لغو نمی‌کند. این ریسک باید در audit و release notes ثبت شود.

**قواعد تکمیلی:**
- dispatch-intent باید به decision snapshot و policy/membership version متصل باشد.
- اگر revoke پیش از re-check مشاهده شود، dispatch جدید ممنوع است.
- اگر پاسخ re-check نامعلوم باشد، dispatch ممنوع است.
- پس از dispatch-intent، recovery باید وضعیت خارجی را reconcile کند؛ retry خودکار فقط طبق طبقه‌بندی R2 مجاز است.
- لغو/compensation یک عملیات خارجی مستقل است و نباید با revoke مترادف فرض شود.

**معیار پذیرش:** revoke بین دو مرحله باعث توقف dispatch بعدی می‌شود؛ پاسخ نامعلوم Directory موجب fail-closed می‌شود؛ مرز in-flight و ریسک آن در audit قابل مشاهده است.

**یافته مرتبط:** F-06.  
**وضعیت:** PROPOSED; distributed race tests NOT_RUN.

### D-09 — artefactهای نیمه‌ساخته و cleanup

**قاعده پیشنهادی:** حذف خودکار tree، commit، ref یا PR پس از revoke، FAILED یا UNKNOWN ممنوع است. رکورد باید شناسه و شواهد artefact خارجی را نگه دارد و در صورت نیاز به cleanup، یک عملیات جداگانه با مجوز، تصمیم، audit و reconciliation مستقل ایجاد شود.

**معیار پذیرش:** هیچ DELETE ضمنی در مسیر failure/revoke/reconcile وجود نداشته باشد؛ cleanup فقط با policy و approval مستقل قابل اجرا باشد.

**یافته مرتبط:** F-06.  
**وضعیت:** PROPOSED; code review and tests NOT_RUN.

### D-10 — retention، UNKNOWN و replay پس از انقضا

**قاعده پیشنهادی:** UNKNOWN و IN_PROGRESS هرگز با TTL عادی حذف نمی‌شوند. سقف تعداد/سن UNKNOWN باید پارامتر عملیاتی مصوب داشته باشد؛ رسیدن به سقف باعث رد admission جدید در scope مربوط می‌شود، نه حذف خودکار unresolvedها.

سه دوره باید مستقل تعریف شوند:
1. نتیجه کامل idempotency؛
2. fingerprint/tombstone برای جلوگیری از replay ناخواسته؛
3. audit evidence.

**مسئله حل‌نشده:** اگر tombstone پس از یک مدت حذف شود، همان client key ممکن است دوباره پذیرفته شود. بنابراین تضمین replay protection فقط تا زمانی برقرار است که tombstone یا مکانیزم معادل آن وجود دارد. برای تضمین نامحدود، tombstone دائمی یا سازوکار namespace epoch/کلیدهای یک‌بارمصرف با دامنه و قواعد روشن لازم است؛ این انتخاب هنوز تصمیم مالک می‌خواهد.

**پیشنهاد محافظه‌کارانه:** پس از پایان idempotency window، پاسخ IDEMPOTENCY_EXPIRED بده و هرگز همان درخواست را بی‌صدا دوباره اجرا نکن. تا زمانی که tombstone معتبر است، کلید منقضی‌شده باید رد شود. حذف tombstone فقط پس از تصمیم صریح درباره مدت تضمین replay و پیامد آن مجاز است.

**معیار پذیرش:** replay در دوره نتیجه، نتیجه قبلی را می‌دهد؛ همان کلید با fingerprint متفاوت CONFLICT می‌دهد؛ replay پس از انقضا تا زمانی که tombstone موجود است IDEMPOTENCY_EXPIRED می‌دهد؛ UNKNOWN حذف نمی‌شود؛ quota نامشخص یا نامحدود به admission باز منجر نمی‌شود.

**یافته مرتبط:** F-10.  
**وضعیت:** OPEN OWNER DECISION REQUIRED.

### D-11 — hash-chain برای audit بدون ادعای tamper-proof

**قاعده پیشنهادی:** رویدادهای WriteControl و authorization decision evidence در یک زنجیره hash-linked ثبت شوند:
- previous_hash؛
- event_hash؛
- canonical event payload؛
- schema version؛
- sequence/ordering scope؛
- operation_id و event_id؛
- timestamp و actor/service identity غیرمحرمانه.

Verifier باید قطع زنجیره، ترتیب نامعتبر، hash mismatch و رکورد تکراری را شناسایی کند.

**محدودیت:** hash-chain در همان trust domain به‌تنهایی tamper-proof نیست؛ دارنده دسترسی کامل به storage ممکن است کل زنجیره را بازنویسی کند. external anchoring و trusted timestamp در این مرحله ادعا یا تضمین‌شده نیستند.

**معیار پذیرش:** دستکاری/حذف/جابجایی رکورد در آزمون verifier کشف شود؛ شکست audit در admission باعث rollback یا fail-closed شود.

**یافته مرتبط:** F-09.  
**وضعیت:** PROPOSED; verifier tests NOT_RUN.

### D-12 — credential lifecycle برای service-only v1

**قاعده پیشنهادی:** service-only v1 حفظ می‌شود؛ shared bearer هرگز human identity تلقی نمی‌شود. context و audit فقط شناسه و نسخه غیرمحرمانه credential را نگه می‌دارند.

رویه باید مالک و شواهد قابل ممیزی برای این موارد داشته باشد:
- صدور؛
- محل نگهداری؛
- دسترسی مجاز؛
- rotation؛
- revocation؛
- expiry؛
- emergency disable؛
- تشخیص استفاده از نسخه قدیمی؛
- ثبت رخدادها بدون secret.

هیچ secret در log، report، PR یا این سند قرار نمی‌گیرد. این سند secret را نمی‌خواند یا تغییر نمی‌دهد.

**معیار پذیرش:** رویه با شواهد غیرمحرمانه قابل آزمون باشد؛ credential غیرفعال دیگر دسترسی ندهد؛ audit فقط شناسه/نسخه غیرسری را نشان دهد.

**یافته مرتبط:** F-08 و تصمیم Gate 2M.  
**وضعیت:** OWNER/OPERATIONS DECISION REQUIRED; tests NOT_RUN.

### D-13 — quota و ظرفیت

**قاعده پیشنهادی:** quotaها باید دست‌کم این ابعاد را داشته باشند:
- tenant؛
- principal/service؛
- repository؛
- global emergency ceiling؛
- تعداد و سن UNKNOWN؛
- تعداد عملیات هم‌زمان و نرخ admission.

عددها نباید حدس زده شوند. قبل از فعال‌سازی WriteControl، ظرفیت مورد انتظار، peak load، storage growth، unresolved budget، هزینه DO و blast radius اندازه‌گیری و تصویب شود.

**Fail-closed:** مقدار quota نامشخص، نامعتبر یا نامحدود به معنی admission بسته است. سقف global emergency مستقل از سهمیه tenantها باقی می‌ماند.

**معیار پذیرش:** پیکربندی ناقص رد شود؛ tenant پرمصرف نتواند سهم دیگران را مصرف کند؛ global ceiling حتی در چند tenant برقرار بماند.

**یافته مرتبط:** F-12 و F-08.  
**وضعیت:** OPEN OWNER DECISION REQUIRED.

### D-14 — عدم cache کردن policy در WriteControl

**قاعده پیشنهادی:** WriteControl policy را منبع محلی یا cache معتبر تلقی نمی‌کند. فقط تصمیم تازه و evidence versioned از TenantDirectory را ذخیره می‌کند.

**معیار پذیرش:** هیچ مسیر authorization از policy محلی/قدیمی در WriteControl استفاده نکند؛ در نبود پاسخ تازه Directory، write جدید متوقف شود.

**یافته مرتبط:** ownership map و Gate 2N.  
**وضعیت:** PROPOSED.

### D-15 — هویت و capability برای reconciliation

**قاعده پیشنهادی:** reconciliation فقط توسط principal/service مشخص و دارای capability محدود اجرا شود. این capability باید فقط عملیات reconcile را مجاز کند و به‌تنهایی مجوز ایجاد write جدید، تغییر policy یا حذف artefact نباشد.

هر reconciliation attempt باید ثبت کند:
- reconciler principal و credential version غیرمحرمانه؛
- operation_id؛
- مرحله مورد بررسی؛
- query/observation خارجی و شناسه‌های غیرحساس؛
- زمان و نتیجه؛
- شواهد تطبیق یا mismatch؛
- تصمیم state transition و reason code.

مشاهده یک branch یا PR به‌تنهایی برای success کافی نیست. شواهد باید repository، branch، head/base، marker، request digest و محتوای مورد انتظار را به هم متصل کنند.

**معیار پذیرش:** reconciler فاقد capability رد شود؛ reconcile بدون write جدید انجام شود؛ تکرار reconcile اثر جانبی مضاعف نداشته باشد؛ mismatch به CONFLICT/UNKNOWN منجر شود.

**وضعیت:** PROPOSED; tests NOT_RUN.

### D-16 — verifier مستقل و وضعیت integrity

**قاعده پیشنهادی:** verifier مستقل از مسیر نوشتن، زنجیره audit را بررسی کند. نتیجه یکی از این وضعیت‌ها باشد:
- INTEGRITY_VALID — فقط برای محدوده‌ای که واقعاً بررسی شده؛
- INTEGRITY_FAILURE — شکست قطعی مانند hash mismatch یا قطع زنجیره؛
- INTEGRITY_UNKNOWN — شواهد ناکافی، verifier اجرا نشده یا checkpoint قابل اتکا وجود ندارد.

هیچ نتیجه‌ای نباید فراتر از محدوده بررسی‌شده تعمیم یابد. hash-chain داخلی معادل external anchoring نیست.

**معیار پذیرش:** verifier روی fixtureهای سالم و خراب اجرا شود؛ قطع زنجیره شناسایی شود؛ گزارش شامل محدوده، آخرین sequence و limitation باشد.

**وضعیت:** PROPOSED; tests NOT_RUN.

## 2. ماتریس وضعیت GitHub POSTها

| مرحله | ابهام پس از timeout | مشاهده/تطبیق پیشنهادی | retry مجاز |
|---|---|---|---|
| tree POST | ممکن است tree ساخته شده باشد | محاسبه/GET SHA و تطبیق کامل tree | فقط پس از اثبات رفتار R2 |
| commit POST | ممکن است commit ساخته شده باشد | محاسبه SHA از ورودی‌های کامل و GET commit | فقط پس از اثبات determinism در R2 |
| ref POST | branch ممکن است ساخته شده باشد | GET ref با نام قطعی؛ تطبیق head SHA و marker | ایجاد مجدد کورکورانه ممنوع؛ نتیجه موجود reconcile شود |
| PR POST | PR ممکن است ساخته شده باشد | جست‌وجوی head/base و تطبیق marker، repository و head SHA | ایجاد مجدد کورکورانه ممنوع؛ نتیجه موجود reconcile شود |

هیچ ردیف تا اجرای R2 قطعی تلقی نمی‌شود. خطای HTTP به‌تنهایی اثبات نمی‌کند که اثر خارجی ایجاد نشده است.

## 3. R2 — پروتکل آزمایش غیرتولیدی GitHub

**مسئول اجرا:** مالک یا اپراتور مجاز.  
**محیط:** repository آزمایشی غیرتولیدی، داده بی‌خطر و credential محدود به همان مخزن.  
**ممنوع:** اجرای آزمایش روی main، مخزن تولیدی، token تولیدی یا داده واقعی مشتری.

### پیش‌شرط و ثبت شواهد

پیش از آزمایش، این موارد ثبت شوند:
- تاریخ/زمان UTC؛
- repository آزمایشی و مالک آن؛
- GitHub API version و Accept header؛
- endpoint و روش HTTP؛
- ورودی canonical و digest؛
- response status، response body غیرمحرمانه و request/correlation ID؛
- نتیجه GET پس از درخواست؛
- هر شیء خارجی ایجادشده.

هیچ token یا secret نباید در خروجی ثبت شود.

### آزمایش‌ها

1. tree POST دو بار با ورودی یکسان؛ SHA و اثر خارجی مقایسه شود.
2. commit POST دو بار با parent/tree/message/author/committer/date/encoding یکسان؛ SHA مقایسه شود.
3. ref POST دوم با همان نام؛ status و body واقعی ثبت شود؛ سپس GET ref اجرا شود.
4. PR POST دوم با همان head/base؛ status و body واقعی ثبت شود؛ سپس جست‌وجوی PR با head/base انجام شود.
5. پس از هر آزمایش، GETهای لازم برای تشخیص سازگاری وضعیت خارجی اجرا شوند.

### جدول نتیجه اجباری

| Test | Observation | HTTP/API evidence | GET evidence | Classification | Verdict |
|---|---|---|---|---|---|
| R2-01 tree duplicate | UNKNOWN | NOT_RUN | NOT_RUN | UNKNOWN | NOT_RUN |
| R2-02 commit duplicate | UNKNOWN | NOT_RUN | NOT_RUN | UNKNOWN | NOT_RUN |
| R2-03 ref duplicate | UNKNOWN | NOT_RUN | NOT_RUN | UNKNOWN | NOT_RUN |
| R2-04 PR duplicate | UNKNOWN | NOT_RUN | NOT_RUN | UNKNOWN | NOT_RUN |
| R2-05 GET consistency | UNKNOWN | NOT_RUN | NOT_RUN | UNKNOWN | NOT_RUN |

فقط مشاهدات واقعی جایگزین UNKNOWN شوند. نتیجه یک API version یا یک محیط به نسخه‌ها/محیط‌های دیگر تعمیم داده نشود.

## 4. ماتریس تست پس از پیاده‌سازی

همه موارد در زمان نگارش NOT_RUN هستند:

- T-01 رد wildcard در upsert برای write action.
- T-02 migration wildcard و idempotency اجرای مجدد.
- T-03 tenant isolation با client key یکسان.
- T-04 principal isolation با client key یکسان.
- T-05 replay درخواست یکسان و conflict درخواست متفاوت.
- T-06 دو درخواست هم‌زمان و تضمین یک operation.
- T-07 revoke بین مراحل و توقف پیش از dispatch بعدی.
- T-08 stale lease، generation قدیمی و clock rollback.
- T-09 crash پس از هر dispatch-intent و ثبت UNKNOWN.
- T-10 پاسخ مبهم خارجی و منع تبدیل خودکار به FAILED/SUCCEEDED.
- T-11 reconcile چندباره بدون اثر جانبی مضاعف.
- T-12 شکست audit و rollback/fail-closed admission.
- T-13 quota exhaustion در tenant و global scope.
- T-14 replay پس از انقضای idempotency و tombstone.
- T-15 قطع یا دستکاری hash-chain و کشف توسط verifier.
- T-16 marker mismatch و branch collision.
- T-17 credential revocation و emergency disable.
- T-18 عدم دسترسی TenantDirectory هنگام re-authorization.
- T-19 reconcile بدون capability و تلاش برای write/delete.
- T-20 migration و recovery پس از crash.

## 5. تصمیم‌های صریحاً باز برای مالک

این موارد نباید توسط نویسنده سند یا بازبین به‌صورت ضمنی انتخاب شوند:

1. مدت نگهداری نتیجه idempotency، fingerprint/tombstone و audit evidence.
2. آیا replay protection نامحدود لازم است یا پنجره زمانی مشخص پذیرفته می‌شود؟
3. عدد سقف UNKNOWN، quotaها و ظرفیت DO.
4. credential authority و مالک عملیاتی rotation/revocation/emergency disable.
5. policy نهایی cleanup artefactهای نیمه‌ساخته؛ پیشنهاد فعلی: عدم حذف خودکار.
6. capability و هویت reconciler.
7. دامنه و تناوب external audit anchoring و trusted timestamp.
8. پذیرش ریسک revoke پس از dispatch-intent.
9. نتیجه واقعی R2 برای هر GitHub POST.
10. فرمت نهایی operation_id و branch name؛ پیشنهاد فعلی استفاده از شناسه کامل operation.

## 6. ترتیب دروازه‌ها

### Gate 2P-R1-A — تکمیل پیش‌نویس
این سند فقط delta پیشنهادی را منسجم می‌کند. وضعیت: PROPOSAL.

### Gate 2P-R1-B — تصمیم مالک
مالک باید هر D-01 تا D-16 را جداگانه ACCEPT / MODIFY / REJECT / DEFER کند. سکوت یا ادامه کار به معنی approval نیست.

### Gate 2P-R1-C — بازبینی مستقل
بازبین مستقل باید نسخه دقیق این سند و snapshot مبنا را بررسی کند؛ به‌ویژه:
- determinism و recovery؛
- semantics مربوط به dispatch/revoke؛
- retention و replay horizon؛
- canonicalization؛
- ownership و trust boundaries؛
- audit integrity و reconciler capability.

### Gate 2P-R2 — آزمایش GitHub
R2 فقط در repository آزمایشی غیرتولیدی توسط مالک/اپراتور مجاز انجام شود. نتایج مشاهده‌نشده UNKNOWN می‌مانند.

### Gate 2P-R3 — wildcard remediation
هر تغییر کد برای رد wildcard و migration به مجوز مستقل و PR جداگانه نیاز دارد.

### Gate 2P-R4 — credential lifecycle
پیش از هر staging write، رویه و شواهد lifecycle باید تکمیل شود؛ بدون خواندن یا افشای secret در گزارش.

### Gate 2P-R5 — درخواست مجوز پیاده‌سازی staging-only
فقط پس از بسته‌شدن موارد لازم، تست‌های مشخص و بازبینی مستقل، درخواست مجوز مجزا برای پیاده‌سازی staging-only پشت feature flag ارائه شود.

## 7. معیار خروج و release gate

**تا پیش از تکمیل R1-B، R1-C، R2، R3 و R4:**
- پیاده‌سازی WriteControl ممنوع؛
- تغییر مسیر write فعلی ممنوع؛
- PR/merge ممنوع؛
- staging write ممنوع؛
- production deployment ممنوع.

عبور به staging-only به معنی production approval نیست. production فقط پس از اجرای ماتریس تست، شواهد قابل بازتولید، بازبینی مستقل، credential lifecycle آزموده‌شده، ظرفیت و rollback plan قابل بررسی خواهد بود.

## 8. وضعیت نهایی این سند

**PROPOSAL — NOT APPROVED — NOT IMPLEMENTED — NOT TESTED**

این سند فقط یک artifact مستنداتی است. هیچ تصمیم مالک، تست، اصلاح کد، PR، merge، secret operation یا deployment را ثبت نمی‌کند.
