# Email system

Current implementation: Better Auth + D1 + Resend.
Configuration, OTP/session endpoints, templates, notification retries, and rollback
are documented in the [email integration guide](../../../docs/email-system-integration.zh-CN.md).

`better-auth.ts` owns authentication, `resend.ts` owns sending,
`otp-rate-limit.ts` reserves sending budgets, and `prediction-notifications.ts`
owns task messages. `supabase.ts` and `supabase-route.ts` retain the legacy implementation.
