# safa.ai — Web app (Parts 1 + 2 of 4)

The **safa.ai** product: a Next.js frontend (Part 1) with a real database + authentication (Part 2).

- **Part 1 — Frontend:** landing, pricing, auth, and the workspace/app-shell, with your logo.
- **Part 2 — Database + auth:** Postgres (Neon) via Prisma, real email/password + Google sign-in, protected workspace, per-user credits.

Still ahead: **Part 3** (pipeline-as-a-service + storage + the working create flow) and **Part 4** (Stripe + admin + hardening).

---

## Setup

### Requirements
- **Node.js 18+**
- **ffmpeg** — required for stitching clips into the final film and for generating thumbnails. Install it before running the worker or the pipeline preview server. macOS: `brew install ffmpeg`. Debian/Ubuntu: `sudo apt install ffmpeg`. Verify with `ffmpeg -version`.

### 1. Install
```bash
npm install
```

### 2. Create your database (Neon)
- Sign up at neon.tech, create a project, copy the **pooled** connection string.

### 3. Environment
```bash
cp .env.example .env.local
```
Fill in `.env.local`:
- `DATABASE_URL` — your Neon connection string.
- `NEXTAUTH_SECRET` — run `openssl rand -base64 32` and paste it.
- `NEXTAUTH_URL` — `http://localhost:3000` for local.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional (see below). Leave blank to hide the Google button.

### 4. Create the database tables
```bash
npm run db:push        # creates all tables in your Neon database
```

### 5. Run
```bash
npm run dev            # http://localhost:3000
```

Now: go to `/login`, **sign up with email + password** → you're taken to `/app`, logged in, with your name and starting credits shown. Log out and back in. It's real — accounts persist in your Neon database.

Inspect the data anytime:
```bash
npm run db:studio      # opens Prisma Studio to browse users/projects
```

### (Optional) Google sign-in
1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** (Web).
2. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
3. Paste the client ID + secret into `.env.local`, restart.

---

## What's real now (Part 2)
- **Email/password signup + login** with hashed passwords (bcrypt), stored in Postgres.
- **Google sign-in** (when configured).
- **Sessions** — you stay logged in; `/app` is **protected** by middleware (redirects to `/login` if signed out).
- **Per-user data** — each account has a plan + render credits, shown in the workspace, read live from the database via `/api/me`.

## Still mock (until Part 3)
- **Generate** doesn't produce a film yet — that needs the pipeline running as a service + cloud storage.
- Projects/artifacts in the workspace are still sample data (the schema for them exists; Part 3 fills them with real generations).

## Data model (Prisma)
`User` (name, email, password, plan, credits) · `Account`/`Session`/`VerificationToken` (auth) · `Project` (script, status) · `Job` (stage, progress) · `Artifact` (kind, url). See `prisma/schema.prisma`.

## Deploy
Vercel: add the same env vars in the project settings, and run `npm run db:push` once against your production database (or use `prisma migrate deploy`). Set `NEXTAUTH_URL` to your live URL and add the Google redirect URI for that domain.

## Structure (added in Part 2)
```
prisma/schema.prisma          database models
lib/prisma.ts                 Prisma client
lib/auth.ts                   NextAuth config (credentials + Google)
middleware.ts                 protects /app
components/Providers.tsx      SessionProvider
app/api/auth/[...nextauth]/   NextAuth handler
app/api/register/route.ts     signup (hash + create user)
app/api/me/route.ts           current user's plan + credits
```

---

## Part 3 — generation wired (added)
The workspace now creates real projects and runs generation through a **separate worker** (the `ai-film-pro` project) that shares this database and a **Cloudflare R2** bucket. See `ai-film-pro/WORKER.md` for the full picture.

**Web-side additions:**
- `app/api/projects/*` — create / list / status / select / delete projects (all ownership-checked).
- `components/CreateFlow.tsx` — the script → character-pick → render → film flow in the browser.
- Schema: `Project` gained generation state (`breakdownJson`, `optionsJson`, `selectionJson`, `filmUrl`), `Job` gained `type`/`status`.

**To run the full loop you also need:** the worker running (Railway/Render) + an R2 bucket, both pointed at this same `DATABASE_URL`. Without the worker, projects will be created but stay in "Generating…" (nothing processes the queue).

**Ports.** The web app runs on `http://localhost:3000`. The pipeline project (`ai-film-pro`) also ships a local preview server that defaults to port 3000, so if you run it at the same time as the web app, start it with `PORT=3001` (`PORT=3001 npm run web`) to avoid a clash. The background worker (`npm run worker`) processes the queue and needs no port.

After pulling this, run `npm run db:push` again (schema changed), then `npm install` / `npm run dev`.

---

## Part 4 — Stripe + admin + hardening (delta)

**New files (web):** `lib/stripe.ts`, `lib/plans.ts`, `lib/isAdmin.ts`, `app/api/stripe/{checkout,webhook,portal}/route.ts`, `app/api/admin/{overview,credits}/route.ts`, `app/admin/page.tsx`, `PRODUCTION.md`.
**Changed (web):** `prisma/schema.prisma` (User gains `stripeCustomerId`, `stripeSubscriptionId`), `app/pricing/page.tsx` (real checkout), `app/app/page.tsx` (Billing → Stripe portal), `middleware.ts` (+/admin), `next.config.mjs` (security headers), `app/globals.css` (admin styles), `package.json` (+stripe), `.env.example`.
**Changed (worker / ai-film-pro):** `src/worker.ts` (refunds a credit if a render fails).

**To apply over deployed code:** `git commit` first, then either drop in the new zips or copy just the files above. Then `npm install` (adds Stripe) and `npm run db:push` (schema changed). Add the new env vars (`STRIPE_*`, `ADMIN_EMAILS`) and set up a Stripe webhook to `/api/stripe/webhook`. Full steps + the security/scale checklist are in `PRODUCTION.md`.

**What's real now:** paid plan checkout via Stripe, subscription webhooks that set plan + credits, a customer portal, an `/admin` console (for `@safa.ai` emails) to view users/jobs and grant credits, security headers, and automatic credit refunds on failed renders.