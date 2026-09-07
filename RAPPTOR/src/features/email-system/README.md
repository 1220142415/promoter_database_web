# Email system module

This directory is the portable email and passwordless-auth boundary.

## Generic files

- `http.ts`: bounded JSON and email-address validation.
- `supabase.ts`: Supabase OTP sessions, refresh rotation, and route guards.
- `auth-ui.tsx` / `auth.module.css`: email-code login and public-page auth state.
- `resend.ts`: server-only Resend REST transport.

## RAPPTOR adapter

- `prediction-notifications.ts`: D1 outbox and completion/failure messages for
  prediction jobs. A site without background jobs does not need this file.
- `access-mode.ts`: fail-closed `email`/`ip` prediction access switch.

Set `RAPPTOR_PREDICTION_ACCESS_MODE=email` for Supabase OTP, per-user genome
quota, and completion mail. Set it to `ip` for anonymous Turnstile submission,
one genome scan per IP and Beijing day, and no email UI or delivery. Invalid or
missing values use `email`, so a configuration mistake never opens anonymous
submission.

The module does not receive sequence data and does not depend on the Docker
prediction service. Environment variables, provider setup, migrations, flow
diagrams, and migration instructions are documented in
[`docs/email-system-deployment.zh-CN.md`](../../../docs/email-system-deployment.zh-CN.md).

For repeatable deployment, copy `.env.deploy.example` to the Git-ignored
`.env.deploy`, then run `npm run deployment:email`. The script applies the
Supabase SMTP/OTP/templates and Cloudflare email secrets without exposing
their values.
