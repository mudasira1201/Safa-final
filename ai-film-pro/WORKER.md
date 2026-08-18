# safa — Worker & Part 3 setup

Part 3 makes generation actually happen in the hosted app. It has **two running pieces** that share one database and one storage bucket:

```
   Browser
      │
      ▼
 ┌─────────────┐      writes jobs / reads status      ┌──────────────┐
 │  safa-web    │ ───────────────────────────────────▶ │  Neon (DB)   │
 │  (Vercel)    │                                       └──────┬───────┘
 └─────────────┘                                              │ polls jobs
                                                              ▼
                                                       ┌──────────────┐   uploads media   ┌──────────────┐
                                                       │  worker      │ ─────────────────▶ │ Cloudflare R2│
                                                       │ (this repo)  │                    └──────────────┘
                                                       │ Railway/Render│
                                                       └──────────────┘
```

- **safa-web** (Vercel): creates projects, enqueues jobs, shows progress. Never runs the pipeline.
- **worker** (this project, on Railway/Render): polls the DB for queued jobs, runs the pipeline, uploads results to R2, writes progress + the final film URL back to the DB.

They talk **only through the shared Neon database and R2** — no direct connection.

## What you need to create
1. **Cloudflare R2 bucket** (e.g. `safa-media`): create an R2 API token (Access Key + Secret), and enable public access (r2.dev URL) or attach a custom domain — that's your `R2_PUBLIC_BASE`.
2. **A worker host** that runs always-on Node with **ffmpeg** available (Railway and Render both work; ffmpeg is present on their default images, or add a buildpack/Dockerfile).

## Setup

Both projects must point at the **same** `DATABASE_URL` (your Neon string).

### Worker (this project)
```bash
npm install                 # runs prisma generate
cp .env.example .env         # fill FAL_KEY, LLM_API_KEY, DATABASE_URL, and all R2_* values
npm run worker               # starts polling for jobs
```

You do **not** run `db:push` here — the web app owns the schema and creates the tables. The worker just uses the same models. (If you changed the schema, push it once from either project.)

### How a film gets made
1. In the web app a user submits a script → a `Project` + a `Job(type=options)` row appear (status `queued`).
2. The worker picks up the job → runs breakdown + character options → uploads option images to R2 → sets the project to `awaiting_selection`.
3. The user picks a character in the web UI → a credit is spent → a `Job(type=render)` is queued.
4. The worker renders the sheet → keyframes → clips → stitches the film → uploads `final.mp4` to R2 → sets the project `done` with the film URL.
5. The web UI has been polling the whole time and now plays the film.

## Deploy the worker
- **Railway/Render:** new service from this repo, start command `npm run worker`, add all the env vars (FAL_KEY, LLM_API_KEY, DATABASE_URL, R2_*). Make sure ffmpeg is available (Railway includes it; on Render use a Dockerfile with `apt-get install ffmpeg` if needed).
- **CORRECTED (was stale): multiple worker instances are safe.** `claimJob()` in worker.ts claims a job with an atomic conditional `updateMany({ where: { id, status: "queued" } })`, not a read-then-write — Postgres serializes concurrent UPDATEs to the same row, so exactly one worker ever wins a given job, no raw-SQL row-locking needed. Per-job `setJobOutDir()` isolation (called before any file I/O) also already prevents one worker's in-progress files from being wiped by another. Scale to N instances on Railway/Render (or run `npm run worker` N times against the same DATABASE_URL) whenever you need more throughput than one process provides — no further code change needed for this specifically.
- **What still needs deciding, not code:** how many instances to run, and whether your fal.ai account's concurrent-request allocation (dashboard → usage) is large enough to cover `(worker instances) × CONCURRENCY` combined — that's an infrastructure/capacity decision, separate from whether multi-worker is safe.

## Honest limits of this build
- **DB-polling queue**, not a dedicated message queue (BullMQ/Inngest). Simple and robust; fine at moderate volume. A real queue is a later optimization for very high job-creation rates, not a correctness requirement — the atomic claim above already prevents double-processing regardless.
- **One job at a time PER WORKER PROCESS**, and each job uses its own namespaced `output/job-<id>/` folder (not shared across jobs). Running more worker processes is how you get more jobs in flight at once.
- **Untested end to end** — this is a lot of moving parts (R2 credentials, ffmpeg on the host, the two-phase job flow). Expect to debug the first run. The worker logs each job and the exact error on failure, and failures are written to the project so the UI shows them.
- Credits are spent at selection time; refund-on-failure isn't wired yet (Part 4).

## New files in this project
```
prisma/schema.prisma   shared DB models (same as web)
src/db.ts              Prisma client
src/storage.ts         R2 upload
src/worker.ts          the polling loop that runs the pipeline
```
