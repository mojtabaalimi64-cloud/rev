# REV staged registration and community rollout

## Goal
Add email + phone registration to the GitHub Pages front end without trusting browser-supplied identity. Cloudflare Worker endpoints must be the only way to read/write private user data. D1 binding for the new auth/community Worker should be explicitly configured as `DB` to `rev-db` in Production.

## Staged identity policy
1. **Account created / email pending**: collect display name, email, and consent to the current privacy policy. Create a pending account and send a short-lived one-time email code or magic link. Do not allow community submissions yet.
2. **Email verified**: account becomes active with `email_verified_at`. User can sign in and edit profile. Ask for phone verification before adding stations, submitting repair shops, reviewing, or voting.
3. **Phone pending**: user enters a phone number in E.164 format; send a short-lived SMS OTP through a configured SMS provider. Do not treat a submitted phone number as verified until the correct code is checked server-side.
4. **Both verified**: `email_verified_at` and `phone_verified_at` are set. Permit community contributions, subject to rate limits and moderation.
5. **Trust / moderation**: verification proves control of contact channels, not the truth of a station or the legitimacy of a repair shop. Station submissions remain pending until moderated or corroborated. Repair shops remain “license unverified” until documentary checks are completed.

## Recommended authentication implementation
- Use opaque random session tokens in Secure, HttpOnly, SameSite cookies; store only a cryptographic hash of the token in D1.
- Never store plaintext OTPs, session tokens, passwords, or provider credentials in D1, logs, HTML, or GitHub.
- Store only a keyed/hash representation of each one-time token; make tokens single-use and expire quickly (suggested 10 minutes).
- Limit OTP attempts, resends, and account creation by destination and request window. Add Cloudflare Turnstile or another abuse check before sending codes.
- Apply strict same-origin checks to state-changing requests, exact CORS allowlist for `https://mojtabaalimi64-cloud.github.io`, JSON content-type checks, parameterized SQL, and generic responses that do not reveal whether an email/phone is registered.
- Use an established auth library/service where practical rather than shipping a bespoke auth implementation without tests. The schema file is a data-model foundation, not a complete authentication system.
- Do not enable OTP sending until email and SMS providers are selected and their secrets are configured as Worker secrets.

## API outline (not deployed yet)
- `POST /api/auth/register`: create pending user, record policy consent, initiate email verification.
- `POST /api/auth/email/send-code`: resend under rate limits.
- `POST /api/auth/email/verify`: verify one-time email code/link; activate email-verified account.
- `POST /api/auth/phone/start`: validate and normalize phone, create SMS challenge.
- `POST /api/auth/phone/verify`: verify SMS challenge and set phone verification timestamp.
- `POST /api/auth/login`: send a one-time login challenge to a verified contact or use a carefully implemented password flow.
- `POST /api/auth/logout`: revoke session.
- `GET /api/auth/me`: return only the current user's safe profile and verification states.

All private routes must identify the user from the server-validated session cookie, never from a user ID in the request body.

## Community data workflow
- Station suggestions go to `rev_station_submissions`; do not overwrite the canonical OSM cache directly.
- Each suggestion has moderation state and evidence. A moderator approves/rejects it after checking coordinates, duplicate proximity, photos, provider/operator information, and current status.
- Independent confirmations are recorded in `rev_station_verifications`; one user can verify a given submission only once.
- Repair-shop directory records are separate from reviews. A shop's “authorized/licensed” label is shown only if `license_status = 'verified'` after documentary review.
- Reviews require both contact channels verified, one review per user per shop, rate limits, reporting/moderation, and clear disclosure that REV reviews are user-submitted.
- Compute shop score from published, eligible reviews with a minimum-sample indicator and a Bayesian/shrinkage adjustment; show review count and rating distribution. Do not rank shops solely by raw positive vote count.
- Store trip checklist answers and a **readiness score**, not a claim that a journey is a percentage safe. Safety warnings (e.g. no reachable charger with reserve) override a high checklist score and must be shown prominently.

## Database
The additive migration `rev-community-schema.sql` creates the new `rev_*` tables. It does not change existing tables. Review it and run it once in the Cloudflare D1 console for `rev-db`. Do not create the live authentication UI until Worker endpoints, provider configuration, and authorization checks are implemented and tested.

## Rollout sequence
1. Apply schema and verify tables.
2. Configure a dedicated community/auth Worker (or extend the existing primary API Worker after inspecting its full code); do not overload the online-stations cache Worker without a deliberate integration.
3. Configure email provider and SMS provider secrets. Never commit credentials.
4. Implement and test auth endpoints, cookies, expiry, OTP throttling, and recovery.
5. Build registration UI and account page.
6. Build station submission + moderation workflow.
7. Add trip checklist and readiness scoring.
8. Add repair shop submissions, license review, and user ratings.
9. Test unauthenticated access, expired/replayed OTPs, duplicate votes, cross-origin requests, abuse throttles, and moderator permissions before public launch.
