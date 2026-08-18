// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { moderateText, blockedMessage } from "@/lib/moderation";
import { reviewScriptSafety, logSafetyRefusal } from "@/lib/scriptSafety";
import { prisma, withTransactionRetry } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { sanitizeSettings, sanitizeAspect, applyPlanLimits, creditsFor, estimateCostUsd } from "@/lib/pricing";
import { spendBlocked, claimFreeFilm } from "@/lib/spend";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";
import { MAX_SCRIPT_CHARS, MIN_SCRIPT_CHARS, MIN_AD_SCRIPT_CHARS } from "@/lib/limits";

export const dynamic = "force-dynamic";

// List the current user's projects
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, status: true, filmUrl: true, script: true, updatedAt: true },
  });
  return NextResponse.json({ projects });
}

// Derive a readable title from the script (first meaningful line, cleaned up)
function deriveTitle(script: string): string {
  const lines = script.split("\n").map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[.*\]$/.test(l));            // skip [Target length: ...] etc.
  for (let l of lines) {
    l = l.replace(/^title\s*[:\-]\s*/i, "").replace(/^(int|ext)[.\s]+/i, "").replace(/\s*[-–]\s*(day|night|morning|evening|continuous).*$/i, "").trim();
    if (l.length >= 2) {
      let words = l.split(/\s+/).slice(0, 8).join(" ");
      if (words && words === words.toUpperCase()) words = words.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); // de-shout scene headings
      return words.length > 60 ? words.slice(0, 57).trimEnd() + "…" : words;
    }
  }
  return "New film";
}

// Create a project from a script and queue the "options" job
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { script, title, duration, productImages, characterImages, resolution, aspectRatio, audio, seconds, titleCard, type, cameraStyle, spokesperson, language } = body;
  // AI SONG VIDEOS — `type: "song_video"` reuses the `script` column as the
  // theme/mood prompt (same convention "ad mode" already established via
  // productImages, not its own column — see Project.script's own schema
  // comment). Everything below through the safety review is shared between
  // both project types; the two diverge only at project-creation time.
  const isSongVideo = type === "song_video";
  // AD MODE — `type: "ad"` reuses `script` as a short creative PROMPT, same
  // convention song_video already established. A real ad brief can be much
  // shorter than a narrative script or even a song theme ("create an ad for
  // this product" is ~31 chars) — the shared 40-char minimum below would
  // reject that today, so ad mode gets its own, much lower floor.
  const isAd = type === "ad";
  const trimmed = String(script || "").trim();
  const minLen = isAd ? MIN_AD_SCRIPT_CHARS : MIN_SCRIPT_CHARS;
  if (trimmed.length < minLen) {
    return NextResponse.json(
      {
        error: isSongVideo
          ? "Describe your song's theme or mood in a bit more detail (40 characters or more)."
          : isAd
          ? "Describe what you want your ad to show — a sentence is enough (10 characters or more)."
          : "Your script is too short to film. Write at least a few sentences (40 characters or more).",
      },
      { status: 400 },
    );
  }
  if (trimmed.length > MAX_SCRIPT_CHARS) {
    const limit = MAX_SCRIPT_CHARS.toLocaleString("en-US");
    return NextResponse.json(
      {
        error: isSongVideo
          ? `Keep your theme description under ${limit} characters.`
          : `Your script is too long. Keep it under ${limit} characters.`,
      },
      { status: 400 },
    );
  }
  if (user.credits <= 0) {
    return NextResponse.json({ error: "You're out of render credits. Upgrade your plan to continue." }, { status: 402 });
  }

  // ── RENDER SETTINGS + PLAN LIMITS + VARIABLE PRICING ─────────────────────
  // The user picks resolution / orientation / audio and we charge for exactly
  // that. Free plans are CLAMPED (15s, 480p, no audio) rather than refused, so
  // they still get a film - just the free-tier version of it.
  const asked = sanitizeSettings({ seconds, resolution, audio });
  const aspect = sanitizeAspect(aspectRatio);
  const { settings, clamped } = applyPlanLimits(asked, user.plan);
  const cost = creditsFor(settings);
  if (user.credits < cost) {
    return NextResponse.json(
      { error: `This film costs ${cost} credit${cost === 1 ? "" : "s"} at ${settings.resolution}${settings.audio ? " with audio" : ""}. You have ${user.credits}. Lower the resolution, shorten it, or upgrade your plan.` },
      { status: 402 },
    );
  }

  // product images: keep only valid string URLs. Capped at 1 for type "ad"
  // (one hero product — the ad director plans an entire shot list AROUND
  // this single photo, see 1c-ad-breakdown.ts), 4 for a normal film.
const productUrls: string[] = Array.isArray(productImages)
  ? productImages.filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, isAd ? 1 : 4)
  : [];

  // Uploaded character casting photos — available for every project type
  // (film, ad, song_video). Matched to breakdown.characters by array order
  // downstream (see 2-options.ts's runOptions()) — every type eventually
  // reaches the same "options" job/casting step once its own breakdown
  // exists (song_video's own breakdown comes from a separate "song_breakdown"
  // job, but rejoins the exact same options/select flow afterward).
  const characterUrls: string[] = Array.isArray(characterImages)
    ? characterImages.filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 4)
    : [];

  // Title card: free (no pricing/credit impact — it's a deterministic ffmpeg
  // overlay in assembly, not a generation cost), so unlike resolution/audio
  // above this doesn't go through sanitizeSettings/creditsFor. Defaults ON
  // (matches the Project.titleCardEnabled column default) — only an explicit
  // `false` opts out.
  const titleCardOn = titleCard !== false;

// fold the requested length into the script so the breakdown respects it
  let fullScript = duration ? `[Target length: ${duration}]\n${script}` : String(script);
  // Ad mode's "signature camera style" picker (CreateFlow's attach-bar) —
  // same bracket-tag-prefix convention as duration above. Ad-mode-only:
  // worker.ts's handleBreakdown() only strips/reads this tag when
  // project.type === "ad", so scoping it to isAd here just keeps a stray
  // tag out of a normal film's script rather than being load-bearing.
  if (isAd && typeof cameraStyle === "string" && cameraStyle.trim()) {
    fullScript = `[Camera style: ${cameraStyle.trim()}]\n${fullScript}`;
  }
  // Ad mode's "Spokesperson" toggle — same bracket-tag-prefix convention as
  // the two above. Ads are FACELESS (product-only) unless the user opts in,
  // so the tag is only written for an explicit yes. Without it, the ad
  // director plans no people at all; with it, one spokesperson shot is
  // planned even when no character photo was uploaded (the user then picks
  // an AI-designed look at casting). An uploaded character photo already
  // implies yes — CreateFlow sends the combined value.
  if (isAd && spokesperson === true) {
    fullScript = `[Spokesperson: yes]\n${fullScript}`;
  }
  // SPOKEN LANGUAGE — film mode only, same bracket-tag-prefix convention as the
  // three above (read by parseLanguage() in ai-film-pro/src/lib/languages.ts).
  // Only the film path plans dialogue from a screenplay; ads are voiceover/
  // product-led and are not part of this feature, so scoping it to !isAd keeps
  // a stray tag out of an ad's script the same way the two tags above are
  // scoped to ads. Written ONLY for a non-English choice: no tag means English,
  // which is exactly the behaviour every project had before this existed, so
  // nothing changes for anyone who doesn't pick a language.
  if (!isAd && typeof language === "string" && SUPPORTED_LANGUAGES.has(language.toLowerCase()) && language.toLowerCase() !== "en") {
    fullScript = `[Language: ${language.toLowerCase()}]\n${fullScript}`;
  }
  // MODERATION: screen the script before it becomes a film (and before it costs money).
  const mod = await moderateText(trimmed);
  if (!mod.allowed) return NextResponse.json({ error: blockedMessage(mod.reason) }, { status: 422 });

  // PRIORITY 1 CONTENT SAFETY GATE (lib/scriptSafety.ts) — a SECOND, screenplay-
  // specific review, complementary to moderateText() above: real-person/consent,
  // copyrighted IP, age-ambiguous sexual content, graphic violence, hate/
  // extremism, and dangerous real-world instructions embedded in the story —
  // categories the general-purpose moderation endpoint above has no concept of
  // at all. Runs BEFORE the project row is created and BEFORE any generation
  // spend, the first gate in the pipeline, not folded into moderateText()'s own
  // check. No projectId yet (nothing has been created) — logged with userId only.
  const safety = await reviewScriptSafety(trimmed);
  if (safety.decision === "refuse") {
    await logSafetyRefusal({ userId: user.id, projectId: null, stage: "script_submit", review: safety, script: trimmed });
    return NextResponse.json({ error: blockedMessage(safety.summary) }, { status: 422 });
  }

  // AI SONG VIDEOS — a materially different creation path from here on, not
  // just a different `type` value on the same object: a song video has no
  // free breakdown-only stage first (unlike a narrative film, where LLM-only
  // breakdown is free and the first real spend is later, at select/route.ts).
  // "song" (real lyrics + a real sung track) IS the first real paid spend —
  // worker.ts's own free-film-refund logic already treats job.type "song" the
  // same tier as "shots" for exactly this reason — so the credit charge and
  // free-film claim happen HERE, atomically, at creation, mirroring
  // select/route.ts's own withTransactionRetry + claimFreeFilm pattern (and
  // this session's own atomic-claim fix for the identical double-charge race
  // that pattern exists to prevent).
  if (isSongVideo) {
    const blocked = await spendBlocked(user.id);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 429 });

    try {
      let songProjectId = "";
      await withTransactionRetry(async (tx) => {
        const claimed = await claimFreeFilm(tx, user.id, user.plan);
        if (!claimed) throw new Error("FREE_FILM_ALREADY_USED");

        await tx.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
        const created = await tx.project.create({
          data: {
            userId: user.id,
            title: title?.trim() || "New song video",
            type: "song_video",
            script: trimmed, // the theme/mood prompt, not a screenplay — see Project.script's own comment
            characterImages: characterUrls, // optional performer photo — see 2-options.ts's runOptions()
            resolution: settings.resolution,
            aspectRatio: aspect,
            audioEnabled: settings.audio,
            titleCardEnabled: titleCardOn,
            creditsCost: cost,
            status: "generating_song",
            jobs: { create: { type: "song", status: "queued", stage: "Queued", payload: { targetLengthSec: settings.seconds } } },
          },
        });
        songProjectId = created.id;
      });
      return NextResponse.json({ id: songProjectId, credits: cost, estimatedUsd: estimateCostUsd(settings), clamped });
    } catch (e: any) {
      if (e?.message === "FREE_FILM_ALREADY_USED") {
        return NextResponse.json(
          { error: "You've used your free film. Subscribe to make more — full quality, no watermark." },
          { status: 429 },
        );
      }
      throw e;
    }
  }

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      title: title?.trim() || deriveTitle(String(script)),
      type: isAd ? "ad" : "film",
      script: fullScript,
      productImages: productUrls,
      characterImages: characterUrls,
      resolution: settings.resolution,
      aspectRatio: aspect,
      audioEnabled: settings.audio,
      titleCardEnabled: titleCardOn,
      creditsCost: cost, // locked in now — every later charge (select/proceed/regen_all) spends exactly this
      status: "generating_breakdown",
      jobs: { create: { type: "breakdown", status: "queued", stage: "Queued" } },
    },
  });
  return NextResponse.json({ id: project.id, credits: cost, estimatedUsd: estimateCostUsd(settings), clamped });
}