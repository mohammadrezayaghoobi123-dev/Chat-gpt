# CTP runner — مرز اعتماد و روش استفاده

**وضعیت:** کتابخانه (`master_brain.ctp_runner`)، آزمون‌شده، هنوز به هیچ API/CLI اپراتوری وصل نیست.

## مدل تهدید
| عامل | چه می‌تواند بکند | چه چیزی جلویش را می‌گیرد | چه چیزی **نمی‌گیرد** |
|---|---|---|---|
| کد آزمون (غیرقابل‌اعتماد) | شبکه، خواندن فایل‌های میزبان، نوشتن بیرون، ماندن پس از timeout، پر کردن حافظه/دیسک/خروجی | sandbox کاوش‌شده (userns/net/pid/mount)، RLIMIT، kill گروه فرایند، سقف خروجی | اکسپلویت هسته، مصرف CPU تا سقف RLIMIT_CPU، کمبود cgroup |
| اجراکننده | ادعای نتیجهٔ دروغ | نتیجه فقط با بازاجرای مستقل و امضا معتبر می‌شود | اجراکننده و تأییدکننده روی یک میزبانند |
| تأییدکننده | تأیید خودش، کلید جعلی/باطل/متعلق به دیگری، حکم دروغ | هویت متمایز، کلید بسته به `verifier:<id>`، بازاستنتاج حکم از اثر انگشت‌ها | تأییدکنندهٔ دارای کلید معتبر که هم‌زمان میزبان را کنترل کند |
| مدیر میزبان | همه‌چیز | — | **هیچ**؛ زنجیرهٔ هش برابر ثبت تغییرناپذیر مطلق نیست |

## استفاده
```python
spec = TestSpec(argv=(py, "-I", "code/t.py"), criterion="...", code=(("t.py", b"..."),),
                inputs=(), ro_paths=python_ro_paths(), timeout_s=10, memory_bytes=512 << 20)
rec = execute_and_record(store, spec, case_id="c1", test_id="t1", runner_id="runner-a")
verify_by_rerun(store, spec, case_id="c1", test_id="t1", original_execution_id=rec.execution_id,
                verifier_id="verifier-b", signer=signer_b)   # trust store: key bound to "verifier:verifier-b"
case = apply_to_case(case, store, trust_store, "t1")          # PASS/FAIL only if verified_reproduced
```
قرارداد: خروج ۰ = معیار برقرار؛ ۱۷ = معیار برقرار نشد؛ هر چیز دیگر = نتیجهٔ نامعلوم.
در سیستمی که sandbox ندارد `SandboxUnavailable` می‌گیرید و چیزی اجرا نمی‌شود.
