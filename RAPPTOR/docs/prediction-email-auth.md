# Prediction email authentication and notifications

This document records the production setup for passwordless prediction access.
Secrets are intentionally omitted.

For the complete Chinese deployment, migration, API-key, data-flow, and
troubleshooting guide, see `docs/email-system-deployment.zh-CN.md`.

## Components

- Supabase Auth owns the user identity and email OTP login.
- Resend sends Supabase OTP mail and RAPPTOR task notifications.
- Cloudflare Worker owns prediction authorization, quota checks, and the
  temporary D1 notification outbox.
- The Docker prediction service only queues and runs jobs. It never receives
  Supabase keys, Resend keys, user email addresses, or D1 credentials.

## Supabase setup

Project URL:

```text
https://swicrzrhvbkocrssmqpv.supabase.co
```

In Authentication → Providers → Email:

- Email provider: enabled.
- Confirm email: enabled.
- Email OTP length: `6` digits. This must match the six-digit login input.
- Password sign-in is not used by RAPPTOR; the application sends an email OTP.

In Authentication → Emails → SMTP Settings, enable custom SMTP and use the
verified Resend sender domain:

| Field | Value |
| --- | --- |
| Sender email | `no-reply@auth.email.duolalab.qzz.io` |
| Sender name | `RAPPTOR` |
| Host | `smtp.resend.com` |
| Port | `465` (587 is also supported) |
| Username | `resend` |
| Password | Resend API key, entered directly in Supabase |

The password must never be committed or pasted into chat.

In Authentication → Emails → Templates, configure **both** of these templates
as code emails:

- Confirm sign up: used the first time a new email requests a code.
- Magic link or OTP: used when an existing user requests another code.

Keep the OTP placeholder in both template bodies:

```text
{{ .Token }}
```

Use `docs/supabase-otp-template.html` as the body for both templates and
`Your RAPPTOR verification code` as the subject. The checked-in template uses
only inline styles and no remote images so it remains reliable in restrictive
mail clients.

Without that placeholder, Supabase falls back to a confirmation link for new
users or sends a message that does not contain the code required by the
passwordless login form.

## Cloudflare Worker secrets

Set these with `wrangler secret put` from the RAPPTOR directory. The command
prompts locally, so values do not enter Git:

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put RESEND_API_KEY
```

Use the project URL above for `SUPABASE_URL`. Use the Supabase **anon** key,
never the `service_role` key. `RESEND_API_KEY` is the server-side Resend key
used for task-completion mail.

Existing one-time email-test secrets, if enabled, are separate and should be
removed after the acceptance test as described in `.env.local.example`.

## Session lifetime and stored user data

- A verified browser receives an HttpOnly, Secure, SameSite=Lax session cookie
  with a 90-day lifetime. Supabase refresh-token rotation renews it while the
  user remains active on the prediction pages.
- Signing out clears the browser cookie and revokes the Supabase session.
- Supabase `auth.users` stores the durable user ID, normalized email address,
  and confirmation metadata. RAPPTOR does not create or store a password.
- D1 daily quota rows use the Supabase user ID, not the email address.
- D1 stores the email and an AES-GCM-encrypted job capability in the temporary
  notification outbox after a real task is submitted; rows are purged after
  seven days. The encryption key is derived from the Worker/Docker callback
  secret and is never stored in D1.
- The Docker prediction service never receives the email or Supabase session.

## D1 migration

Apply the notification outbox migration after authenticating Wrangler:

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7997'
$env:HTTPS_PROXY = 'http://127.0.0.1:7997'
npx wrangler d1 migrations apply RAPPTOR_DB --remote
```

Migration `0012_prediction_job_notifications.sql` creates the temporary
notification metadata table. Migration `0013_prediction_notification_links.sql`
adds the encrypted capability and reference name used by result links. Rows
are retained for seven days and purged by the daily Worker cron.

## Notification behavior

- A real prediction task registers one notification record at submission.
- Demo tasks never send mail.
- Terminal success or failure sends one email through Resend.
- Resend idempotency is `prediction-completed/<job_id>`, so duplicate callbacks
  do not create duplicate messages.
- Failed delivery is retried every five minutes, up to three attempts.
- The email contains the task ID, task type, outcome, result-expiry note, and a
  button linking to `/predict/task/{jobId}` on `RAPPTOR_PUBLIC_SITE_URL`.
- The result URL carries the temporary capability in its `#fragment`, which
  browsers do not send in HTTP requests or referrers. Anyone holding the link
  can view the task without logging in until Docker removes the result.
- The result page exchanges the capability for an HttpOnly artifact cookie,
  restores the reference name, and opens the completed genome browser.
- The email contains no sequence data or result files. Treat the link itself
  as private and do not publish it.
- A notification failure does not cancel an already queued prediction.

## Docker service boundary

The service needs only these endpoints:

| Direction | Endpoint | Purpose |
| --- | --- | --- |
| Worker → Docker | `GET /healthz` | health check |
| Worker → Docker | `POST /v1/jobs` | create queued job |
| Worker → Docker | `GET /v1/jobs/{job_id}` | status and progress |
| Worker → Docker | `GET /v1/jobs/{job_id}/artifacts/{filename}` | result artifact |
| Docker → Worker | `POST /api/internal/prediction-tickets/consume` | consume one-time ticket |
| Docker → Worker | `POST /api/internal/prediction-jobs` | status callback |

Protect internal callbacks with `RAPPTOR_PREDICTION_SERVICE_SECRET`. Keep
Redis and the worker private; expose only the HTTPS API through the reverse
proxy. The Docker service must not be given Supabase or Resend secrets.
Before rotating this secret, send or clear pending notification rows because
their encrypted capabilities cannot be decrypted with the new value.

## Smoke test

1. Request an OTP from `/predict` and confirm it arrives from the verified
   Resend sender.
2. Verify the code and confirm the HttpOnly session cookie is set.
3. Submit a short-sequence prediction; it is unlimited after login.
4. Submit one whole-genome scan; a second scan on the same Beijing day returns
   the daily-quota response. The quota resets at Beijing 00:00.
5. Complete a real task and confirm exactly one completion email arrives.
6. Replay the terminal callback and confirm no second email is sent.
