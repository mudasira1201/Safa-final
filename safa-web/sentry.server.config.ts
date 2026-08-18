// ==========================================================
// PUT THIS FILE AT:  safa-web/sentry.server.config.ts   *** NEW FILE - create it ***
// (rename to: sentry.server.config.ts)
// ==========================================================
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN), // no DSN = completely inert
  tracesSampleRate: 0.1,
  // Never ship secrets or user scripts to Sentry.
  beforeSend(event) {
    if (event.request?.data) delete event.request.data;
    return event;
  },
});