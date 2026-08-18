// ==========================================================
// PUT THIS FILE AT:  ai-film-pro/src/sentry.ts   *** NEW FILE - create it ***
// (rename to: sentry.ts)
// ==========================================================
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({ dsn, tracesSampleRate: 0.1, environment: process.env.NODE_ENV || "development" });
  console.log("🛰  Sentry enabled for the worker");
}

/** Report a failed job to Sentry with the context needed to actually debug it. */
export function reportJobError(err: unknown, ctx: { jobId: string; type: string; projectId: string; attempts: number }) {
  if (!dsn) return;
  Sentry.withScope((scope) => {
    scope.setTag("job_type", ctx.type);
    scope.setTag("final", String(ctx.attempts >= 3));
    scope.setContext("job", ctx);
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
  });
}