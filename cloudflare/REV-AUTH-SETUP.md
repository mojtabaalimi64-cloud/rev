# REV Auth Worker — staged setup

This is a **separate Worker**. Do not replace or edit the existing `rev-api` Worker. It keeps admin/content/station routes separate and preserves the current admin login.

## Current rollout status

- The admin panel now has a checkbox in **تنظیمات → حساب کاربران REV**.
- The checkbox talks to `https://rev-auth-api.mojtaba-alimi64.workers.dev`.
- The Worker source is this file: `cloudflare/rev-auth-worker.js`.
- Apply `cloudflare/rev-auth-schema.sql` to the existing D1 database `rev-db`.
- The toggle will show the service as unavailable until the new Worker is deployed and configured.
- Do not enable it until a real sender domain and email provider are configured.

## Create the Worker

1. In Cloudflare Workers & Pages, create a new Worker named exactly `rev-auth-api`.
2. Deploy the contents of `cloudflare/rev-auth-worker.js` as its code.
3. In Settings → Bindings, add a D1 database binding:
   - Variable name: `DB`
   - Database: `rev-db`
4. In Settings → Variables and Secrets, add:
   - Secret `ADMIN_TOKEN`: set it to the **same existing admin token** used by the current `rev-api` Worker. Never put it in GitHub or send it in chat.
   - Secret `RESEND_API_KEY`: add after creating/configuring the Resend account and verifying the sending domain.
   - Variable `ALLOWED_ORIGINS`: initially `https://mojtabaalimi64-cloud.github.io`; after buying the domain, add the exact site origin(s), comma-separated, for example `https://example.com,https://www.example.com`.
   - Variable `SITE_URL`: initially `https://mojtabaalimi64-cloud.github.io/rev`; after domain setup, set it to the final public site base URL, without a trailing slash.
   - Variable `EMAIL_FROM`: after domain verification, set a sender such as `REV <noreply@example.com>`, using your actual verified domain.
5. Save and deploy the Worker. Check `/api/health` and `/api/auth/status`.

## Database migration

In D1 → `rev-db` → Console, run the full contents of `cloudflare/rev-auth-schema.sql`. It creates the auth toggle and rate-limit tables only; it does not drop or rewrite existing user/session tables.

The previously created `rev_password_credentials` table and existing `rev_users`, `rev_verification_challenges`, and `rev_sessions` tables are also required.

## Email provider and safety

- Registration stays blocked unless the admin toggle is on **and** `RESEND_API_KEY`, `EMAIL_FROM`, and `SITE_URL` are configured.
- Keep the toggle off until the sending domain is verified and an end-to-end test succeeds.
- The code uses PBKDF2-SHA256 (310,000 iterations), random salts, hashed verification/session tokens, HttpOnly/Secure/SameSite=Lax cookies, and basic per-IP rate limits.
- Once the custom domain is ready, use a same-site API hostname (for example `api.example.com`) and update the front-end `AUTH_WORKER` constants in `admin.html` and `verify-email.html` to that hostname. This helps avoid third-party-cookie restrictions from `github.io` → `workers.dev`.
- Before enabling public registration, test register → receive email → verify → login → `/api/auth/me` → logout in a real browser.


## ارسال شناسه اختصاصی صاحب کسب‌وکار با پیامک
کد Worker یک مسیر مدیریتی جدید دارد: `POST /api/admin/send-owner-code`. این مسیر فقط با `ADMIN_TOKEN` معتبر کار می‌کند و از API REST ملی پیامک استفاده می‌کند.

در `rev-auth-api` → Settings → Variables and Secrets:
- Secret: `MELIPAYAMAK_USERNAME` — نام کاربری ملی پیامک
- Secret: `MELIPAYAMAK_PASSWORD` — رمز عبور وب‌سرویس
- Variable یا Secret: `MELIPAYAMAK_FROM` — شماره فرستنده مجاز پنل ملی پیامک

پس از ذخیره این مقادیر، کد Worker را Deploy کنید. در پنل ادمین REV، زبانه «مدیریت دستی رضایت» را باز کنید، پروفایل را جست‌وجو و انتخاب کنید و دکمه «ارسال شناسه با پیامک» را بزنید. شماره تماس باید شماره همراه ایران با قالب `09xxxxxxxxx` باشد و شماره فرستنده نیز باید در پنل ملی پیامک مجاز باشد.

این دکمه پیامک را به‌صورت دستی و با تأیید ادمین می‌فرستد؛ ثبت‌نام خودکار صاحب کسب‌وکار هنوز یک فرایند جداست و تا زمانی که فرم ثبت‌نام فروشندگان به این سرویس متصل نشده، پیامک خودکار هنگام ثبت‌نام ارسال نمی‌شود.


## REV Driver Trip Tracking (GPS and private efficiency profile)

The additive migration is `cloudflare/rev-driver-trips-schema.sql`. Apply it to the same D1 database `rev-db` **after** `cloudflare/rev-community-schema.sql` has created `rev_users`. It creates only `rev_driver_trips` and its index.

The updated `cloudflare/rev-auth-worker.js` adds these authenticated, user-scoped endpoints:
- `GET /api/driver/profile` — private aggregate statistics and recent trip history.
- `GET /api/driver/trips` — the signed-in user's trips only.
- `POST /api/driver/trips` — validates and saves a trip; GPS coordinates are saved only when `saveRoute: true` is explicitly submitted.
- `POST /api/driver/trips/:id/delete` — deletes only a trip owned by the signed-in user.

Deploy the updated Worker source after applying the schema. The public page is `driver-profile.html`; the trip planner links to it. GPS recording requires HTTPS and explicit browser permission. Keep the page open during a trip: mobile browsers may suspend GPS when the screen locks or the tab is backgrounded. The page does not yet claim continuous background tracking.

Important: the profile page requires the REV account system to be enabled and a valid session. Because GitHub Pages (`github.io`) and the Worker (`workers.dev`) are cross-site, browser third-party-cookie restrictions may prevent session cookies from working. The recommended production setup is a custom REV domain with the API on a same-site subdomain before enabling private profiles for users.

OBD-II and vehicle-maker APIs are not universal. The profile page only checks whether Web Bluetooth is exposed by the browser; it does not falsely report a generic OBD connection. Real telemetry requires a tested adapter protocol and a vehicle-specific profile, or an official OEM API with credentials stored only as Worker secrets. Never place vehicle API secrets in GitHub Pages or client-side JavaScript.
