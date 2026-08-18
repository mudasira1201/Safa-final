// ==========================================================
// PUT THIS FILE AT:  safa-web/sentry.client.config.ts   *** NEW FILE - create it ***
// (rename to: sentry.client.config.ts)
// ==========================================================
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});