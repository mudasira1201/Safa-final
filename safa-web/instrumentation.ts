// ==========================================================
// PUT THIS FILE AT:  safa-web/instrumentation.ts   *** NEW FILE - create it ***
// (rename to: instrumentation.ts)
// ==========================================================
// Next.js calls this once per runtime on boot. It wires Sentry into the server and edge runtimes.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}