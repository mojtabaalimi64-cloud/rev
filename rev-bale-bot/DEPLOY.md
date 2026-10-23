# دیپلوی ورکر بازوی بله (rev-bale-bot) — فاز ۱

کد آماده و تست‌شده است (`worker.js`، تست منطق: `run-tests.sh` سبز).
دیپلوی مثل بقیه ورکرها از داشبورد کلادفلر یا با اتصال گیت انجام می‌شود.

## قدم‌ها

1. **ساخت ورکر** با نام `rev-bale-bot` و قرار دادن محتوای `worker.js` به‌عنوان کد آن
   (یا پوش همین پوشه به ریپوی rev و اتصال Git Build با Root برابر `rev-bale-bot`).

2. **ساخت KV** با هر نامی (مثلاً `rev-bale-kv`) و بایند کردن آن به ورکر با نام دقیق `BOT_KV`.

3. **متغیرها (Variables):**
   - `OWNER_ID` = `1068481085`
   - `CHANNEL_ID` = بعد از ساخت کانال، نام کاربری کانال (مثل `@raneshev`) یا آی‌دی عددی آن. تا آن موقع خالی بماند.

4. **سکرت‌ها (Secrets):**
   - `BALE_TOKEN` — توکن بازوی @raneshevbot (از @botfather بله؛ پیش خودتان می‌ماند).
   - `STATUS_ADMIN_TOKEN` — همان توکن مدیریت rev-status-api (داشبورد آن ورکر، نام STATUS_ADMIN_TOKEN).
   - `WEBHOOK_SECRET` — یک رشته تصادفی بلند (مثلاً ۳۲ کاراکتر).
   - `INTERNAL_KEY` — یک رشته تصادفی دیگر؛ همین مقدار بعداً در ورکر دیسپچ هم ست می‌شود تا پیشنهاد امداد را به بازو بفرستد.

5. **ست‌کردن وب‌هوک بله** — این لینک را با توکن و سکرت خودتان در مرورگر باز کنید:
   `https://tapi.bale.ai/bot<BALE_TOKEN>/setWebhook?url=https://rev-bale-bot.mojtaba-alimi64.workers.dev/webhook/<WEBHOOK_SECRET>`
   پاسخ باید `{"ok":true,"result":true}` باشد.

6. **تست:** در بله به @raneshevbot دستور `/start` بدهید؛ منو باید بیاید.
   سلامت ورکر: باز کردن `https://rev-bale-bot.mojtaba-alimi64.workers.dev/health`

## بعد از دیپلوی (مرحله ۲، با پرامپت جدا)

- در ورکر `rev-tow-dispatch`، هنگام ساخت پیشنهاد برای راننده‌ای که چت بله‌اش وصل است،
  یک POST به `https://rev-bale-bot.mojtaba-alimi64.workers.dev/internal/notify`
  با هدر `x-internal-key: <INTERNAL_KEY>` و بدنه `{"type":"tow_offer","chatId":<آی‌دی چت راننده>}` زده شود.
  نگاشت chatId راننده‌ها را بازو در KV خودش نگه می‌دارد؛ برای این اتصال، دیسپچ باید chatId را از
  یک اندپوینت کوچک روی بازو بگیرد یا هنگام اتصال حساب راننده در بازو، chatId به دیسپچ هم ثبت شود (در فاز بعد نهایی می‌شود).
