// src/providers/qa-runtime.ts
// -----------------------------------------------------------------------------
// Wires the (previously unused) qa.ts into your stack with two tiny adapters:
//   • VisionClient  → your OpenAI-compatible client, using a vision model.
//   • Uploader      → your existing R2 uploadFile().
// Plus inspectClip(), the one call step 5 makes per shot.
//
// SAFE BY DEFAULT: QA is OFF unless QA_ENABLED=true in .env, so dropping this in
// (and the step-5 changes) changes NOTHING until you opt in. Turn it on when ready.
//
//   QA_ENABLED=true            # master switch (default false)
//   QA_MAX_RETRIES=1           # re-rolls per failing shot (default 1)
//   QA_SEVERITY=0.5            # re-roll only when a finding is >= this (0..1)
//   QA_FRAMES=4                # frames sampled per clip (default 4)
//   QA_VISION_MODEL=gpt-4.1-mini   # must be a VISION model; defaults to LLM_MODEL
// -----------------------------------------------------------------------------

import OpenAI from "openai";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { uploadFile } from "../storage";
import { prisma } from "../db";
import {
  sampleFrames,
  runQA,
  shouldRegenerate,
  checkIdentityConsistency,
  type VisionClient,
  type Uploader,
  type QAResult,
} from "./qa";
import type { Shot } from "../types";

// PRIORITY 5 — PRODUCTION MONITORING (see the QaEvent model, schema.prisma).
// Every real QA outcome, structured — the unverified-rate and pass/fail-
// drift metrics safa-web's admin overview aggregates. SCOPED HONESTLY: no
// projectId is threaded through here (config/runtime carries no current-
// project context this deep in the call stack, and adding one would mean
// changing the signature of every one of these functions' many call sites
// for a field the AGGREGATE metrics this priority actually asks for —
// overall unverified rate, overall pass/fail rate over time — don't
// strictly need). shotId alone is enough to debug a specific event; a
// per-project breakdown is a real, scoped-out follow-up, not silently
// pretended to already exist. Never throws — a logging failure must not
// affect a real render, same discipline as logSpend() (spend.ts).
async function logQaEvent(shotId: string, stage: "keyframe" | "identity" | "clip", outcome: "pass" | "fail" | "unverified", findingKinds: string[] = []): Promise<void> {
  try {
    await prisma.qaEvent.create({
      data: { shotId, stage, outcome, findingKinds: findingKinds.join(",") },
    });
  } catch (e) {
    console.error("[qa] could not log QaEvent:", (e as Error)?.message);
  }
}

const QA_ENABLED = (process.env.QA_ENABLED ?? "false") === "true";
const QA_MAX_RETRIES = Math.max(0, parseInt(process.env.QA_MAX_RETRIES ?? "1", 10) || 0);
// CRITICAL_KINDS (qa.ts, exported — see its own comment) — extra_people,
// duplicated_object, blurry_or_soft_focus, unnatural_motion, flat_performance,
// identity_drift, treadmill, motion_loop, reversed_motion, anatomy_error —
// are dealbreakers, not ordinary defects. A user will forgive a slightly
// stiff walk but a second copy of the lead standing next to themselves, a
// smeared opening frame, robotic/incomplete motion, a face that doesn't sell
// its emotion, a character who's visibly become a different person, a runner
// going nowhere, a gesture that visibly repeats/restarts within one clip,
// someone walking backward when the shot describes them approaching, or a
// warped hand/extra limb all read as broken software. These kinds get their own
// LOWER severity trigger too (CRITICAL_SEVERITY_THRESHOLD in qa.ts, 0.3 vs the
// normal 0.5) — caught more sensitively as well as retried harder.
//
// HISTORY, KEPT HONEST: this budget was previously cut from 3 down to 1 (to
// match QA_MAX_RETRIES) on the reasoning that several root causes of duplication
// had been fixed at the source (the assembly-stage dissolve, the stale-artifact
// cache, weak multi-person cast-lock text), so a smaller retry budget seemed
// like an acceptable cost/coverage tradeoff. A real render then directly
// contradicted that: 13 of 14 shots in one film still failed QA even AFTER
// their one retry, dominated by exactly these critical kinds. Restored to 3 —
// the earlier root-cause fixes were real and worth keeping, but they did not
// make one retry sufficient on their own.
// CONFIRMED REAL GAP, FIXED (2026-08-08): this comment said "restored to 3"
// but the fallback below still read `?? "1"` — the restore was never actually
// applied to the code, so every deployment without an explicit env override
// silently stayed at the exact budget this comment says was already proven
// insufficient. Now genuinely defaults to 3, matching the documented intent.
const QA_CRITICAL_MAX_RETRIES = Math.max(
  QA_MAX_RETRIES,
  parseInt(process.env.QA_CRITICAL_MAX_RETRIES ?? "3", 10) || 3,
);
const QA_SEVERITY = Math.min(Math.max(parseFloat(process.env.QA_SEVERITY ?? "0.5"), 0), 1);
const QA_FRAMES = Math.max(2, parseInt(process.env.QA_FRAMES ?? "4", 10) || 4);
const QA_MODEL = process.env.QA_VISION_MODEL?.trim() || config.llmModel;

// QA-CALL RELIABILITY — a DIFFERENT budget from QA_MAX_RETRIES/QA_CRITICAL_
// MAX_RETRIES above, which are about re-rendering a shot that QA correctly
// judged defective. This is about the QA CALL ITSELF failing to complete at
// all — a network blip, a malformed vision-model response, an ffmpeg frame-
// sampling error — which previously silently returned {pass:true,
// result:null}, INDISTINGUISHABLE from "QA is disabled" or "QA genuinely
// passed". Confirmed real risk (world-state wiring audit): this single catch
// block is the shared failure point for every one of the ~20 QA finding
// kinds simultaneously — one transient error skips identity_drift,
// extra_people, anatomy_error, body_interpenetration, and everything else in
// the same call, together, invisibly. A network blip deserves a retry, not a
// free pass; and if it's STILL failing after that, the shot must ship
// tagged as UNVERIFIED, not as if it cleanly passed — see the `unverified`
// field on QACheck below, and 5-videos.ts's flag() call for where that
// becomes visible in the render's own diagnostics instead of buried in a
// console line nobody re-reads.
const QA_CALL_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.QA_CALL_MAX_ATTEMPTS ?? "3", 10) || 3);
const QA_CALL_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.QA_CALL_RETRY_DELAY_MS ?? "1500", 10) || 1500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same gap, same fix as providers/llm.ts's client — see its own comment.
// QA_CALL_MAX_ATTEMPTS above already retries a REAL failure; without this,
// a single hung attempt (no timeout, SDK default is 10 minutes) would still
// block the whole QA pass long before that retry logic ever got a chance to run.
const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl, timeout: 5 * 60_000 });

const vision: VisionClient = {
  async inspectJson<T>(args: { system: string; user: string; imageUrls: string[] }): Promise<T> {
    const { system, user, imageUrls } = args;
    const res = await client.chat.completions.create({
      model: QA_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          // text first, then the images in order (keyframe, then sampled frames)
          content: [
            { type: "text", text: user },
            ...imageUrls.map((url: string) => ({ type: "image_url", image_url: { url } })),
          ] as any,
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "{}";
    return JSON.parse(raw) as T;
  },
};

const uploader: Uploader = {
  async upload(bytes, filename): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "qa-up-"));
    try {
      const p = join(dir, filename);
      await writeFile(p, bytes);
      // Frames live under qa/ — add an R2 lifecycle rule to expire this prefix if you like.
      return await uploadFile(p, `qa/frames/${Date.now()}-${filename}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

export interface QACheck {
  pass: boolean;
  result: QAResult | null; // null when QA is disabled OR when the check failed — see `unverified`
  /** True ONLY when result is null because the QA call itself failed after
   *  QA_CALL_MAX_ATTEMPTS attempts — NOT set when QA is simply disabled.
   *  This is the field that makes "QA never actually ran for this shot"
   *  distinguishable from "QA ran and found nothing" — callers should
   *  surface this as a visible flag, not treat it as a clean pass. */
  unverified?: boolean;
}

/**
 * Sample the finished clip and judge it against the shot's intent. Returns
 * pass=true / result=null when QA is disabled, so callers can stay branch-free.
 * characterRefs: each named character's SAME canonical reference photo used everywhere else in the
 * film (see 3-sheet.ts) — lets identity_drift catch drift that already happened at the keyframe stage,
 * not just drift within this one clip relative to its own (possibly already-drifted) keyframe.
 *
 * RELIABILITY: retries the call itself (not the render) up to QA_CALL_MAX_
 * ATTEMPTS times on ANY exception — a transient network/API failure gets a
 * real second chance instead of silently waiving every QA category for this
 * shot. Only after every attempt fails does this give up, and even then it
 * returns pass:true WITH unverified:true — never blocks the render (the
 * established "QA must never break a render" discipline still holds), but
 * the caller can now tell "genuinely clean" apart from "never actually
 * checked" instead of the two being indistinguishable.
 */
export async function inspectClip(
  shot: Shot,
  clipUrl: string,
  keyframeUrl?: string,
  characterRefs?: { name: string; url: string }[],
  propRefs?: { name: string; url: string }[],
  locationRef?: { name: string; url: string },
): Promise<QACheck> {
  if (!QA_ENABLED) return { pass: true, result: null };
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= QA_CALL_MAX_ATTEMPTS; attempt++) {
    try {
      const frames = await sampleFrames(clipUrl, uploader, QA_FRAMES);
      const result = await runQA({ vision, frameUrls: frames, shot, keyframeUrl, characterRefs, propRefs, locationRef });
      const pass = !shouldRegenerate(result, QA_SEVERITY);
      await logQaEvent(shot.id, "clip", pass ? "pass" : "fail", pass ? [] : result.findings.map((f) => f.kind));
      return { pass, result };
    } catch (e) {
      lastError = e as Error;
      if (attempt < QA_CALL_MAX_ATTEMPTS) {
        console.warn(
          `   ⚠️  QA check errored for ${shot.id} (attempt ${attempt}/${QA_CALL_MAX_ATTEMPTS}) — retrying in ` +
          `${QA_CALL_RETRY_DELAY_MS}ms. ${lastError.message}`,
        );
        await sleep(QA_CALL_RETRY_DELAY_MS);
      }
    }
  }
  // QA must never break a render — keep the clip. But this shot's
  // consistency was NEVER ACTUALLY VERIFIED, which is a materially
  // different, more serious situation than a clean pass; unverified:true is
  // what lets the caller tell the two apart.
  console.warn(
    `   ⚠️  QA check failed for ${shot.id} after ${QA_CALL_MAX_ATTEMPTS} attempts — shot is UNVERIFIED, ` +
    `not confirmed passing. Keeping the clip. ${lastError?.message}`,
  );
  await logQaEvent(shot.id, "clip", "unverified");
  return { pass: true, result: null, unverified: true };
}

/**
 * PRIORITY 2 — PRE-VIDEO-GENERATION KEYFRAME VALIDATION FILTER.
 *
 * Currently: breakdown -> keyframe image -> paid video generation -> QA on
 * the finished video -> retry-if-failed. Every defect (extra_people,
 * identity_swap, background_identity_bleed, environment_changed — anything
 * runQA() already knows how to find) was previously only ever caught AFTER
 * the expensive video-generation step had already been paid for, even
 * though every one of those findings is fully judgeable from the STATIC
 * KEYFRAME alone — the video model doesn't fix a wrong headcount, it just
 * animates whatever the keyframe already got wrong.
 *
 * REUSES existing infrastructure, does not invent new detection logic:
 * runQA() (qa.ts) already accepts an empty frameUrls array — it was built
 * to judge findings against `keyframeUrl` alone when no video frames are
 * given (see its own `imageUrls` construction, keyframeUrl is independent
 * of frameUrls). This function is a THIN wrapper applying that SAME call at
 * the pre-generation stage, with the identical QA_CALL_MAX_ATTEMPTS
 * retry-then-unverified reliability treatment inspectClip()/checkIdentity()
 * above already use — never a second, drifting copy of that logic.
 *
 * Deliberately does NOT decide retry-the-KEYFRAME-GENERATION policy itself
 * (that's the caller's job, 4-images.ts — this function only judges ONE
 * keyframe and reports what it found, the same separation of concerns
 * inspectClip() already has from 5-videos.ts's own retry loop).
 */
export async function checkKeyframe(
  shot: Shot,
  keyframeUrl: string,
  characterRefs?: { name: string; url: string }[],
  propRefs?: { name: string; url: string }[],
  locationRef?: { name: string; url: string },
): Promise<QACheck> {
  if (!QA_ENABLED) return { pass: true, result: null };
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= QA_CALL_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runQA({ vision, frameUrls: [], shot, keyframeUrl, characterRefs, propRefs, locationRef });
      const pass = !shouldRegenerate(result, QA_SEVERITY);
      await logQaEvent(shot.id, "keyframe", pass ? "pass" : "fail", pass ? [] : result.findings.map((f) => f.kind));
      return { pass, result };
    } catch (e) {
      lastError = e as Error;
      if (attempt < QA_CALL_MAX_ATTEMPTS) {
        console.warn(
          `   ⚠️  keyframe check errored for ${shot.id} (attempt ${attempt}/${QA_CALL_MAX_ATTEMPTS}) — retrying in ` +
          `${QA_CALL_RETRY_DELAY_MS}ms. ${lastError.message}`,
        );
        await sleep(QA_CALL_RETRY_DELAY_MS);
      }
    }
  }
  console.warn(
    `   ⚠️  keyframe check failed for ${shot.id} after ${QA_CALL_MAX_ATTEMPTS} attempts — UNVERIFIED, not ` +
    `confirmed passing. ${lastError?.message}`,
  );
  await logQaEvent(shot.id, "keyframe", "unverified");
  return { pass: true, result: null, unverified: true };
}

/**
 * Whole-film identity audit: compare a shot's KEYFRAME directly against a
 * character's ORIGINAL reference sheet — see checkIdentityConsistency() in
 * qa.ts for why this is a different (and necessary) check than inspectClip()
 * above. Same safe-by-default shape: disabled ⇒ always "pass", any error in
 * the check itself ⇒ "pass" (never block a render over the audit failing) —
 * but see `unverified` below: the SAME retry-then-distinguish reliability
 * fix as inspectClip() above, for the identical reason (this call shares the
 * exact fail-open fragility, just for the keyframe-level check instead of
 * the video-level one).
 */
export async function checkIdentity(
  characterName: string,
  referenceUrls: string[],
  newImageUrl: string,
): Promise<{ pass: boolean; detail: string; unverified?: boolean }> {
  if (!QA_ENABLED) return { pass: true, detail: "" };
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= QA_CALL_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await checkIdentityConsistency({ vision, referenceUrls, newImageUrl, characterName });
      await logQaEvent(characterName, "identity", result.pass ? "pass" : "fail");
      return result;
    } catch (e) {
      lastError = e as Error;
      if (attempt < QA_CALL_MAX_ATTEMPTS) {
        console.warn(
          `   ⚠️  identity check errored for ${characterName} (attempt ${attempt}/${QA_CALL_MAX_ATTEMPTS}) — ` +
          `retrying in ${QA_CALL_RETRY_DELAY_MS}ms. ${lastError.message}`,
        );
        await sleep(QA_CALL_RETRY_DELAY_MS);
      }
    }
  }
  console.warn(
    `   ⚠️  identity check failed for ${characterName} after ${QA_CALL_MAX_ATTEMPTS} attempts — UNVERIFIED, ` +
    `not confirmed passing. Keeping the image. ${lastError?.message}`,
  );
  await logQaEvent(characterName, "identity", "unverified");
  return { pass: true, detail: "", unverified: true };
}

export const qaConfig = {
  enabled: QA_ENABLED,
  maxRetries: QA_MAX_RETRIES,
  criticalMaxRetries: QA_CRITICAL_MAX_RETRIES,
  severity: QA_SEVERITY,
};