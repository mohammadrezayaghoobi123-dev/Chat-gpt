# راهنمای بازیابی تأییدکننده (Approver Recovery Runbook)

هدف: وقتی تنها تأییدکننده گذرواژه یا کلید امضای خود را گم کند، سرور بدون دست‌زدن به لاگ‌ها دوباره قابل‌استفاده شود.
همهٔ دستورها با ابزارهای **موجود** در مخزن آزمایش شده‌اند؛ هیچ مرحله‌ای تاریخچهٔ ممیزی را تغییر نمی‌دهد.
حالت مسیر: `DATA` = پوشهٔ داده‌ای که با `--data-dir` به سرور داده‌اید.

## ۱) وضعیت را ببینید
شروع سرور هشدار می‌دهد اگر: هیچ حساب تأییدکننده نباشد؛ هیچ تأییدکننده‌ای کلید امضا نداشته باشد؛ یا فقط **یک** تأییدکنندهٔ واقعاً توانا باشد.
بخش «مدیریت» وب (فقط اپراتور) فهرست حساب‌ها و نقش‌ها را فقط‌خواندنی نشان می‌دهد.

## ۲) گذرواژه گم شد (کلید سالم است)
```
python -m master_brain.accounts --db DATA/accounts.sqlite passwd --subject user:boss --password-stdin
```
نشست‌های قدیمی با تغییر گذرواژه از اعتبار می‌افتند (رفتار آزموده‌شدهٔ سرور).

## ۳) کلید امضا گم یا لو رفت
۱. حساب را فوراً غیرفعال کنید تا چیزی تأیید نشود: `… accounts --db DATA/accounts.sqlite disable --subject user:boss`
۲. کلید جدید روی یک رایانهٔ امن بسازید (کلید خصوصی هرگز از آن رایانه خارج نمی‌شود؛ فقط ورودی عمومی JSON را ببرید):
```
python3 - <<'PY'
import os, json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization as s
k = Ed25519PrivateKey.generate()
raw = k.private_bytes(s.Encoding.Raw, s.PrivateFormat.Raw, s.NoEncryption())
fd = os.open("approver.key", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # از بازنویسی کلید قبلی خودداری می‌کند
os.write(fd, raw.hex().encode()); os.close(fd)
pub = k.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw).hex()
print(json.dumps({"key_id": "k-NEW", "subject": "user:boss", "public_key_hex": pub}))
PY
```
۳. در فایل `--approval-keys` **ورودی کلید قدیمی را حذف** و ورودی جدید را اضافه کنید؛ مجوز فایل باید `chmod 600` باشد.
۴. سرور را **ری‌استارت** کنید (کلیدها فقط هنگام شروع بار می‌شوند؛ لغو کلید هم همین‌طور).
۵. حساب را دوباره فعال کنید: `… enable --subject user:boss`.
تأییدهای قبلی با کلید قدیمی دیگر معتبر نیستند و تأیید جدید لازم است (تأییدها یک‌بارمصرف‌اند).

## ۴) تأییدکنندهٔ دوم (پیشگیری از نقطهٔ شکست یگانه)
```
python -m master_brain.accounts --db DATA/accounts.sqlite add --subject user:deputy --approver --password-stdin
```
سپس مثل بند ۳ برای او کلید بسازید و ورودی `{"key_id","subject","public_key_hex"}` را به فایل کلیدها بیفزایید و ری‌استارت کنید.
توجه: وجود دو تأییدکننده **قاعدهٔ دو‌نفره** نیست؛ هر کدام به‌تنهایی می‌تواند تأیید کند. این فقط ظرفیت بازیابی می‌دهد.

## ۵) محدودیت‌های صادقانه
- ابزاری برای ساخت کلید یا امضای چالش در مخزن نیست (بند ۳ قطعه‌کد دستی است)؛ امضا هم باید با ابزار بیرون از مرورگر انجام شود.
- لغو کلید بدون ری‌استارت ممکن نیست.
- اگر لاگ خراب یا ناقص باشد، سرور راه نمی‌افتد؛ آن مورد با `docs/EXECUTION_RECOVERY_RUNBOOK_V0.md` و ابزار بازیابی دم لاگ بررسی می‌شود، نه با این راهنما.
