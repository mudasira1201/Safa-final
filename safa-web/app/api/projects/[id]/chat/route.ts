// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/chat/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma, withTransactionRetry } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { spendBlocked, claimFreeFilm } from "@/lib/spend";
import { parseIntent } from "@/lib/intent";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { moderateText, blockedMessage } from "@/lib/moderation";
import { statusWorking } from "@/lib/status";

const MAX_FREE_CLIP_REGENS = 10;
// Matches breakdown/route.ts's "confirm" action and options/route.ts's "regenerate" —
// same cap, same job type, so chat cannot be used to bypass it.
const MAX_OPTION_RUNS = 6;

// WHICH WAITING STAGE MAPS TO WHICH NEXT JOB. "continue" used to only understand ONE
// of these (awaiting_selection -> render the clips), so a user who paused right after
// the shot list came back (breakdown_review) or right after clips finished
// (clips_review) got a flat "I can't start from here" refusal — even though both are
// perfectly legitimate places to say "continue". Each entry mirrors the exact job type
// and payload shape the dedicated per-stage endpoint already uses (breakdown/route.ts's
// "confirm", clips/route.ts's "assemble"), so chat behaves identically to clicking the
// equivalent button, whichever stage the project is actually paused at.
type ResumeStep = {
  nextStatus: string;
  jobType: string;
  payload?: unknown;
  chargeCredit: boolean; // only the FIRST paid step (keyframes) spends the film's render credit
  // Whether to (re-)claim the free-film flag in the same transaction — see
  // claimFreeFilm()'s own comment: for a free-tier user this ATOMICALLY flips
  // freeFilmUsedAt from null -> now(), but a SECOND call when it's already
  // non-null returns false and the caller treats that as "already used" and
  // refuses. So this must be true ONLY where freeFilmUsedAt is actually still
  // null at this point: the very first keyframes claim, or a re-claim after
  // the worker reset it back to null on a content-refusal refund (see
  // resumeForNeedsEdit() below) — NEVER on the routine keyframes_review ->
  // render_clips resume, where the flag is already legitimately set from the
  // original selection and must be left alone.
  claimFreeFilm: boolean;
  optionsCap?: boolean; // only the options step is subject to MAX_OPTION_RUNS
  reply: string;
};

const RESUME_STEPS: Record<string, ResumeStep> = {
  breakdown_review: {
    nextStatus: "generating_options",
    jobType: "options",
    chargeCredit: false,
    claimFreeFilm: false,
    optionsCap: true,
    reply: "Great, designing your character looks now.",
  },
  awaiting_selection: {
    nextStatus: "generating_shots",
    jobType: "shots",
    chargeCredit: true,
    claimFreeFilm: true,
    reply: "Starting the keyframe generation now.",
  },
  // needs_edit deliberately has NO static entry here — see resumeForNeedsEdit()
  // below, same reasoning as retryForFailedJob(): which job actually paused
  // (the keyframes stage vs. the clips stage) determines what "continue"
  // should re-queue, and a status string alone can't tell you that.
  keyframes_review: {
    nextStatus: "generating_shots",
    // NOT a new charge — the film's one render credit was already spent when
    // the "shots" (keyframes) job was first queued; approving keyframes and
    // moving on to clip rendering is the second half of that SAME paid render,
    // same as clips_review -> assemble below.
    jobType: "render_clips",
    chargeCredit: false,
    claimFreeFilm: false,
    reply: "Great, filming the clips now.",
  },
  clips_review: {
    nextStatus: "assembling",
    jobType: "assemble",
    payload: { order: [] },
    chargeCredit: false,
    claimFreeFilm: false,
    reply: "Stitching your final film together now.",
  },
};

// A job's `type` tells us WHICH stage actually died when status is "failed" — that
// status alone throws away which step was in progress. The OLD behaviour treated every
// failure as "clip rendering must have failed" and always resumed into generating_shots
// — so a failed BREAKDOWN or OPTIONS job would jump straight to rendering clips for a
// shot list or character set that was never actually produced. Retrying must REDO the
// job that actually died, with its own payload, not skip ahead to the next stage.
function retryForFailedJob(lastJobType: string | undefined, lastJobPayload: unknown): ResumeStep | null {
  switch (lastJobType) {
    case "breakdown":
    case "regen_shot":
      return { nextStatus: "generating_breakdown", jobType: lastJobType, payload: lastJobPayload, chargeCredit: false, claimFreeFilm: false, reply: "Re-planning the shot list now." };
    case "options":
      return { nextStatus: "generating_options", jobType: "options", chargeCredit: false, claimFreeFilm: false, optionsCap: true, reply: "Re-designing your character looks now." };
    case "shots":
    case "regen_clip":
      // A dead "shots" job here means the FIRST paid step never actually
      // finished (this is the "failed" status, not "needs_edit" — a genuine,
      // non-content-refusal permanent failure). freeFilmUsedAt was reset to
      // null by the SAME worker.ts branch that reset it for a content
      // refusal, so this re-claim is the same, already-null case, not a
      // double-claim.
      return { nextStatus: "generating_shots", jobType: lastJobType, payload: lastJobPayload, chargeCredit: true, claimFreeFilm: lastJobType === "shots", reply: "Retrying the clip generation now." };
    case "assemble":
      return { nextStatus: "assembling", jobType: "assemble", payload: lastJobPayload, chargeCredit: false, claimFreeFilm: false, reply: "Retrying the final assembly now." };
    default:
      return null; // no job on record to say what failed — fall back to the generic refusal
  }
}

// needs_edit is reachable from EITHER paid job (see worker.ts's
// ContentRefusedError handling, which now covers both "shots" and
// "render_clips") — which one actually paused determines whether "continue"
// should re-render keyframes from scratch or resume straight into filming
// clips the already-approved keyframes. Both reset freeFilmUsedAt to null on
// the way in (same worker.ts branch), so both legitimately re-claim it here.
function resumeForNeedsEdit(lastJobType: string | undefined): ResumeStep {
  if (lastJobType === "render_clips") {
    return { nextStatus: "generating_shots", jobType: "render_clips", chargeCredit: true, claimFreeFilm: true, reply: "Picking up where that left off and filming now." };
  }
  return { nextStatus: "generating_shots", jobType: "shots", chargeCredit: true, claimFreeFilm: true, reply: "Picking up where that left off and rendering now." };
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await rateLimit(clientKey(req, "chat") + ":" + user.id, 20, 60_000))) {
    return NextResponse.json({ error: "You're sending changes very fast. Please wait a moment." }, { status: 429 });
  }
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { content } = body;
  if (!content || !String(content).trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  // MODERATION: a chat note is folded into the render prompt, so screen it too.
  const mod = await moderateText(String(content));
  if (!mod.allowed) return NextResponse.json({ error: blockedMessage(mod.reason) }, { status: 422 });

  // store the user's message
  await prisma.message.create({ data: { projectId: project.id, role: "user", content: String(content).trim() } });

  const clips = (project.clipsJson || []) as { id: string; url: string; label: string }[];
  const intent = await parseIntent(String(content).trim(), clips);

  // Reply + return, without queueing anything. Used by every guard below so the
  // user always sees a specific reason rather than silence.
  const say = async (msg: string, extra: Record<string, unknown> = {}) => {
    await prisma.message.create({ data: { projectId: project.id, role: "assistant", content: msg } });
    const messages = await prisma.message.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true },
    });
    return NextResponse.json({ messages, acted: false, ...extra });
  };

  // ── PROCEED: carry on to WHATEVER the next stage is ──────────────────────
  // This is the same paid action as the equivalent per-stage button, so it runs
  // the SAME guards that button does: correct status, any applicable cap, spend
  // caps, a credit in hand, and one atomic write. Skipping any of them would make
  // chat a way to start paid work for free. Resumes from ANY waiting stage the
  // project can legitimately pause at (see RESUME_STEPS), not just the one right
  // before clip rendering.
  if (intent.action === "proceed") {
    if (statusWorking(project.status)) {
      return say("That's already running — I'll show the result here as soon as it's ready.");
    }
    if (project.status === "done") {
      return say("This film is already finished. Tell me a change if you'd like me to adjust a clip.");
    }

    let step: ResumeStep | null = RESUME_STEPS[project.status] ?? null;
    if (project.status === "failed") {
      const lastJob = await prisma.job.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });
      step = retryForFailedJob(lastJob?.type, lastJob?.payload);
    }
    if (project.status === "needs_edit") {
      const lastJob = await prisma.job.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });
      step = resumeForNeedsEdit(lastJob?.type);
    }
    if (!step) {
      return say(
        `I can't continue from here yet (this project is at the "${project.status}" stage). ` +
          `Once the shot list is ready, say "continue" and I'll take it from there.`,
      );
    }

    if (step.optionsCap) {
      const used = await prisma.job.count({ where: { projectId: project.id, type: "options" } });
      if (used >= MAX_OPTION_RUNS) {
        return say(`You've reached the limit of ${MAX_OPTION_RUNS} character generations for this film. Start a new film to keep going.`);
      }
    }
    // COST: the film's real, locked-in price (see app/api/projects/route.ts's
    // creditsCost) — not a flat 1. Only relevant when this step actually
    // spends a credit at all (step.chargeCredit).
    const cost = Math.max(1, project.creditsCost || 1);
    if (step.chargeCredit) {
      const blocked = await spendBlocked(user.id);
      if (blocked) return say(blocked, { error: blocked });
      if (user.credits < cost) {
        return say(`You're ${cost - user.credits} credit${cost - user.credits === 1 ? "" : "s"} short to start the clips (this film costs ${cost}). Single-clip tweaks are still free.`);
      }
    }

    // Charge the film's real cost (only when this step actually spends one) and queue the job
    // atomically, exactly as the dedicated per-stage endpoints do, so a double-click
    // cannot start two renders. Any existing character selection is preserved when
    // resuming into clip rendering; the worker defaults to option 1 when there is none.
    //
    // FREE-FILM CAP: this "shots" transition is the SAME paid action
    // select/route.ts protects with claimFreeFilm() — without calling it here
    // too, "continue" in chat would let a free-tier user bypass the one-film
    // cap entirely by never using the dedicated select button.
    try {
      await withTransactionRetry(async (tx) => {
        if (step!.claimFreeFilm) {
          const claimed = await claimFreeFilm(tx, user.id, user.plan);
          if (!claimed) throw new Error("FREE_FILM_ALREADY_USED");
        }
        if (step!.chargeCredit) {
          await tx.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
        }
        await tx.project.update({
          where: { id: project.id },
          data: {
            ...(step!.jobType === "shots" ? {
              selectionJson: (project.selectionJson as any) ?? {},
              locationSelectionJson: (project.locationSelectionJson as any) ?? {},
            } : {}),
            status: step!.nextStatus,
            error: null, // clear any previous refusal/failure detail; we are trying again
            jobs: { create: { type: step!.jobType, status: "queued", stage: "Queued", ...(step!.payload ? { payload: step!.payload as any } : {}) } },
          },
        });
      });
    } catch (e: any) {
      if (e?.message === "FREE_FILM_ALREADY_USED") {
        return say("You've used your free film. Subscribe to make more — full quality, no watermark.", {
          error: "You've used your free film. Subscribe to make more — full quality, no watermark.",
        });
      }
      throw e;
    }

    await prisma.message.create({ data: { projectId: project.id, role: "assistant", content: step.reply } });
    const messages = await prisma.message.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true },
    });
    return NextResponse.json({ messages, acted: true });
  }

  // ---- cost control (server-side, cannot be bypassed) ----
  // COST: a whole-film re-render costs exactly the same as the original film
  // did (same resolution/length/audio, see Project.creditsCost) — real
  // provider money is spent again in full, not a flat 1 regardless of tier.
  const regenAllCost = Math.max(1, project.creditsCost || 1);
  if (intent.action === "regen_all") {
    if (user.credits < regenAllCost) {
      return say(`You're ${regenAllCost - user.credits} credit${regenAllCost - user.credits === 1 ? "" : "s"} short to re-render the whole film (it costs ${regenAllCost}). Single-clip tweaks are still free.`);
    }
  } else if (intent.action === "regen_clip") {
    const used = await prisma.job.count({ where: { projectId: project.id, type: "regen_clip" } });
    if (used >= MAX_FREE_CLIP_REGENS) {
      return say(`You've reached the limit of ${MAX_FREE_CLIP_REGENS} free clip regenerations for this film. Start a new film to keep editing.`);
    }
  }

  // store the assistant's reply
  await prisma.message.create({ data: { projectId: project.id, role: "assistant", content: intent.reply } });

  // FREE-FILM CAP: regeneration is a PAID action. The free tier gets exactly one film
  // and no re-renders — otherwise "regenerate the whole film" in chat is an unlimited
  // spend bypass. Paid plans regen freely (governed by credits).
  const isRegen = intent.action === "regen_clip" || intent.action === "regen_all";
  if (isRegen) {
    const plan = (user.plan || "lite").toLowerCase();
    if (plan === "lite" || plan === "free") {
      const reply = "Regenerating shots is a subscriber feature. Your free film is ready to keep — subscribe to refine it or make more.";
      return say(reply, { error: reply });
    }
    // Paid: still respect the global/monthly budget guards.
    const blocked = await spendBlocked(user.id);
    if (blocked) return say(blocked, { error: blocked });
  }

  // enqueue the right EXISTING job
  if (intent.action === "regen_clip" && intent.clipNumber && clips[intent.clipNumber - 1]) {
    const clipId = clips[intent.clipNumber - 1].id;
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "generating_shots", jobs: { create: { type: "regen_clip", status: "queued", stage: "Queued", payload: { id: clipId, note: intent.note } } } },
    });
  } else if (intent.action === "regen_all") {
    // atomically charge the film's real cost, then record the change as a
    // SEPARATE note (the original breakdown stays pristine; notes are
    // composed at render time)
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: regenAllCost } } });
    const bd = (project.breakdownJson || {}) as any;
    if (intent.note) {
      bd.globalNotes = Array.isArray(bd.globalNotes) ? [...bd.globalNotes, intent.note] : [intent.note];
      await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: bd } });
    }
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "generating_shots", jobs: { create: { type: "shots", status: "queued", stage: "Queued" } } },
    });
  }
  // for "reply" -> no job, just conversation

  const messages = await prisma.message.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, role: true, content: true } });
  return NextResponse.json({ messages, acted: intent.action !== "reply" });
}