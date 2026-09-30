# Email system module

This directory is the portable email and passwordless-auth boundary.

Start with the [phased integration and API guide](../../../docs/email-system-integration.zh-CN.md)
for the active Better Auth system. It includes request/response examples, error
codes, Cookie behavior, Docker callbacks, and deployment steps.

## Generic files

- `http.ts`: bounded JSON and email-address validation.
- `better-auth.ts` / `better-auth-schema.ts`: active email OTP, D1 users and sessions.
- `verification-email.ts`: the original branded HTML verification email plus a plain-text fallback; codes expire in 10 minutes.
- `otp-rate-limit.ts`: shared D1 send reservations, with a 60-second OTP cooldown, 10 OTP attempts per address/day, and 100 total email attempts/day (UTC, 08:00 Beijing).
- `supabase.ts` / `supabase-route.ts`: retained legacy login implementation; not called by the active routes.
- `auth-ui.tsx` / `auth.module.css`: email-code login and public-page auth state.
- `resend.ts`: server-only Resend REST transport.

## RAPPTOR adapter

- `prediction-notifications.ts`: D1 outbox and completion/failure messages for
  prediction jobs. A site without background jobs does not need this file.
- `access-mode.ts`: fail-closed `email`/`ip` prediction access switch.

Set `RAPPTOR_PREDICTION_ACCESS_MODE=email` for Better Auth OTP, per-user genome
quota, and completion mail. Set it to `ip` for anonymous Turnstile submission,
one genome scan per IP and UTC day (resets 08:00 Beijing), and no email UI or delivery. Invalid or
missing values use `email`, so a configuration mistake never opens anonymous
submission.

The module does not receive sequence data and does not depend on the Docker
prediction service. Environment variables, provider setup, migrations, flow
diagrams, and migration instructions are documented in
[`docs/email-system-deployment.zh-CN.md`](../../../docs/email-system-deployment.zh-CN.md).

Session validation and sign-out need `BETTER_AUTH_SECRET` (32+ random characters)
and the `RAPPTOR_DB` D1 binding. Sending codes additionally needs `RESEND_API_KEY`
and `RESEND_FROM`. Set `RAPPTOR_PUBLIC_SITE_URL` to the canonical HTTPS origin.
Apply `database/migrations/0018_better_auth.sql` and `0019_auth_email_reliability.sql`
before deploying the new login. Failed or ambiguous sends consume the attempt budgets;
`RAPPTOR_EMAILS_PER_DAY` (capped at 100 for Resend Free) and
`RAPPTOR_AUTH_EMAILS_PER_ADDRESS_PER_DAY` adjust them. OTP, completion mail and
internal mail tests share the daily budget. Quota-deferred notifications retain their retries.
Resend also enforces its 3,000-email monthly team quota, including use by other apps and inbound mail.
The auth status route returns refreshed cookies. Authorization-only reads do not extend sessions.
Completion mail snapshots the full message, including sender and result URL, encrypted in D1
before sending. Retries use that snapshot across configuration and template changes.
The old `deployment:email` command configures Supabase and is retained only for
reverting to the legacy implementation; do not use it for Better Auth.
