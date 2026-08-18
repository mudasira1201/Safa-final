// ==========================================================
// PUT THIS FILE AT:  safa-web/next.config.mjs
// (rename to: next.config.mjs)
// ==========================================================
import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { instrumentationHook: true }, // enables instrumentation.ts (Sentry boot)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

// Only wrap when Sentry is actually configured, so a missing DSN can never break the build.
export default process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, { silent: true, widenClientFileUpload: true, disableLogger: true })
  : nextConfig;
