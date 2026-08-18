import { PrismaClient } from "@prisma/client";
import { withTimeout } from "./util";

export const prisma = new PrismaClient();

// Neon's serverless Postgres can drop an idle pooled connection (autosuspend, proxy
// recycling) between one query and the next, which Prisma surfaces as "Server has
// closed the connection" (P1017) or "Can't reach database server" (P1001/P1002) on a
// query that would otherwise succeed immediately on a fresh connection. Without this,
// that single transient blip could throw partway through a job handler (claimJob,
// setJob, checkCaps, ...) that ISN'T already wrapped in its own retry logic — wasting
// a full rmrf()-and-redo-everything retry cycle over what was really just a stale
// connection, not a real failure. One retry after a brief pause is the standard
// mitigation; if it fails twice in a row, it's a real outage, not a stale-connection blip.
//
// CONFIRMED REAL GAP, FIXED: the retry above only ever fires once Prisma actually
// THROWS — it does nothing for a query that just hangs waiting for a response that
// never comes, the same "no timeout, no error, no retry, job stuck forever" class of
// bug already fixed in util.ts's downloadToFile(), image.ts, video.ts, qa-runtime.ts's
// OpenAI client, and storage.ts's uploadFile (all confirmed real, live occurrences).
// This is the most foundational version of it: every single Prisma call in this whole
// worker goes through this one client. Reproduced live: runSheet() sat on "Building
// Osric's reference sheet" for 7+ minutes with near-zero CPU, on the same shared Neon
// DB that was independently observed running 6-8+ second plain-query latency around
// the same time (safa-web side) — a plain query here has no reason to legitimately
// take anywhere near 30s even under bad network conditions, so a query that DOES is
// almost certainly hung, not just slow.
const QUERY_TIMEOUT_MS = 30_000;
const RETRYABLE_CODES = new Set(["P1017", "P1001", "P1002"]);
prisma.$use(async (params, next) => {
  const label = `prisma ${params.model ?? ""}.${params.action}`;
  try {
    return await withTimeout(next(params), QUERY_TIMEOUT_MS, label);
  } catch (e: any) {
    if (RETRYABLE_CODES.has(e?.code) || /timed out after/.test(e?.message ?? "")) {
      await new Promise((r) => setTimeout(r, 300));
      return await withTimeout(next(params), QUERY_TIMEOUT_MS, label);
    }
    throw e;
  }
});
