import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaDirect?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Second client, pinned to Neon's DIRECT (non-pgbouncer) connection string.
// See the big comment on withTransactionRetry() below for why this exists —
// short version: PgBouncer transaction-mode pooling (what DATABASE_URL uses)
// is fundamentally incompatible with Prisma's interactive transactions, no
// matter how much retry/backoff sits on top of it. This client is ONLY for
// $transaction() callbacks; every plain query keeps using the pooled `prisma`
// client above, since that pooling is exactly what makes a serverless
// deployment (short-lived functions, many concurrent connections) work.
const directUrl = process.env.DIRECT_DATABASE_URL;
if (!directUrl) {
  throw new Error(
    "DIRECT_DATABASE_URL is not set. Interactive transactions (withTransactionRetry) " +
      "require Neon's DIRECT connection string (same host, without the \"-pooler\" segment, " +
      "no pgbouncer=true param) — PgBouncer transaction-mode pooling breaks Prisma's " +
      "interactive transactions. See .env.example.",
  );
}
export const prismaDirect =
  globalForPrisma.prismaDirect ??
  new PrismaClient({ datasources: { db: { url: directUrl } } });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaDirect = prismaDirect;

// Neon's serverless Postgres can drop an idle pooled connection (autosuspend, proxy
// recycling) between one request and the next, which Prisma surfaces as "Server has
// closed the connection" (P1017) or "Can't reach database server" (P1001/P1002) on a
// query that would otherwise succeed immediately on a fresh connection. This is exactly
// what a status-polling GET hitting `prisma.project.findFirst()` ran into. One retry
// after a brief pause is the standard mitigation; if it fails twice in a row, it's a
// real outage, not a stale-connection blip.
//
// Uses $use() middleware, NOT $extends() — $extends() returns a differently-typed
// client that @next-auth/prisma-adapter's PrismaAdapter(prisma) rejects at compile time
// (it wants the literal PrismaClient type). Middleware mutates this SAME client and
// keeps its type exactly as-is, so every existing consumer (the NextAuth adapter
// included) keeps working unmodified.
const RETRYABLE_CODES = new Set(["P1017", "P1001", "P1002"]);
prisma.$use(async (params, next) => {
  try {
    return await next(params);
  } catch (e: any) {
    if (RETRYABLE_CODES.has(e?.code)) {
      await new Promise((r) => setTimeout(r, 300));
      return await next(params);
    }
    throw e;
  }
});

/**
 * P2028 ("Transaction not found... refers to an old closed transaction") was
 * mis-diagnosed as a Neon connection-drop blip. It is NOT that. It's PgBouncer
 * running in TRANSACTION-mode pooling (DATABASE_URL, ?pgbouncer=true): each
 * individual statement Prisma sends can land on a different physical backend
 * connection, because PgBouncer only guarantees the SAME connection for the
 * duration of one SQL transaction, not for the lifetime of Prisma's
 * interactive-transaction session (BEGIN ... your callback's awaits ...
 * COMMIT). The moment two statements in one $transaction() callback get
 * routed to different backends, the transaction handle Prisma is holding is
 * "not found" on whichever backend answers next — worse the more concurrent
 * traffic there is (exactly why this showed up right after generating
 * location/character images and script breakdowns: real concurrent load).
 * `pgbouncer=true` and the retry loop below only ever treated the symptom;
 * retrying re-runs the SAME broken pattern against the SAME pooled
 * connection and can fail identically both times.
 *
 * The actual fix: interactive transactions must NOT go through PgBouncer's
 * transaction-mode pooler at all. `prismaDirect` above is pinned to Neon's
 * DIRECT connection string (no PgBouncer in front of it), so BEGIN/COMMIT
 * for the callback below always stay on one real backend connection. The
 * retry loop is kept as a second line of defense for genuine transient
 * connection drops (P1017/P1001/P1002), not as the fix for P2028.
 *
 * Use this in place of prisma.$transaction(fn) anywhere the transaction body
 * is short and safe to fully re-run on failure — true for every current use
 * (spend a credit + queue a job): if the transaction never committed, neither
 * side effect happened, so redoing the whole thing from scratch is safe, not
 * a double-charge risk.
 */
const TRANSACTION_RETRYABLE_CODES = new Set(["P1017", "P1001", "P1002", "P2028"]);
export async function withTransactionRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  // CONFIRMED REAL, LIVE FAILURE (2026-08-10): this function's earlier fix
  // (routing off PgBouncer via prismaDirect, above) fixes P2028's ROOT CAUSE
  // — statements landing on different backends — but a later merge of that
  // fix silently reverted a SEPARATE, complementary mitigation that used to
  // live right here: a raised timeout/maxWait and a second retry, for a
  // genuinely slow-but-alive connection rather than a misrouted one. Caught
  // live: "Unable to start a transaction in the given time" (P2028, but a
  // DIFFERENT symptom than "Transaction not found") on api/projects/[id]/
  // keyframes/route.ts, with every plain GET in the same log window taking
  // 6-8+ seconds — Prisma's stock 2000ms maxWait has no chance under that
  // baseline latency, regardless of which backend the transaction lands on.
  // Restored, not reverted: prismaDirect above stays exactly as the other
  // fix left it.
  retries = 2,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prismaDirect.$transaction(fn, { timeout: 20000, maxWait: 15000 });
    } catch (e: any) {
      if (attempt < retries && TRANSACTION_RETRYABLE_CODES.has(e?.code)) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
}
