// ==========================================================
// PUT THIS FILE AT:  safa-web/sentry.edge.config.ts   *** NEW FILE - create it ***
// (rename to: sentry.edge.config.ts)
// ==========================================================
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  tracesSampleRate: 0.1,
});