-- REV SMS OTP login migration (additive; safe to run once).
-- phone_e164 and rev_verification_challenges are defined in rev-community-schema.sql.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_users_phone_e164 ON rev_users(phone_e164);
CREATE INDEX IF NOT EXISTS idx_rev_sms_login_challenge
  ON rev_verification_challenges(channel, purpose, destination_normalized, created_at DESC);
