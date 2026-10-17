# اتصال موزیک REV به Cloudflare R2

این Worker مستقل است تا به Workerهای فعلی REV دست نزند.

## تنظیمات Cloudflare
1. در Cloudflare داشبورد، R2 بسازید و یک bucket با نام `rev-music` ایجاد کنید.
2. یک Worker مستقل با نام `rev-music-api` بسازید و کد `rev-music-worker.js` را منتشر کنید.
3. در Worker → Settings → Bindings یک R2 bucket binding با نام دقیق `MUSIC_BUCKET` و bucket انتخابی `rev-music` اضافه کنید.
4. در Worker → Settings → Variables and Secrets، یک secret با نام `ADMIN_TOKEN` بسازید. از رمز مدیریتی طولانی و تصادفی استفاده کنید. مقدار آن را در GitHub یا فایل HTML قرار ندهید.
5. آدرس Worker را یادداشت کنید. برای مثال: `https://rev-music-api.<account>.workers.dev`.
6. تست سلامت: `GET /api/health` باید `success:true` و `storage:true` بدهد.

## API
- عمومی: `GET /api/music/tracks` برای فهرست آهنگ‌ها
- عمومی: `GET /music/tracks/<id>.<ext>` برای پخش و پشتیبانی از Range
- مدیریت: `POST /api/admin/music` با `Authorization: Bearer <ADMIN_TOKEN>` و فرم multipart شامل `file`, `title`, `artist`
- مدیریت: `DELETE /api/admin/music/<id>` با همان هدر

## محدودیت و هزینه
- نسخه اول هر فایل را تا ۲۰ مگابایت می‌پذیرد و فقط فایل صوتی با MIME مجاز را قبول می‌کند.
- فایل‌ها مستقیم در R2 ذخیره می‌شوند؛ در D1 یا مخزن GitHub ذخیره نمی‌شوند.
- پخش از مسیر Worker انجام می‌شود و به تنظیم public bucket نیاز ندارد. مصرف درخواست‌های Worker و سهمیه رایگان R2 باید پایش شود؛ هزینه صفر تضمین‌شده نیست.
- در مرورگر، کلید مدیریتی فقط هنگام استفاده در فرم ارسال می‌شود و در کد سایت ذخیره نمی‌شود. این پنل برای مدیر مورد اعتماد است؛ دستگاه مشترک را پس از پایان کار ترک نکنید.
