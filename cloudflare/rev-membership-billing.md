# REV annual memberships and payments

This is a schema and rollout foundation, not a live billing system. No payment gateway is connected, no plan is active, and no account should be marked paid from a browser redirect.

## Membership model
- Keep account verification status separate from paid membership.
- Support individual members, charging-station operators, and repair shops.
- A membership is valid only when status is active and expires_at is in the future.
- Paid status never replaces independent repair-shop license review or charging-station moderation.
- Plans start inactive until REV chooses prices, benefits, currency, and a gateway.

## Payment safety
1. Create a pending payment server-side with a unique idempotency key.
2. Redirect to the selected gateway.
3. Verify success server-to-server or through a correctly signed webhook.
4. Reject duplicate transaction and webhook IDs.
5. Only after verified success, activate/extend membership for 365 days. For early renewals, extend from the later of current expiry or payment time.
6. Never activate from a client-side success URL alone.
7. Store gateway credentials only as Worker secrets.
8. Define a policy for refunds, chargebacks, and suspensions.

## Iran-focused provider selection
Do not assume Stripe is a suitable production gateway. Confirm Iranian merchant eligibility, fees, settlement, verification API, signed webhooks, and intended customer geography before choosing a gateway. Keep the payment adapter provider-neutral.

## No custom domain
GitHub Pages can call a Worker on workers.dev using an exact CORS allowlist; a custom domain is not required for database/API work. Branded transactional email usually requires control of a sender domain. Until email is configured, do not pretend an email address has been verified.

## Rollout
1. Apply the membership migration to D1 database rev-db.
2. Confirm the tables and inactive plans exist.
3. Decide prices and benefits.
4. Choose an Iran-compatible payment gateway.
5. Implement payment creation, server-side verification, idempotent webhook handling, and entitlement checks in the auth/community Worker.
6. Test success, failure, duplicate webhooks, early renewal, expiry, refunds, and suspension.
7. Activate plans only after those tests pass.
