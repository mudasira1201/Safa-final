# safa — Production & security checklist (Part 4)

Part 4 added the code-level foundations: Stripe billing, an admin console, credit enforcement, refund-on-failure, and security headers. But **"passes VAPT" and "handles 1 Lakh users" are not things code alone delivers** — they're an ongoing program. This is the honest checklist for getting there.

## ✅ Already in the code
- **Auth:** hashed passwords (bcrypt), sessions, `/app` and `/admin` protected by middleware.
- **Authorization:** every project API checks ownership; admin APIs check `isAdmin`.
- **Payments:** Stripe Checkout + webhook **signature verification** + customer portal.
- **Credits:** spent at render time, **refunded automatically if the render fails**.
- **Security headers:** HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (in `next.config.mjs`).
- **DB access:** Prisma (parameterized queries — no SQL injection).
- **Secrets:** all in env, never in the repo.

## 🔲 Before you call it production
**Security**
- [ ] **Rate limiting** on auth + generation + API (use Upstash Ratelimit or a WAF). Not included — add before launch; it's a top VAPT finding.
- [ ] **Input validation** on every API body (add `zod` schemas to the routes).
- [ ] **CSRF**: NextAuth protects its own routes; ensure any state-changing GET is converted to POST (already the case here).
- [ ] **Content moderation** on generated images/video (you're liable for outputs) + a report/abuse path.
- [ ] **Dependency scanning** (`npm audit`, Dependabot) and pin versions.
- [ ] **Secrets rotation** + least-privilege API keys (separate keys per environment).
- [ ] **Signed, expiring URLs** for private media instead of a fully public R2 bucket, if films should be private.
- [ ] **Logging/audit trail** for admin actions (add an `AuditLog` model — the granting of credits, deletions, etc.).
- [ ] **A real pen-test / VAPT** by a third party, then fix findings. This is the actual "passes VAPT" step.

**Scale (toward 1 Lakh users)**
- [ ] **Real job queue** (BullMQ + Redis, or Inngest) replacing DB-polling, with **row-locked** claims so you can run **many workers**.
- [ ] **Autoscale workers** by queue depth; the web app on Vercel scales itself.
- [ ] **Connection pooling** for Postgres (Neon pooled URL / PgBouncer) — serverless + many workers exhaust connections fast.
- [ ] **CDN in front of R2** (Cloudflare is already a CDN) for media delivery.
- [ ] **Cost controls**: per-user concurrency caps + monthly spend alerts (your fal bill scales with usage — a runaway user can be expensive).
- [ ] **Load test** (k6/Artillery) to find the real breaking points before users do.
- [ ] **Monitoring/alerting**: Sentry (errors), uptime checks, a status page.

**Reliability**
- [ ] **Idempotent webhooks** (store processed Stripe event IDs; Stripe retries).
- [ ] **Retries with backoff** on failed generations (currently one attempt).
- [ ] **Backups** for Postgres (Neon has PITR — enable it) and a restore drill.
- [ ] Multiple workers → add a DB row lock (`SELECT … FOR UPDATE SKIP LOCKED`) so two workers never grab the same job.

## Stripe setup (to make billing work)
1. Create the products/prices in Stripe → put the **Price IDs** in `STRIPE_PRICE_PLUS` / `STRIPE_PRICE_PRO`.
2. Add a webhook endpoint → `https://yourdomain/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → put the signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Local testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
4. Enable the **Customer Portal** in Stripe settings (for the “Billing & plan” button).

## Admin
- Any `@safa.ai` email (or an address in `ADMIN_EMAILS`) can open **`/admin`** — see users, credits, projects, and failed jobs, and grant/adjust credits.
- Harden further: 2FA on admin accounts, and add the audit log noted above.

---

**Bottom line:** the code now *supports* a real product — accounts, payments, generation, admin. Turning it into a hardened, 100k-user, VAPT-passing service is the checklist above: rate limiting, a real queue with multiple workers, moderation, monitoring, and an actual third-party pen-test. That's weeks of focused work and some of it is operational, not code — but you now have the foundation it all sits on.
