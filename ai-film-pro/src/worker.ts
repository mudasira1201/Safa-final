// ==========================================================
// PUT THIS FILE AT:  ai-film-pro/src/worker.ts
// (rename to: worker.ts)
// ==========================================================
import "dotenv/config";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { prisma } from "./db";
import { config, runtime, applyProjectSettings, setJobOutDir } from "./config";
import { uploadFile } from "./storage";
import { makePoster, readJsonOr, writeJson, fileExists, downloadToFile } from "./util";
import { reportJobError } from "./sentry";
import { checkCaps, logSpend, costOfClip, costOfImages, costOfUpscale, BudgetCapExceededError } from "./spend";
import { qaConfig } from "./providers/qa-runtime";
import { runBreakdown, parseTargetSeconds } from "./steps/1-breakdown";
import { runAd, parseCameraStyle, parseSpokesperson } from "./steps/1c-ad-breakdown";
import { runSong } from "./steps/0-song";
import { runSongBreakdown } from "./steps/1b-song-breakdown";
import { runOptions } from "./steps/2-options";
import { runLocationOptions } from "./steps/2b-location-options";
import { runSheet } from "./steps/3-sheet";
import { runPropSheet } from "./steps/3b-props";
import { runLocationSheet } from "./steps/3c-locations";
import { runImages, type ShotImages } from "./steps/4-images";
import { runVideos } from "./steps/5-videos";
import { runAssemble } from "./steps/6-assemble";
import { regenerateShot, generateInsertedShot } from "./providers/llm";
import { compileBreakdown, printIssues, blockingErrors, stripBodyMechanics } from "./lib/compiler";
import { ContentRefusedError } from "./lib/refusal";
import { JobCancelledError } from "./lib/cancel";
import { buildFingerprints, fetchPreviousFingerprints } from "./lib/fingerprint";
import { logOpsFinding } from "./lib/opsAlert";
import type { Breakdown } from "./types";

const rmrf = (p: string) => fs.rm(p, { recursive: true, force: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setJob = (id: string, data: Record<string, unknown>) => prisma.job.update({ where: { id }, data });

// flagged/flagReason are optional so older projects' stored clipsJson (from
// before this field existed) still parses fine — undefined just reads as "not flagged".
type Clip = { id: string; url: string; label: string; flagged?: boolean; flagReason?: string };
// Same shape as Clip, one stage earlier — see keyframes_review's own comment
// on renderKeyframesPass() below for why this exists as a separate type
// rather than reusing Clip (a keyframe is a still image, not a video, and
// its flagged/flagReason only ever come from identity-flags.json, never
// qa-flags.json, since clips haven't rendered yet at this stage).
type Keyframe = { id: string; url: string; label: string; flagged?: boolean; flagReason?: string };

// CONFIRMED REAL GAP, FIXED: this used to be its own local fetch() with no
// timeout — a genuinely SEPARATE, unfixed duplicate of util.ts's own
// downloadToFile(), which already got this exact fix once (see that
// function's own comment: "a render sat on 'Building Commander Thane's
// reference sheet' for 10+ minutes with zero CPU activity"). That earlier
// fix only ever protected callers that happened to use downloadToFile()
// directly — every one of THIS function's 9 call sites (including inside
// restoreCachedArtifacts() itself) kept the identical indefinite-hang risk
// the whole time. Reproduced live again: handleRegenClip()'s silent
// "restore every OTHER clip" loop hung forever with zero output, zero
// error, zero retry, attempts stuck at 0. Deleted the duplicate entirely
// instead of re-patching it locally, so this class of bug can't diverge a
// third time — every call site below now uses the one, already-proven fix.
const download = downloadToFile;

// ONE retry after a brief pause, same mitigation already used for the DB
// side (db.ts's $use middleware) and the transaction side (prisma.ts's
// withTransactionRetry) — a transient R2 hiccup on a single cached-restore
// download shouldn't force a whole shot to render fresh (real provider
// cost) when the file is right there and a second attempt would succeed.
// See restoreCachedArtifacts()'s own call sites for the confirmed live
// failure this fixes. Two failures in a row is treated as a real problem
// with that specific file, not a blip — caller still handles/logs it.
async function downloadCachedWithRetry(url: string, dest: string): Promise<string> {
  try {
    return await download(url, dest);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return await download(url, dest);
  }
}

const clipFile = (b: Breakdown, id: string) => {
  const i = b.shots.findIndex((s) => s.id === id);
  return `${String((i < 0 ? 0 : i) + 1).padStart(2, "0")}-${id}.mp4`;
};
// Compose any change-notes (per-shot notes[] and film-wide globalNotes[]) into the shot text.
// The stored breakdown stays pristine and reversible; only this render-time copy carries the edits.
function composeBreakdown(bd: any): any {
  if (!bd || !Array.isArray(bd.shots)) return bd;
  const globalNotes: string[] = Array.isArray(bd.globalNotes) ? bd.globalNotes : [];
  const shots = bd.shots.map((s: any) => {
    const notes: string[] = Array.isArray(s.notes) ? s.notes : [];
    const all = [...notes, ...globalNotes].filter(Boolean);
    if (all.length === 0) return s;
    const joined = all.join("; ");
    return { ...s, description: `${s.description || ""}. REQUESTED CHANGES: ${joined}.`, setting: `${s.setting || ""}. ${joined}` };
  });
  return { ...bd, shots };
}
// AD ANIMATION GUARANTEE — every ad shot renders with visible, continuous
// motion. breakdownAd()'s prompt now asks the director for animated shots,
// but ads planned BEFORE that instruction existed (and any shot where the
// director under-delivered) would still render as near-static frames. Same
// render-time-copy discipline as composeBreakdown() just above: the stored
// breakdown stays pristine; only the copy written for this render carries
// the appended animation text. Idempotent via the exact-sentence check.
const AD_MOTION_TEXT =
  "The scene stays alive with continuous, visible animation throughout: soft drifting haze, fine floating " +
  "particles catching the light, and a slow, smooth camera drift — never a frozen, static frame.";
function animateAdShots(bd: any): any {
  if (!bd || !Array.isArray(bd.shots)) return bd;
  const shots = bd.shots.map((s: any) =>
    String(s.motion || "").includes(AD_MOTION_TEXT) ? s : { ...s, motion: `${s.motion ? `${s.motion} ` : ""}${AD_MOTION_TEXT}` },
  );
  return { ...bd, shots };
}
// AD FACELESS-SHOT BODY-MECHANICS STRIP (ad mode only) — the render-time half
// of compileBreakdown()'s ACTION LIBRARY INJECTION gate; see that rule's
// comment for the full failure it exists for. The compile-time gate cleans the
// STORED breakdown, but handleRegenClip() NEVER recompiles — it appends a note
// and goes straight to writeBreakdown(). So for an ad already in the database
// carrying an injection from before the gate existed, this render-time copy is
// the only place the strip can happen. Without it, "Regenerate clip" rebuilds
// the identical hands-in-a-faceless-ad prompt every single time, which is
// exactly why three regenerations in a row all came back with hands.
function stripFacelessBodyMechanics(bd: any): any {
  if (!bd || !Array.isArray(bd.shots)) return bd;
  const shots = bd.shots.map((s: any) => {
    if ((s.characters?.length ?? 0) !== 0 || !s.motion) return s;
    const cleaned = stripBodyMechanics(String(s.motion));
    return cleaned === s.motion ? s : { ...s, motion: cleaned };
  });
  return { ...bd, shots };
}
async function writeBreakdown(project: any) {
  await fs.mkdir(runtime.outDir, { recursive: true });
  let bd = composeBreakdown(project.breakdownJson);
  // Strip BEFORE animateAdShots(): the strip removes only exact ACTION_LIBRARY
  // descriptions, and running it first keeps it operating on shot text that is
  // still purely compile-time output, with no render-time additions mixed in.
  if (project.type === "ad") bd = animateAdShots(stripFacelessBodyMechanics(bd));
  await fs.writeFile(`${runtime.outDir}/breakdown.json`, JSON.stringify(bd), "utf8");
}
async function writeSelections(project: any) {
  const options = project.optionsJson as Record<string, { name: string; options: string[] }>;
  const selection = (project.selectionJson || {}) as Record<string, number>;
  const selections: Record<string, unknown> = {};
  for (const [cid, info] of Object.entries(options)) {
    selections[cid] = { name: info.name, chosen: (selection[cid] ?? 0) + 1, options: info.options };
  }
  await fs.writeFile(`${runtime.outDir}/selections.json`, JSON.stringify(selections), "utf8");
}
// Same shape/reasoning as writeSelections() above, for locations. Guards
// with `|| {}` on BOTH fields (writeSelections doesn't need to for
// optionsJson, since that field predates this feature and every project has
// it) — a project that went through handleOptions before locationOptionsJson
// existed has it as null, and this must not crash resuming that project.
async function writeLocationSelections(project: any) {
  const options = (project.locationOptionsJson || {}) as Record<string, { name: string; options: string[] }>;
  const selection = (project.locationSelectionJson || {}) as Record<string, number>;
  const selections: Record<string, unknown> = {};
  for (const [lid, info] of Object.entries(options)) {
    selections[lid] = { name: info.name, chosen: (selection[lid] ?? 0) + 1, options: info.options };
  }
  await fs.writeFile(`${runtime.outDir}/location-selections.json`, JSON.stringify(selections), "utf8");
}
async function storeDir(projectId: string, dir: string, kind: string, exts: string[]) {
  try {
    const files = (await fs.readdir(dir)).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e))).sort();
    for (const f of files) {
      try {
        const url = await uploadFile(path.join(dir, f), `projects/${projectId}/${kind}/${f}`);
        await prisma.artifact.create({ data: { projectId, kind, url } });
      } catch (e) { console.error(`artifact upload failed (${f}):`, (e as Error)?.message); }
    }
  } catch { /* dir may not exist */ }
}

// Backs the Stop button (safa-web's POST /api/projects/[id]/cancel sets this
// flag on the currently running job). Polled from inside the keyframe/clip
// render loops themselves (4-images.ts, 5-videos.ts) — a plain findUnique is
// cheap next to a multi-second image/video generation call, so checking it
// once per shot is not worth caching or batching.
async function isCancelled(jobId: string): Promise<boolean> {
  const j = await prisma.job.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
  return !!j?.cancelRequested;
}

// ---- PHASE: breakdown (script -> shots), stop for review ----
async function handleBreakdown(project: any, job: any) {
  await setJob(job.id, { status: "running", stage: "Reading the script", progress: 35 });
  await rmrf(runtime.outDir);
  // Pass the script straight through instead of writing it to config.scriptPath
  // first: that's ONE hardcoded, shared file (never namespaced per job, unlike
  // runtime.outDir) — two workers each handling a breakdown job at the same
  // moment would silently build shot breakdowns from whichever project's
  // script landed there last, with no error at all. See runBreakdown()'s own
  // comment for the full reasoning.
  // AD MODE — Project.type "ad" (see 1c-ad-breakdown.ts's own comment): a
  // short creative prompt, never a narrative script, planned by a dedicated
  // ad-director step instead of runBreakdown(). Same job type/status flow
  // otherwise — no new job type, no new dispatch entry needed.
  const breakdown = project.type === "ad"
    ? await runAd(
        String(project.script || "")
          .replace(/\[Target length:[^\]]*\]\n?/i, "")
          .replace(/\[Camera style:[^\]]*\]\n?/i, "")
          .replace(/\[Spokesperson:[^\]]*\]\n?/i, "")
          .trim(),
        project.productImages?.[0],
        parseTargetSeconds(project.script) ?? 20,
        // A person appears ONLY if the user asked for one — see
        // parseSpokesperson()'s own comment for why this is no longer
        // derived from characterImages.length. An uploaded character photo
        // still implies yes (CreateFlow sends the combined value), and is
        // kept as a fallback here for ads created before the toggle existed.
        parseSpokesperson(project.script) || !!project.characterImages?.length,
        parseCameraStyle(project.script),
      )
    : await runBreakdown(project.script);
  const title = breakdown.title?.trim()?.slice(0, 80);
  await prisma.project.update({
    where: { id: project.id },
    // error: null -- clears any stale error from a past failure now that this
    // phase succeeded. project.error is otherwise never reset, so without
    // this an old, already-resolved failure message would keep reappearing
    // in the UI forever (see the same reset on every other success path below).
    data: { breakdownJson: breakdown as any, status: "breakdown_review", error: null, ...(title ? { title } : {}) },
  });
  await setJob(job.id, { status: "done", stage: "Breakdown ready", progress: 100 });
}

// ---- PHASE: AI SONG VIDEOS — theme prompt -> lyrics + real sung song ----
// `project.script` is reused as the theme/mood prompt for type "song_video"
// projects, the same way "ad mode" is carried implicitly rather than via a
// dedicated column (see Project.type's own schema comment). `songJson`
// migrated onto the live shared DB + both schema.prisma files, 2026-08-05.
async function handleSong(project: any, job: any) {
  const cap = await checkCaps(project.userId);
  if (!cap.ok) throw new BudgetCapExceededError(cap.reason);

  await setJob(job.id, { status: "running", stage: "Writing lyrics", progress: 30 });
  await rmrf(runtime.outDir);

  const theme = String(project.script || "").trim();
  const targetLengthSec = Number((job.payload as any)?.targetLengthSec) || 90;
  if (!theme) throw new Error("No theme/mood prompt to write a song from.");

  await setJob(job.id, { stage: "Writing lyrics", progress: 35 });
  const data = await runSong(theme, targetLengthSec);
  await setJob(job.id, { stage: "Rendering the song", progress: 70 });

  const songUrl = await uploadFile(`${runtime.outDir}/song.mp3`, `projects/${project.id}/song.mp3`);
  await prisma.artifact.create({ data: { projectId: project.id, kind: "song_audio", url: songUrl } }).catch(() => {});

  const title = data.lyrics.title?.trim()?.slice(0, 80);
  await prisma.project.update({
    where: { id: project.id },
    data: {
      songJson: { lyrics: data.lyrics, song: { ...data.song, url: songUrl } },
      status: "song_review",
      error: null,
      ...(title ? { title } : {}),
    },
  });
  await setJob(job.id, { status: "done", stage: "Song ready", progress: 100 });
}

// ---- PHASE: AI SONG VIDEOS — song (already generated, song_review confirmed) -> shot list ----
async function handleSongBreakdown(project: any, job: any) {
  await setJob(job.id, { status: "running", stage: "Planning the visuals", progress: 40 });
  await rmrf(runtime.outDir);

  const songData = project.songJson as { lyrics: any; song: any } | null;
  if (!songData) throw new Error("No song data to plan a shot list from — run the song step first.");
  await writeJson(`${runtime.outDir}/song.json`, songData);

  const visualTheme = String((job.payload as any)?.visualTheme || "").trim();
  const performerAppearance = String((job.payload as any)?.performerAppearance || "").trim() || undefined;
  if (!visualTheme) throw new Error("No visual theme to plan shots from.");

  const breakdown = await runSongBreakdown(visualTheme, performerAppearance);
  const title = breakdown.title?.trim()?.slice(0, 80);
  await prisma.project.update({
    where: { id: project.id },
    data: { breakdownJson: breakdown as any, status: "breakdown_review", error: null, ...(title ? { title } : {}) },
  });
  await setJob(job.id, { status: "done", stage: "Shot list ready", progress: 100 });
}

// ---- PHASE: regenerate a single shot's text ----
async function handleRegenShot(project: any, job: any) {
  const index = Number((job.payload as any)?.index ?? -1);
  let breakdown = project.breakdownJson as Breakdown;
  if (!breakdown || index < 0 || index >= breakdown.shots.length) throw new Error("Bad shot index");
  await setJob(job.id, { status: "running", stage: "Rewriting the shot", progress: 45 });

  breakdown.shots[index] = await regenerateShot(breakdown, index);

  // Regenerate used to bypass the compiler entirely, so a user hitting "regenerate
  // this shot" could reintroduce every bug we killed: over-the-shoulder framing on a
  // solo beat, audio leaking into the visual prompt, an unsplit vault. Compile it.
  const { breakdown: fixed, issues } = compileBreakdown(breakdown, { isAd: project.type === "ad" });
  printIssues(issues);
  breakdown = fixed;

  await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: breakdown as any, status: "breakdown_review", error: null } });

  // Don't throw here — the user is sitting in a review screen. Surface it instead,
  // or they'll regenerate an unrenderable vault and only find out at step 5, after
  // they've already paid for the keyframes.
  const blockers = blockingErrors(issues);
  await setJob(job.id, {
    status: "done",
    stage: blockers.length ? `Shot updated — ${blockers.length} issue(s) need attention` : "Shot updated",
    error: blockers.length ? blockers.map((b) => b.detail).join("\n") : null,
    progress: 100,
  });
}

// ---- PHASE: character options (breakdown already confirmed) ----
async function handleOptions(project: any, job: any) {
  // SPEND CAP — this phase generates real, paid character casting images
  // (runOptions(), which now logs its own spend) but never checked the
  // budget cap beforehand. Same backstop handleShots()/handleRegenClip() have.
  const optionsCap = await checkCaps(project.userId);
  if (!optionsCap.ok) throw new BudgetCapExceededError(optionsCap.reason);

  await setJob(job.id, { status: "running", stage: "Designing character looks", progress: 45 });
  // CONFIRMED REAL GAP, FIXED: this was the only handler in the shots/options
  // pipeline that never called applyProjectSettings() — harmless before now
  // (nothing this phase did depended on runtime.*), but runOptions() below
  // needs runtime.characterImages populated to know about any uploaded
  // character casting photos for this project.
  applyProjectSettings(project);
  await rmrf(runtime.outDir);

  // apply the user's requested change (if any) before generating options
  const note = String((job.payload as any)?.note || "").trim();
  if (note) {
    const bd = project.breakdownJson as Breakdown;
    // Cleans up any "REQUESTED CHANGE: ..." tail an earlier version of this
    // handler baked into stored text (that literal meta-marker reached the
    // image model verbatim — and the model ignored it — plus it leaked into
    // the option-card names shown in the UI).
    const stripLegacyMarker = (t: string) => t.replace(/\.?\s*REQUESTED CHANGE:.*$/is, "").trim();
    let changed = false;
    if (project.type === "ad") {
      // AD MODE — the regenerate note usually describes the AD'S SCENE ("a
      // background of roses and lilies"), not just the character. Character
      // appearance was the ONLY place the note ever landed, so
      // runLocationOptions() rebuilt every background from the UNCHANGED
      // shot settings — the user got visually identical backgrounds back no
      // matter what they typed. Ad mode only (a narrative film's settings
      // are authored by the script, so a casting note must not rewrite
      // them): fold the note into every shot's setting so the regenerated
      // location options — and every downstream keyframe — pick it up.
      //
      // The note lands as PLAIN SCENE TEXT, never behind a "REQUESTED
      // CHANGE:" meta-marker — the image model reads the prompt literally,
      // so instruction-shaped framing gets ignored while a direct
      // description is followed. The pristine original text is kept in
      // baseAppearance/baseSetting (extra JSON fields, spread-copied
      // through composeBreakdown()) so a second regeneration REPLACES the
      // previous note instead of stacking contradictory scenery on top.
      if (bd?.characters?.length) {
        for (const c of bd.characters as any[]) {
          c.baseAppearance = c.baseAppearance || stripLegacyMarker(String(c.appearance || ""));
          c.appearance = c.baseAppearance ? `${c.baseAppearance}. ${note}` : note;
        }
        changed = true;
      }
      if (bd?.shots?.length) {
        for (const s of bd.shots as any[]) {
          s.baseSetting = s.baseSetting ?? stripLegacyMarker(String(s.setting || ""));
          s.setting = s.baseSetting ? `${s.baseSetting}. ${note}` : note;
        }
        changed = true;
      }
    } else if (bd?.characters?.length) {
      for (const c of bd.characters) c.appearance = `${c.appearance}. REQUESTED CHANGE: ${note}`;
      changed = true;
    }
    if (changed) {
      await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: bd as any } }).catch(() => {});
    }
  }

  // UGC-STYLE SINGLE BACKDROP (ad mode only) — a product ad lives in ONE
  // location, the way a UGC creator shoots against one background.
  // breakdownAd()'s prompt now plans it that way at the source; this pass
  // covers ads planned before that instruction existed (and any compiler
  // re-split): collapse every shot onto one canonical locationId — the one
  // whose setting text is richest — so the select screen shows ONE backdrop
  // card and every downstream shot shares the same chosen background.
  if (project.type === "ad") {
    const bd = project.breakdownJson as Breakdown;
    const shots = (bd?.shots || []) as any[];
    const ids = [...new Set(shots.map((s) => s.locationId).filter(Boolean))];
    if (ids.length > 1) {
      const richest = shots.filter((s) => s.locationId).reduce((a, b) =>
        String(a.setting || "").length >= String(b.setting || "").length ? a : b);
      for (const s of shots) if (s.locationId) s.locationId = richest.locationId;
      await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: bd as any } }).catch(() => {});
    }
  }

  await writeBreakdown(project);
  const sel = await runOptions(project.id, project.userId);
  const optionsJson: Record<string, { name: string; options: string[] }> = {};
  for (const [cid, info] of Object.entries<any>(sel)) {
    const urls: string[] = [];
    for (let i = 0; i < info.options.length; i++) {
      urls.push(await uploadFile(`${runtime.outDir}/characters/options/${cid}/opt-${i + 1}.png`, `projects/${project.id}/options/${cid}/opt-${i + 1}.png`));
    }
    optionsJson[cid] = { name: info.name, options: urls };
  }

  // LOCATION CASTING — same treatment as character options just above, same
  // job (both ready together before the same awaiting_selection screen). See
  // 2b-location-options.ts's own comment for why this covers EVERY distinct
  // location, not just genuinely-revisited ones.
  await setJob(job.id, { stage: "Designing locations", progress: 50 });
  // Ad mode: hand the regenerate note to the location step as an explicit
  // must-feature requirement — see runLocationOptions()'s own comment for
  // why being folded into the setting text alone is not enough. Ads also get
  // exactly 3 backdrop options (one location, UGC style) instead of the
  // film default.
  const locSel = await runLocationOptions(
    project.id,
    project.userId,
    project.type === "ad" && note ? note : undefined,
    project.type === "ad" ? 3 : undefined,
  );
  const locationOptionsJson: Record<string, { name: string; options: string[] }> = {};
  for (const [lid, info] of Object.entries<any>(locSel)) {
    const urls: string[] = [];
    for (let i = 0; i < info.options.length; i++) {
      urls.push(await uploadFile(`${runtime.outDir}/locations/options/${lid}/opt-${i + 1}.png`, `projects/${project.id}/location-options/${lid}/opt-${i + 1}.png`));
    }
    locationOptionsJson[lid] = { name: info.name, options: urls };
  }

  await prisma.project.update({ where: { id: project.id }, data: { optionsJson, locationOptionsJson, status: "awaiting_selection", error: null } });
  await setJob(job.id, { status: "done", stage: "Awaiting selection", progress: 100 });
}

/**
 * Re-download every keyframe and clip this project has already generated, so a
 * retry (or a resumed job) reuses them instead of re-paying fal for identical
 * output. This is the single biggest cost saver in the pipeline: a failed render
 * that gets retried used to cost full price twice.
 */
async function restoreCachedArtifacts(
  project: any,
  breakdown: Breakdown | null,
  prevFingerprints: Record<string, string>,
  currentFingerprints: Record<string, string>,
  // Used by handleDeleteShot/handleInsertShot (below): shotFingerprint() has
  // no positional/neighbor component (see fingerprint.ts), so a shot whose
  // own text is untouched but whose PREDECESSOR just changed (a neighbor was
  // deleted, or a new shot was inserted before it) still fingerprints
  // identically and would otherwise be silently restored here with its old,
  // now-wrongly-chained opening frame. Force those specific shot ids to miss
  // this cache regardless of fingerprint match, so the normal cache-miss path
  // below renders them fresh, chained from whatever the sequential 4-images.ts
  // walk has already computed as their new predecessor.
  forceRegenerateIds?: Set<string>,
) {
  if (!breakdown?.shots?.length) return;
  try {
    const arts = await prisma.artifact.findMany({
      where: { projectId: project.id, kind: { in: ["image", "clip"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!arts.length) return;

    // A prior render attempt for THIS project exists only if we have a recorded
    // fingerprint for it. No history at all (a project rendered before this
    // fingerprint mechanism shipped) means we cannot tell a safe restore from a
    // stale one — so nothing restores, and the whole project renders fresh once.
    const hasHistory = Object.keys(prevFingerprints).length > 0;

    await fs.mkdir(`${runtime.outDir}/images`, { recursive: true });
    await fs.mkdir(`${runtime.outDir}/clips`, { recursive: true });

    // CONFIRMED REAL BUG, FIXED: handleDeleteShot/handleInsertShot run the
    // keyframes pass and clips pass back-to-back in ONE job, sharing one
    // outDir — so by the time this second call runs (from renderClipsPass),
    // images.json already exists and is COMPLETE (4-images.ts just wrote
    // every shot, including the forced one, at the end of the keyframes
    // pass). This function only ever restores shots it's NOT forcing — a
    // forced shot (like the successor of a deleted shot) is deliberately
    // skipped in the loop below — so writing `images` as a fresh {} and
    // overwriting the file with it silently dropped the forced shot's entry
    // entirely, even though its keyframe file was sitting right there.
    // Caught live: "No keyframe for shot2b. Run step 4 first." mid-clip-
    // render, right after the keyframes pass had just logged that very shot
    // as successfully rendered. Starting from whatever's already on disk
    // (empty on a fresh outDir — the normal single-pass job case, unchanged
    // behavior) and merging restored entries into it fixes this without
    // touching the normal render_clips-as-its-own-job path at all.
    const images: Record<string, { first: string; last?: string }> = await readJsonOr(`${runtime.outDir}/images.json`, {});
    let restoredImages = 0;
    let restoredClips = 0;
    let skippedStale = 0;

    for (const s of breakdown.shots) {
      if (forceRegenerateIds?.has(s.id)) continue;
      // CONTENT/PIPELINE FINGERPRINT GATE — see src/lib/fingerprint.ts. Only trust
      // a cached artifact when this shot's content AND the current pipeline
      // version match what was on file before the last attempt for this project.
      // A changed shot, or a shipped compiler/prompt/QA/director-rules update,
      // fails this match and falls through to a real regeneration for that shot.
      const fresh = hasHistory && !!prevFingerprints[s.id] && prevFingerprints[s.id] === currentFingerprints[s.id];
      if (!fresh) {
        if (hasHistory && prevFingerprints[s.id] && prevFingerprints[s.id] !== currentFingerprints[s.id]) skippedStale++;
        continue;
      }
      // keyframe (and its end-frame, when the shot is two-endpoint)
      const first = arts.find((a) => a.url.endsWith(`/${s.id}.png`));
      if (first) {
        try {
          await downloadCachedWithRetry(first.url, `${runtime.outDir}/images/${s.id}.png`);
          images[s.id] = { first: first.url };
          restoredImages++;
          const last = arts.find((a) => a.url.endsWith(`/${s.id}-end.png`));
          if (last) {
            await downloadCachedWithRetry(last.url, `${runtime.outDir}/images/${s.id}-end.png`);
            images[s.id].last = last.url;
          }
        } catch (e) {
          // SILENT UNTIL NOW — CONFIRMED REAL, LIVE FAILURE (2026-08-13): this
          // used to be a bare `catch { delete images[s.id]; }`, with no log at
          // all. A transient R2 fetch failure on exactly ONE of 85 cached
          // keyframes (the file was confirmed reachable and correct seconds
          // later — a one-off blip, not a missing/corrupt artifact) silently
          // dropped that shot from images.json with zero trace of why. The
          // ONLY symptom ever surfaced was 5-videos.ts throwing "No keyframe
          // for shot_4a_a. Run step 4 first." deep in a LATER phase, on a
          // shot whose keyframe demonstrably existed in both the DB and R2 —
          // nothing tied that error back to a download that failed here.
          delete images[s.id];
          console.warn(`   ⚠️  restore: keyframe download failed for ${s.id}, will render fresh — ${(e as Error)?.message}`);
        }
      }
      // clip
      const clip = arts.find((a) => a.kind === "clip" && a.url.includes(`-${s.id}.mp4`));
      if (clip) {
        try {
          await downloadCachedWithRetry(clip.url, `${runtime.outDir}/clips/${clipFile(breakdown, s.id)}`);
          restoredClips++;
        } catch (e) {
          console.warn(`   ⚠️  restore: clip download failed for ${s.id}, will re-render — ${(e as Error)?.message}`);
        }
      }
    }

    if (Object.keys(images).length) {
      await fs.writeFile(`${runtime.outDir}/images.json`, JSON.stringify(images), "utf8");
    }
    if (restoredImages || restoredClips) {
      console.log(`   \u267b\ufe0f  restored from cache: ${restoredImages} keyframe(s), ${restoredClips} clip(s) — these will NOT be re-billed`);
    }
    if (skippedStale) {
      console.log(`   restored from cache, skipped ${skippedStale} stale shot(s) — content or a pipeline update changed since the last render, regenerating those for real.`);
    }
  } catch (e) {
    console.warn("   cache restore skipped:", (e as Error)?.message);
  }
}

/**
 * PASS 1 OF 2 — keyframes only, then STOP for review (keyframes_review).
 * Fingerprint, restore-what-we-already-paid-for, character sheet, keyframes,
 * flags — everything renderShotsPass() used to do up through banking the
 * keyframes, now its own pass so a job can end here instead of barreling
 * straight into clip rendering. rmrf/writeBreakdown/writeSelections stay the
 * CALLER's job (see the old renderShotsPass() comment this replaces — same
 * reasoning, handleDeleteShot/handleInsertShot still call the clips half
 * directly and need to mutate the breakdown first). `opts.forceRegenerateIds`
 * is the one hook delete/insert need: see restoreCachedArtifacts()'s own
 * comment for why. Returns Keyframe[] in shot order, for Project.keyframesJson.
 */
async function renderKeyframesPass(project: any, job: any, breakdown: Breakdown, opts?: { forceRegenerateIds?: Set<string> }): Promise<Keyframe[]> {
  // ── RENDER FINGERPRINT (see src/lib/fingerprint.ts) ───────────────────────
  // Fetch whatever fingerprint this project had BEFORE this attempt, compute
  // this attempt's fingerprint from the current breakdown, and persist it
  // immediately — before spending anything. Comparing prev vs current is what
  // lets restoreCachedArtifacts() tell "this shot is unchanged, safe to reuse"
  // apart from "this shot's content or the rendering pipeline changed since it
  // was cached, must render for real". Persisting NOW (not only on success)
  // means a crash-and-retry of this SAME attempt still matches on retry, so the
  // existing crash-recovery cost savings below are unaffected.
  const prevFingerprints = await fetchPreviousFingerprints(project.id);
  const currentFingerprints = buildFingerprints(breakdown);
  try {
    await writeJson(`${runtime.outDir}/fingerprint.json`, currentFingerprints);
    await uploadFile(`${runtime.outDir}/fingerprint.json`, `projects/${project.id}/fingerprint.json`);
  } catch (e) {
    console.warn("   fingerprint upload skipped:", (e as Error)?.message);
  }

  // ── COST FIX: RESTORE WHAT WE ALREADY PAID FOR ────────────────────────────
  // rmrf() above wipes the local cache, which is correct for a FIRST render but
  // catastrophic on a RETRY: every keyframe would be regenerated and re-billed
  // even though identical files are already sitting in storage. So before we
  // spend anything, pull back every artifact this project already has — but
  // ONLY for a shot whose fingerprint still matches (see above). runImages()
  // caches on file existence, so a restored shot costs ZERO.
  await restoreCachedArtifacts(project, breakdown, prevFingerprints, currentFingerprints, opts?.forceRegenerateIds);

  // SPEND CAP: image-only estimate — this pass never touches clip generation.
  // See checkCaps()'s own comment for why the forecast (not just past spend)
  // is folded in here, before a single call is made.
  const estimatedImagesUsd = costOfImages(breakdown.shots.length);
  const cap = await checkCaps(project.userId, estimatedImagesUsd);
  if (!cap.ok) throw new BudgetCapExceededError(cap.reason);

  await runSheet(project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 55 }).catch(() => {});
  });
  await runPropSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 55 }).catch(() => {});
  });
  await runLocationSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 55 }).catch(() => {});
  });
  await setJob(job.id, { stage: "Painting the shots", progress: 55 });
  // BANK WHATEVER'S ON DISK NO MATTER HOW THIS EXITS — moved from "only after
  // a full, successful runImages() return" into a finally. CONFIRMED REAL GAP,
  // FIXED: storeDir() only ran on success before, so a mid-loop throw
  // (ContentRefusedError, a crash, and now JobCancelledError from the Stop
  // button) discarded every keyframe rendered so far THIS attempt — the files
  // sat locally, wiped by the next attempt's rmrf(), never banked to
  // Artifact/R2 at all. storeDir() just uploads whatever .png files exist in
  // outDir/images regardless of how far the loop got, so this is safe to run
  // unconditionally; it's a no-op past whatever restoreCachedArtifacts()
  // already restored from a prior attempt.
  let images: ShotImages;
  try {
    images = await runImages((d, t) => {
      const pct = 55 + Math.round((d / t) * 40); // 55 -> 95 across keyframes (this job ends here, not at 100)
      setJob(job.id, { stage: `Painting shot ${d} of ${t}`, progress: pct }).catch(() => {});
    }, () => isCancelled(job.id));
  } finally {
    await storeDir(project.id, `${runtime.outDir}/images`, "image", [".png", ".jpg", ".jpeg"]).catch(() => {});
  }
  // EXACT IMAGE COST — 4-images.ts counts every REAL renderKeyframe() call
  // individually, instead of assuming one image per shot. That flat
  // assumption undercounted any shot needing more than one real generation: a
  // two-endpoint (flf) shot's end frame, a content-refusal's softened retry,
  // or an identity-correction retry — each a real, separately-billed fal
  // call. A cache hit contributes zero (no new call was made).
  const { nanoBananaImageCalls } = await readJsonOr(`${runtime.outDir}/image-shots.json`, { nanoBananaImageCalls: 0 });
  const imageCostUsd = costOfImages(nanoBananaImageCalls);
  await logSpend("image", { userId: project.userId, projectId: project.id, units: nanoBananaImageCalls, amountUsd: imageCostUsd });

  // FLAGGED KEYFRAMES — one stage earlier than the flagged-clips block
  // renderClipsPass() below still does. 4-images.ts writes every shot it had
  // to flag (identity drift that survived a retry, composition QA that
  // survived its retry budget) to identity-flags.json. No qa-flags.json yet
  // at this point — that only exists after 5-videos.ts runs, which hasn't
  // happened. This is the SAME identityFlags data renderClipsPass() will
  // later read back out of Project.keyframesJson (see its own comment) to
  // carry these reasons forward onto the eventual clip.
  const identityFlags = await readJsonOr<Record<string, string[]>>(`${runtime.outDir}/identity-flags.json`, {});
  const keyframes: Keyframe[] = breakdown.shots
    .filter((s) => images[s.id]?.first)
    .map((s) => ({
      id: s.id,
      url: images[s.id].first,
      label: s.description?.slice(0, 70) || s.id,
      ...(identityFlags[s.id]?.length ? { flagged: true, flagReason: identityFlags[s.id].join("; ") } : {}),
    }));
  if (Object.keys(identityFlags).length) {
    console.log(`   🚩 ${Object.keys(identityFlags).length} of ${keyframes.length} keyframe(s) flagged for review in the keyframes_review screen.`);
  }
  return keyframes;
}

/**
 * PASS 2 OF 2 — clips only, keyframes already approved in keyframes_review.
 * A SEPARATE job from renderKeyframesPass() (fresh outDir), so it re-runs its
 * own fingerprint + restoreCachedArtifacts() to pull the approved keyframes
 * (and any already-rendered clips, on a retry) back from storage before
 * filming. runSheet()/runPropSheet() are cheap, near-instant cache hits here
 * (already generated during the keyframes pass) — runVideos() itself reads
 * characters.json/props.json for its own clip-level identity QA (5-videos.ts),
 * so they can't simply be skipped. `priorKeyframeFlags` carries forward the
 * flagged/flagReason recorded in Project.keyframesJson (this job's own outDir
 * has no identity-flags.json — that lived only in the keyframes job's now-
 * deleted scratch dir) so a clip made from a flagged keyframe still shows the
 * SAME flag it did in keyframes_review, merged with any fresh clip-side QA
 * flags from THIS pass.
 */
async function renderClipsPass(project: any, job: any, breakdown: Breakdown, opts?: { forceRegenerateIds?: Set<string> }): Promise<Clip[]> {
  const options = project.optionsJson as Record<string, { name: string; options: string[] }>;
  const selection = (project.selectionJson || {}) as Record<string, number>;
  // `|| {}` (unlike optionsJson/selectionJson above): a project that went
  // through options before this feature existed has these as null.
  const locationOptions = (project.locationOptionsJson || {}) as Record<string, { name: string; options: string[] }>;
  const locationSelection = (project.locationSelectionJson || {}) as Record<string, number>;

  const prevFingerprints = await fetchPreviousFingerprints(project.id);
  const currentFingerprints = buildFingerprints(breakdown);
  try {
    await writeJson(`${runtime.outDir}/fingerprint.json`, currentFingerprints);
    await uploadFile(`${runtime.outDir}/fingerprint.json`, `projects/${project.id}/fingerprint.json`);
  } catch (e) {
    console.warn("   fingerprint upload skipped:", (e as Error)?.message);
  }
  await restoreCachedArtifacts(project, breakdown, prevFingerprints, currentFingerprints, opts?.forceRegenerateIds);

  // SPEND CAP: clip-only estimate — the keyframes were already checked (and
  // paid for) by renderKeyframesPass() in the earlier job.
  const avgShotSecondsEstimate = breakdown.shots.length
    ? breakdown.shots.reduce((n, s) => n + (s.duration || config.shotDuration), 0) / breakdown.shots.length
    : config.shotDuration;
  const estimatedClipsUsd = costOfClip(breakdown.shots.length * avgShotSecondsEstimate);
  const cap = await checkCaps(project.userId, estimatedClipsUsd);
  if (!cap.ok) throw new BudgetCapExceededError(cap.reason);

  await runSheet(project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 70 }).catch(() => {});
  });
  await runPropSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 70 }).catch(() => {});
  });
  await runLocationSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 70 }).catch(() => {});
  });

  await setJob(job.id, { stage: "Filming the clips", progress: 70 });

  // PER-RENDER SAFETY CEILING — separate from, and much tighter than, checkCaps()'s
  // global DAILY_SPEND_CAP_USD/USER_MONTHLY_CAP_USD (both far above what any single
  // render should reasonably cost). Confirmed real failure: a 3-shot script silently
  // became a 9-shot breakdown (see 1-breakdown.ts's shot-count guard, added the same
  // day this was) and burned $50 in real fal.ai charges — the global caps never came
  // close to tripping, because $50 is nowhere near $500/day or $5000/month.
  //
  // THE MULTIPLIER IS DERIVED FROM THE ACTUAL RETRY BUDGET, NOT AN ARBITRARY ROUND
  // NUMBER: qaConfig.criticalMaxRetries re-rolls are a real, BY-DESIGN cost every
  // shot is allowed to incur if it keeps failing critical QA (identity_drift,
  // treadmill, unnatural_motion, flat_performance, extra_people, duplicated_object,
  // blurry_or_soft_focus are all critical as of this session) — so "every shot in
  // this breakdown maxes its critical retry budget" is the real worst-case a
  // CORRECTLY-SIZED render can legitimately reach, not a bug. This ceiling protects
  // against exceeding THAT worst case (a pathological retry storm, a pricing
  // surprise) — it does not, by itself, cap a render at some small dollar figure,
  // because a large or genuinely troublesome film can legitimately cost more. The
  // shot-count guard in 1-breakdown.ts is the fix for THIS specific incident's root
  // cause (an inflated shot count); this is the backstop for a different failure mode.
  const avgShotSeconds = avgShotSecondsEstimate;
  const worstCaseRetryMultiplier = 1 + qaConfig.criticalMaxRetries; // 1 base attempt + every shot maxing its critical retry budget
  // UPSCALE COST — see runtime.generationResolution's own comment in
  // config.ts. When this project delivers at 720p/1080p, EVERY accepted shot
  // (not every retry attempt — 5-videos.ts only upscales the final accepted
  // clip once) pays a real Topaz cost on top of generation. Left out of this
  // ceiling before upscaling existed would mean a legitimately-priced
  // 1080p render could trip its OWN safety ceiling purely because the
  // ceiling never budgeted for a real cost this render is supposed to incur.
  const upscaleCeilingUsd =
    config.upscaleEnabled && runtime.resolution !== runtime.generationResolution
      ? costOfUpscale(breakdown.shots.length * avgShotSeconds, runtime.resolution)
      : 0;
  const perRenderCeilingUsd =
    costOfImages(breakdown.shots.length) + costOfClip(breakdown.shots.length * avgShotSeconds) * worstCaseRetryMultiplier + upscaleCeilingUsd;
  let clipSpendSoFarUsd = 0;

  // BANK EACH CLIP AS IT FINISHES, NOT AFTER THE WHOLE BATCH.
  // This used to all happen in one loop AFTER runVideos() returned, which meant a
  // crash partway through an 18-clip render (a dropped DB connection, a killed
  // process) lost every clip rendered so far: rmrf(runtime.outDir) on the next retry
  // wipes the local files, and restoreCachedArtifacts() can only restore a clip that
  // was already uploaded. Keyframes already got this treatment (see the comment
  // above storeDir() for images); clips did not. uploadedByShot fills in as clips
  // complete, in whatever order concurrency produces them.
  //
  // COST IS ALSO LOGGED HERE, IMMEDIATELY, PER CLIP — not batched into one
  // logSpend() call after runVideos() returns. Confirmed real failure: a job stuck
  // mid-render for over an hour had spent real money that never appeared in our own
  // Spend table at all, because the old code only ever logged cost once the ENTIRE
  // step finished. That also meant checkCaps()-style protection had no way to see
  // this render's own spend climbing — see perRenderCeilingUsd above, enforced here.
  const uploadedByShot: Record<string, string> = {};
  const clipPaths = await runVideos(
    async (d, t) => {
      const pct = 70 + Math.round((d / t) * 25); // 70 -> 95 across clips
      await setJob(job.id, { stage: `Filming clip ${d} of ${t}`, progress: pct }).catch(() => {});
    },
    async (shot, localPath, costUsd) => {
      const file = path.basename(localPath);
      const url = await uploadFile(localPath, `projects/${project.id}/clip/${file}`);
      const poster = await makePoster(localPath);
      if (poster) await uploadFile(poster, `projects/${project.id}/clip/${file.replace(/\.mp4$/i, ".jpg")}`).catch(() => {});
      await prisma.artifact.create({ data: { projectId: project.id, kind: "clip", url } }).catch(() => {});
      uploadedByShot[shot.id] = url;

      await logSpend("clip", { userId: project.userId, projectId: project.id, units: 1, amountUsd: costUsd });
      clipSpendSoFarUsd += costUsd;
      if (clipSpendSoFarUsd > perRenderCeilingUsd) {
        throw new BudgetCapExceededError(
          `This render's own clip spend ($${clipSpendSoFarUsd.toFixed(2)}) has exceeded its safety ceiling ` +
          `($${perRenderCeilingUsd.toFixed(2)}, 5x the estimate for ${breakdown.shots.length} shot(s)) — stopping ` +
          `before more money is spent. The clips already rendered are kept; nothing else renders this attempt.`,
        );
      }
    },
    () => isCancelled(job.id),
  );

  for (const [cid, info] of Object.entries(options)) {
    const u = info.options[selection[cid] ?? 0];
    if (u) await prisma.artifact.create({ data: { projectId: project.id, kind: "character", url: u } }).catch(() => {});
  }
  // Same treatment as the character loop just above, so the chosen location
  // look gets a first-class Artifact row too (parity with characters; gives
  // the Artifacts gallery something to show for it).
  for (const [lid, info] of Object.entries(locationOptions)) {
    const u = info.options[locationSelection[lid] ?? 0];
    if (u) await prisma.artifact.create({ data: { projectId: project.id, kind: "location", url: u } }).catch(() => {});
  }

  // FLAGGED SHOTS (#4 — long-form review at scale). 5-videos.ts writes out
  // which shots it had to flag for human review and why (QA findings that
  // survived their retry budget) — that part is fresh, this job's own
  // outDir. The keyframe-side half (identity drift that survived a retry)
  // is NOT fresh here: identity-flags.json only ever existed in the earlier
  // keyframes job's own scratch dir, already rmrf'd by the time this job
  // runs. Project.keyframesJson is where renderKeyframesPass() persisted
  // that same information durably (see its own comment) — read it back from
  // there instead, so a clip made from a keyframe flagged in keyframes_review
  // still carries that same reason forward, merged with any fresh clip-side
  // QA flags from THIS pass.
  const priorKeyframeFlags: Record<string, string> = {};
  for (const k of (project.keyframesJson || []) as Keyframe[]) {
    if (k.flagged) priorKeyframeFlags[k.id] = k.flagReason || "flagged during keyframe review";
  }
  const qaFlags = await readJsonOr<Record<string, string[]>>(`${runtime.outDir}/qa-flags.json`, {});
  const allFlagIds = new Set([...Object.keys(priorKeyframeFlags), ...Object.keys(qaFlags)]);
  const flagReasonFor = (id: string): string | undefined => {
    const reasons = [...(priorKeyframeFlags[id] ? [priorKeyframeFlags[id]] : []), ...(qaFlags[id] ?? [])];
    return reasons.length ? reasons.join("; ") : undefined;
  };

  // Build the FINAL ordered list from clipPaths (which preserves shot order regardless
  // of completion order) — but reuse the URL already banked above instead of uploading
  // again. A cache-hit clip (restored from a previous attempt, never passed through the
  // onClipDone callback this run) falls back to uploading here exactly as before.
  const clips: Clip[] = [];
  for (const p of clipPaths) {
    const file = path.basename(p);
    const id = file.replace(/^\d+-/, "").replace(/\.mp4$/, "");
    const shot = breakdown.shots.find((s) => s.id === id);
    let url = uploadedByShot[id];
    if (!url) {
      url = await uploadFile(p, `projects/${project.id}/clip/${file}`);
      const poster = await makePoster(p);
      if (poster) await uploadFile(poster, `projects/${project.id}/clip/${file.replace(/\.mp4$/i, ".jpg")}`).catch(() => {});
      await prisma.artifact.create({ data: { projectId: project.id, kind: "clip", url } }).catch(() => {});
    }
    clips.push({
      id, url, label: shot?.description?.slice(0, 70) || id,
      ...(allFlagIds.has(id) ? { flagged: true, flagReason: flagReasonFor(id) } : {}),
    });
  }
  if (allFlagIds.size) {
    console.log(`   🚩 ${allFlagIds.size} of ${clips.length} clip(s) flagged for review in the clips_review screen.`);
  }
  return clips;
}

// ---- PHASE: keyframes only (NO clips), stop for keyframe review ----
async function handleShots(project: any, job: any) {
  await setJob(job.id, { status: "running", stage: "Building the character sheet", progress: 55 });
  applyProjectSettings(project);   // resolution / orientation / audio the user paid for
  await rmrf(runtime.outDir);
  await writeBreakdown(project);
  await writeSelections(project);
  await writeLocationSelections(project);

  const breakdown = project.breakdownJson as Breakdown;
  const keyframes = await renderKeyframesPass(project, job, breakdown);

  await prisma.project.update({ where: { id: project.id }, data: { keyframesJson: keyframes as any, status: "keyframes_review", error: null } });
  await setJob(job.id, { status: "done", stage: "Keyframes ready", progress: 100 });
}

// ---- PHASE: clips (keyframes already approved in keyframes_review) -> stop for clip review ----
async function handleRenderClips(project: any, job: any) {
  await setJob(job.id, { status: "running", stage: "Preparing to film", progress: 60 });
  applyProjectSettings(project);
  await rmrf(runtime.outDir);
  await writeBreakdown(project);
  await writeSelections(project);
  await writeLocationSelections(project);

  const breakdown = project.breakdownJson as Breakdown;

  // BANK COMPLETED CLIPS EVEN IF THE PASS THROWS.
  //
  // This used to be a bare `const clips = await renderClipsPass(...)` followed by
  // the update below — so ANY throw from the pass skipped the write entirely and
  // every finished clip was discarded. CONFIRMED REAL, on an 86-shot film: the
  // terminal showed "✓ clip 86/86" yet the job died at "Filming clip 84 of 86"
  // (94%) on a content refusal, the project went to needs_edit, and clipsJson
  // held ZERO clips. Every one of 86 paid renders thrown away over one refused
  // shot — structurally the same bug as runBreakdown() discarding a whole
  // breakdown over one missing endFrame.
  //
  // renderClipsPass() already writes each clip to clips.json on disk as it goes
  // (5-videos.ts), so the finished work is recoverable — nothing here needs the
  // pass to hand it back. Reading that file in a `finally` is the same
  // "bank whatever's on disk regardless of how we exited" discipline the keyframe
  // pass already uses.
  //
  // Only ever WIDENS what is saved: on the happy path the pass's return value is
  // used exactly as before. A partial bank leaves the project in clips_review
  // with the clips that did finish, so the user can regenerate the few that
  // failed instead of re-paying for all 86.
  let clips: Clip[] | null = null;
  try {
    clips = await renderClipsPass(project, job, breakdown);
  } finally {
    if (!clips) {
      // RECOVER FROM ARTIFACT ROWS, NOT clips.json. A first version of this read
      // `${runtime.outDir}/clips.json` — which does not exist on a mid-pass
      // failure: 5-videos.ts writes that file only AFTER its mapLimit over every
      // shot resolves, so the one path that needs it never has it. Verified on
      // the real failed job: 61 rendered .mp4 files on disk, no clips.json.
      //
      // Artifact rows ARE written per clip as it uploads (see the uploadFile /
      // artifact.create pair in renderClipsPass, and onClipDone's immediate
      // banking in 5-videos.ts), so they are the durable, already-incremental
      // record of what finished. Confirmed on the same job: 84 clip artifacts
      // present while clipsJson held 0.
      const arts = await prisma.artifact
        .findMany({ where: { projectId: project.id, kind: "clip" }, select: { url: true } })
        .catch(() => [] as { url: string }[]);
      // Map each artifact URL back to its shot via the filename the upload used
      // (`NN-<shotId>.mp4`), and keep breakdown order so the film assembles
      // correctly rather than in upload-completion order.
      const byId = new Map<string, string>();
      for (const a of arts) {
        const file = a.url.split("/").pop() ?? "";
        const id = file.replace(/^\d+-/, "").replace(/\.mp4$/i, "");
        if (id) byId.set(id, a.url);
      }
      const partial: Clip[] = breakdown.shots
        .filter((s) => byId.has(s.id))
        .map((s) => ({ id: s.id, url: byId.get(s.id)!, label: s.description?.slice(0, 70) || s.id }));
      if (partial.length) {
        await prisma.project
          .update({ where: { id: project.id }, data: { clipsJson: partial as any } })
          .catch(() => {});
        console.warn(
          `   💾 recovered ${partial.length} finished clip(s) from storage before the failure — ` +
          `they are visible for review and will NOT be re-rendered or re-billed.`,
        );
      }
    }
  }

  await prisma.project.update({ where: { id: project.id }, data: { clipsJson: clips as any, status: "clips_review", error: null } });
  await setJob(job.id, { status: "done", stage: "Clips ready", progress: 100 });
}

// ---- PHASE: regenerate ONE character/prop/location reference sheet ----
// Triggered from safa-web's global Artifacts gallery (app/app/page.tsx),
// not a per-project review screen — a user browsing their generated
// character/prop/location sheets there can now ask for a fresh take on any
// ONE of them without touching the rest of the project. UNLIKE every other
// regen_* handler above, this can run against a project in ANY status
// (including "done" — the film already finished, but the user still wants
// a better location reference for next time) — see NO_PROJECT_STATUS_CHANGE
// below for why this deliberately never writes project.status at all.
async function handleRegenSheet(project: any, job: any) {
  const sheetKind = String((job.payload as any)?.sheetKind || "");
  const entityId = String((job.payload as any)?.entityId || "");
  // Only location_sheet actually reads this — see runLocationSheet()'s
  // `noteFor` param. Character sheets already have their own note-taking
  // regeneration path (CreateFlow's regenChar(), which redesigns the actual
  // casting photo via 2-options.ts) and prop sheets have no note-injection
  // path yet, so a note sent for either of those is simply ignored below,
  // never silently misapplied to the wrong step.
  const note = String((job.payload as any)?.note || "");
  const breakdown = project.breakdownJson as Breakdown;
  const VALID_KINDS = new Set(["character_sheet", "prop_sheet", "location_sheet"]);
  if (!breakdown || !VALID_KINDS.has(sheetKind) || !entityId) throw new Error("Bad sheet regeneration request");

  const regenCap = await checkCaps(project.userId);
  if (!regenCap.ok) throw new BudgetCapExceededError(regenCap.reason);

  applyProjectSettings(project);
  const label = sheetKind === "character_sheet" ? "character" : sheetKind === "prop_sheet" ? "prop" : "location";
  await setJob(job.id, { status: "running", stage: `Redesigning the ${label}`, progress: 40 });

  // DELETE the durable cache for THIS ONE entity only. runSheet()/
  // runPropSheet()/runLocationSheet() below each restore-from-cache PER
  // ENTITY (see e.g. 3b-props.ts's own "cachedForProp" filter,
  // `a.url.includes('/prop-sheet/${prop.id}/')`) — deleting just this
  // entity's rows is what forces a real regeneration for it while every
  // OTHER character/prop/location in the same project still restores
  // instantly from cache, completely unaffected. Same URL-path convention
  // all three steps already use: projects/{projectId}/{kind}/{entityId}/angle-N.png.
  const urlFragment = `/${sheetKind.replace(/_/g, "-")}/${entityId}/`;
  await prisma.artifact.deleteMany({ where: { projectId: project.id, kind: sheetKind, url: { contains: urlFragment } } });

  await rmrf(runtime.outDir);
  await writeBreakdown(project);
  await writeSelections(project);
  await writeLocationSelections(project);
  let refs: Record<string, string[]>;
  if (sheetKind === "character_sheet") {
    refs = await runSheet(project.id, project.userId, (l) => { setJob(job.id, { stage: l, progress: 40 }).catch(() => {}); });
  } else if (sheetKind === "prop_sheet") {
    refs = await runPropSheet(breakdown, project.id, project.userId, (l) => { setJob(job.id, { stage: l, progress: 40 }).catch(() => {}); });
  } else {
    refs = await runLocationSheet(
      breakdown, project.id, project.userId,
      (l) => { setJob(job.id, { stage: l, progress: 40 }).catch(() => {}); },
      note ? { locationId: entityId, note } : undefined,
    );
  }

  // CONFIRMED REAL GAP, FIXED: nothing previously checked that a sheet for
  // THIS entityId actually came back. The gallery only ever offers regen on
  // an entity that already has a banked sheet, but the underlying breakdown
  // can drift after that (a character/prop dropped by an edit, or a location
  // that's no longer genuinely revisited once enough shots were deleted) —
  // in every one of those cases the run*Sheet() call above silently produces
  // nothing for this id, and this job would otherwise report "done" with no
  // new sheet ever generated. Throwing here routes it through the normal
  // retry/permanent-failure path instead of a false success.
  if (!refs[entityId]?.length) {
    throw new Error(`No ${label} with id "${entityId}" found to regenerate — it may have changed since this sheet was last generated.`);
  }

  // v1 SCOPE, STATED HONESTLY: character/prop sheets still only support "give
  // me a fresh take," not "change X about it" — runSheet()'s angle-1 is the
  // real chosen casting photo (regenChar() is the correct place to change a
  // character's actual appearance), and runPropSheet() has no note parameter
  // yet. Only runLocationSheet() (above) actually reads a note.
  await setJob(job.id, { status: "done", stage: `${label[0].toUpperCase()}${label.slice(1)} sheet updated`, progress: 100 });
}

// ---- PHASE: regenerate one keyframe (still in keyframes_review — no clips exist yet) ----
async function handleRegenKeyframe(project: any, job: any) {
  const targetId = String((job.payload as any)?.id || "");
  const note = String((job.payload as any)?.note || "").trim();
  const breakdown = project.breakdownJson as Breakdown;
  const keyframes = (project.keyframesJson || []) as Keyframe[];
  if (!targetId || !breakdown) throw new Error("Bad keyframe id");
  const shot = breakdown.shots.find((s) => s.id === targetId);
  if (!shot) throw new Error("Shot not found");

  // SPEND CAP — same reasoning as handleRegenClip's own check: a user already
  // over budget could otherwise keep regenerating keyframes indefinitely with
  // no backstop.
  const regenCap = await checkCaps(project.userId);
  if (!regenCap.ok) throw new BudgetCapExceededError(regenCap.reason);

  applyProjectSettings(project);
  await setJob(job.id, { status: "running", stage: note ? "Repainting with your changes" : "Repainting the keyframe", progress: 40 });

  // record the user's requested change as a SEPARATE note (keeps the original shot text pristine)
  if (note) {
    const anyShot = shot as any;
    anyShot.notes = Array.isArray(anyShot.notes) ? [...anyShot.notes, note] : [note];
    await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: breakdown as any } }).catch(() => {});
  }

  await rmrf(runtime.outDir);
  await writeBreakdown(project);
  await writeSelections(project);
  await writeLocationSelections(project);
  await runSheet(project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 40 }).catch(() => {});
  });
  await runPropSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 40 }).catch(() => {});
  });
  await runLocationSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 40 }).catch(() => {});
  });

  // restore every OTHER keyframe (cached); the target keyframe is missing -> regenerated from the new description
  //
  // CONFIRMED REAL BUG, FIXED: this wrote images.json as Record<string, string>
  // (shot id -> a bare url), but runImages()'s own cache check (4-images.ts)
  // reads images.json as Record<string, {first, last?}> and gates a cache hit
  // on `cached?.first` — a string has no `.first` property, so that was always
  // undefined/falsy for every "restored" shot here, no matter how many local
  // files were downloaded. Every regenKeyframe/regenClip request was silently
  // re-rendering ALL shots from scratch (full sequential keyframe pass, every
  // identity/composition QA vision call, every retry) instead of just the one
  // shot the user actually asked to fix — this is why a single-shot regen was
  // taking far LONGER than the original full render, not faster. Also missing:
  // the `-end.png` end-frame artifact for two-endpoint (flf) shots, so even a
  // shape fix alone would still have force-regenerated every flf shot's end
  // frame. Same restore logic as restoreCachedArtifacts() above, just scoped
  // to "every shot except targetId" instead of a fingerprint match.
  const imgs = await prisma.artifact.findMany({ where: { projectId: project.id, kind: "image" }, orderBy: { createdAt: "desc" } });
  const images: Record<string, { first: string; last?: string }> = {};
  await fs.mkdir(`${runtime.outDir}/images`, { recursive: true });
  for (const s of breakdown.shots) {
    if (s.id === targetId) continue;
    const a = imgs.find((x) => x.url.endsWith(`/${s.id}.png`));
    if (a) {
      try {
        await download(a.url, `${runtime.outDir}/images/${s.id}.png`);
        images[s.id] = { first: a.url };
        const last = imgs.find((x) => x.url.endsWith(`/${s.id}-end.png`));
        if (last) {
          await download(last.url, `${runtime.outDir}/images/${s.id}-end.png`);
          images[s.id].last = last.url;
        }
      } catch { delete images[s.id]; }
    }
  }
  await fs.writeFile(`${runtime.outDir}/images.json`, JSON.stringify(images), "utf8");
  // STOPPABLE — a single-shot regen is exactly the case that used to run for
  // 90 minutes before the cache-shape fix above; it deserves the same Stop
  // support as the main render, not just shots/render_clips. The finally
  // banks the target image the instant it's rendered (before the throw can
  // propagate), so a cancelled regen still overwrites the stored keyframe
  // with whatever partial identity-correction retry it got to, never losing
  // the render outright.
  try {
    await runImages(undefined, () => isCancelled(job.id));  // regenerates only the target keyframe
  } finally {
    await storeDir(project.id, `${runtime.outDir}/images`, "image", [".png", ".jpg", ".jpeg"]).catch(() => {});
  }

  const regenImgCounts = await readJsonOr(`${runtime.outDir}/image-shots.json`, { nanoBananaImageCalls: 0 });
  const regenImageCostUsd = costOfImages(regenImgCounts.nanoBananaImageCalls);
  if (regenImageCostUsd > 0) {
    await logSpend("image", {
      userId: project.userId, projectId: project.id,
      units: regenImgCounts.nanoBananaImageCalls,
      amountUsd: regenImageCostUsd,
    });
  }

  // OVERWRITE the target keyframe in storage AT THE SAME KEY (matches
  // handleRegenClip's own established keyframe-overwrite pattern) — this is
  // required, not just convenient: restoreCachedArtifacts()/handleRegenClip's
  // own cache lookups match an image Artifact by `.endsWith('/' + shotId +
  // '.png')`, an exact-suffix match. A cache-busting key prefix (the way
  // clips do it, via a Date.now() prefix + `.includes()` matching) would
  // silently break that lookup for every future render of this project.
  await uploadFile(`${runtime.outDir}/images/${targetId}.png`, `projects/${project.id}/image/${targetId}.png`).catch(() => {});

  // Re-check this shot's flag status against THIS run's fresh flags — same
  // reasoning as handleRegenClip's own re-check (never blindly carry the old
  // flagged/flagReason forward).
  const regenIdentityFlags = await readJsonOr<Record<string, string[]>>(`${runtime.outDir}/identity-flags.json`, {});
  const targetReasons = regenIdentityFlags[targetId] ?? [];
  // The STORAGE key stays identical (see above, required for cache matching)
  // but the DISPLAY url gets a cache-busting query param — otherwise a
  // browser that already loaded this shot's keyframe once in this review
  // session would keep showing the stale, pre-regen image after the URL
  // string comes back unchanged from the server.
  const targetArt = imgs.find((a) => a.url.endsWith(`/${targetId}.png`));
  const baseUrl = targetArt?.url ?? keyframes.find((k) => k.id === targetId)?.url ?? "";
  const displayUrl = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const updated = keyframes.map((k) =>
    k.id === targetId
      ? { ...k, url: displayUrl, flagged: targetReasons.length > 0, flagReason: targetReasons.length ? targetReasons.join("; ") : undefined }
      : k,
  );
  await prisma.project.update({ where: { id: project.id }, data: { keyframesJson: updated as any, status: "keyframes_review", error: null } });
  await setJob(job.id, { status: "done", stage: "Keyframe updated", progress: 100 });
}

// ---- PHASE: delete a shot (free — never renders anything, see below) ----
// Also how "extend a finished film" starts: the client calls the existing
// "reopen" clips action first (done -> clips_review, unchanged, already
// safe to call again per handleAssemble()'s own always-rebuild-fresh
// behavior below), then this same handler runs exactly as it would from a
// normal clips_review project.
async function handleDeleteShot(project: any, job: any) {
  const shotId = String((job.payload as any)?.shotId || "");
  let breakdown = project.breakdownJson as Breakdown;
  if (!shotId || !breakdown) throw new Error("Bad shot id");
  const index = breakdown.shots.findIndex((s) => s.id === shotId);
  if (index < 0) throw new Error("Shot not found");
  if (breakdown.shots.length <= 1) throw new Error("A film needs at least one shot");

  await setJob(job.id, { status: "running", stage: "Removing the shot", progress: 20 });

  // DELETE IS A PURE METADATA SPLICE — ZERO RENDER CALLS, ZERO CREDITS.
  //
  // This used to force-regenerate the deleted shot's SUCCESSOR: shotFingerprint()
  // has no positional component (see fingerprint.ts), so the one shot whose
  // real-world on-screen predecessor just changed would otherwise restore from
  // cache with continuity anchored to a shot that no longer exists. That
  // reasoning is sound, but the price is wrong: every single delete silently
  // re-ran the keyframe AND clip passes and charged for a fresh clip, so
  // removing an unwanted shot cost the same as generating one. Deleting is a
  // subtractive edit and the user's explicit expectation is that it deletes,
  // once, and stops.
  //
  // The tradeoff, accepted deliberately: the shot that followed the deleted one
  // keeps the clip it already had, so its opening may not flow from its new
  // predecessor as cleanly as a re-render would. That is a visible-continuity
  // cost only, never a correctness one — every remaining clip is still a real,
  // finished render of its own shot. A user who wants that seam re-filmed can
  // hit "Regenerate clip" on that one shot and pay for exactly that.
  const mutatedShots = breakdown.shots.filter((s) => s.id !== shotId);
  const { breakdown: fixed, issues } = compileBreakdown({ ...breakdown, shots: mutatedShots }, { isAd: project.type === "ad" });
  printIssues(issues);
  breakdown = fixed;
  project.breakdownJson = breakdown;

  const clips = ((project.clipsJson || []) as Clip[]).filter((c) => c.id !== shotId);
  const keyframesAfterDelete = ((project.keyframesJson || []) as Keyframe[]).filter((k) => k.id !== shotId);
  await prisma.project.update({
    where: { id: project.id },
    data: {
      breakdownJson: breakdown as any,
      clipsJson: clips as any,
      keyframesJson: keyframesAfterDelete as any,
      status: "clips_review",
      error: null,
    },
  });
  await setJob(job.id, { status: "done", stage: "Shot removed", progress: 100 });
}

// ---- PHASE: insert one new shot (paid — 1 credit, charged by clips/route.ts before this job is even queued) ----
async function handleInsertShot(project: any, job: any) {
  const afterShotId = ((job.payload as any)?.afterShotId ?? null) as string | null;
  const prompt = String((job.payload as any)?.prompt || "").trim();
  let breakdown = project.breakdownJson as Breakdown;
  if (!prompt || !breakdown) throw new Error("Bad insert request");

  await setJob(job.id, { status: "running", stage: "Writing the new shot", progress: 20 });

  const insertIndex = afterShotId ? breakdown.shots.findIndex((s) => s.id === afterShotId) + 1 : 0;
  if (afterShotId && insertIndex === 0) throw new Error("Shot to insert after not found");

  // The old occupant of insertIndex (if any) is about to get a NEW
  // predecessor (the shot we're inserting) — same forced-regen reasoning as
  // handleDeleteShot's successorId, just for the opposite mutation. The new
  // shot itself needs no forcing (fresh id, nothing cached for it exists to
  // wrongly restore) but including it is harmless and defensive.
  const oldSuccessorId = breakdown.shots[insertIndex]?.id;

  const newShot = await generateInsertedShot(breakdown, insertIndex, prompt);
  const mutatedShots = breakdown.shots.slice();
  mutatedShots.splice(insertIndex, 0, newShot);

  await setJob(job.id, { stage: "Fitting it into the shot list", progress: 30 });
  const { breakdown: fixed, issues } = compileBreakdown({ ...breakdown, shots: mutatedShots }, { isAd: project.type === "ad" });
  printIssues(issues);
  breakdown = fixed;
  project.breakdownJson = breakdown;

  await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: breakdown as any } });

  applyProjectSettings(project);
  await rmrf(runtime.outDir);
  await writeBreakdown(project);
  await writeSelections(project);
  await writeLocationSelections(project);

  const forceIds = new Set<string>([newShot.id]);
  if (oldSuccessorId) forceIds.add(oldSuccessorId);
  // Same reasoning as handleDeleteShot's own comment: this edit happens from
  // the already-approved clips_review screen, so both passes run back to back
  // in this ONE job rather than pausing at keyframes_review again.
  const rerenderedKeyframes = await renderKeyframesPass(project, job, breakdown, { forceRegenerateIds: forceIds });
  project.keyframesJson = rerenderedKeyframes as any;
  const rendered = await renderClipsPass(project, job, breakdown, { forceRegenerateIds: forceIds });

  await prisma.project.update({ where: { id: project.id }, data: { keyframesJson: rerenderedKeyframes as any, clipsJson: rendered as any, status: "clips_review", error: null } });
  await setJob(job.id, { status: "done", stage: "Shot inserted", progress: 100 });
}

// ---- PHASE: regenerate one clip (re-films from its saved keyframe) ----
async function handleRegenClip(project: any, job: any) {
  const targetId = String((job.payload as any)?.id || "");
  const note = String((job.payload as any)?.note || "").trim();
  const breakdown = project.breakdownJson as Breakdown;
  const clips = (project.clipsJson || []) as Clip[];
  if (!targetId || !breakdown) throw new Error("Bad clip id");
  const shot = breakdown.shots.find((s) => s.id === targetId);
  if (!shot) throw new Error("Shot not found");

  // SPEND CAP — this regen path never checked this before (see the cost-
  // tracking fixes below): a user already over budget could keep regenerating
  // clips indefinitely with no backstop at all. Same check handleShots() does.
  const regenCap = await checkCaps(project.userId);
  if (!regenCap.ok) throw new BudgetCapExceededError(regenCap.reason);

  // runtime is a shared singleton the worker reuses across every project's jobs —
  // without this, a regen picked up right after some OTHER project's job would
  // silently render at that other project's aspect ratio/audio/product photos.
  applyProjectSettings(project);
  await setJob(job.id, { status: "running", stage: note ? "Re-filming with your changes" : "Re-filming the clip", progress: 40 });

  // record the user's requested change as a SEPARATE note (keeps the original shot text pristine)
  if (note) {
    const anyShot = shot as any;
    anyShot.notes = Array.isArray(anyShot.notes) ? [...anyShot.notes, note] : [note];
    await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: breakdown as any } }).catch(() => {});
  }

  await rmrf(runtime.outDir);
  await writeBreakdown(project);   // writes the modified breakdown
  await writeSelections(project);
  await writeLocationSelections(project);
  // character sheet needed to re-paint the keyframe -- normally a near-instant
  // cache hit here (sheet already exists from the first render).
  await runSheet(project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 40 }).catch(() => {});
  });
  await runPropSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 40 }).catch(() => {});
  });
  await runLocationSheet(breakdown, project.id, project.userId, (label) => {
    setJob(job.id, { stage: label, progress: 40 }).catch(() => {});
  });

  // restore every OTHER keyframe (cached); the target keyframe is missing -> regenerated from the new description
  // Same shape fix as handleRegenKeyframe() above — see its comment. Was
  // Record<string, string>, which runImages()'s `cached?.first` check always
  // reads as undefined, forcing a full re-render of every shot on every
  // regenClip request instead of just the target.
  const imgs = await prisma.artifact.findMany({ where: { projectId: project.id, kind: "image" }, orderBy: { createdAt: "desc" } });
  const images: Record<string, { first: string; last?: string }> = {};
  await fs.mkdir(`${runtime.outDir}/images`, { recursive: true });
  for (const s of breakdown.shots) {
    if (s.id === targetId) continue;
    const a = imgs.find((x) => x.url.endsWith(`/${s.id}.png`));
    if (a) {
      try {
        await download(a.url, `${runtime.outDir}/images/${s.id}.png`);
        images[s.id] = { first: a.url };
        const last = imgs.find((x) => x.url.endsWith(`/${s.id}-end.png`));
        if (last) {
          await download(last.url, `${runtime.outDir}/images/${s.id}-end.png`);
          images[s.id].last = last.url;
        }
      } catch { delete images[s.id]; }
    }
  }
  await fs.writeFile(`${runtime.outDir}/images.json`, JSON.stringify(images), "utf8");
  // STOPPABLE — same reasoning as handleRegenKeyframe()'s own runImages() call
  // above: a regen is exactly the case that used to silently run for 90
  // minutes, it deserves Stop support too, not just shots/render_clips.
  try {
    await runImages(undefined, () => isCancelled(job.id));  // regenerates only the target keyframe
  } finally {
    await storeDir(project.id, `${runtime.outDir}/images`, "image", [".png", ".jpg", ".jpeg"]).catch(() => {});
  }

  // COST TRACKING (this regen path never logged ANY spend before) — every
  // OTHER shot restored above hit runImages()'s own local-file cache check
  // and made zero real calls, so these counts correctly reflect only the one
  // keyframe actually regenerated here.
  const regenImgCounts = await readJsonOr(`${runtime.outDir}/image-shots.json`, { nanoBananaImageCalls: 0 });
  const regenImageCostUsd = costOfImages(regenImgCounts.nanoBananaImageCalls);
  if (regenImageCostUsd > 0) {
    await logSpend("image", {
      userId: project.userId, projectId: project.id,
      units: regenImgCounts.nanoBananaImageCalls,
      amountUsd: regenImageCostUsd,
    });
  }

  // restore every OTHER clip (cached); the target clip regenerates from the new keyframe
  await fs.mkdir(`${runtime.outDir}/clips`, { recursive: true });
  for (const c of clips) {
    if (c.id === targetId) continue;
    await download(c.url, `${runtime.outDir}/clips/${clipFile(breakdown, c.id)}`).catch(() => {});
  }
  // STOPPABLE — a cancellation here mostly matters between attempts (this job
  // type is essentially one shot's worth of real work: every other clip above
  // is a restored copy), so Stop takes effect at the start of the NEXT
  // attempt rather than the middle of a render already in flight.
  await runVideos(undefined, undefined, () => isCancelled(job.id));

  // COST TRACKING — same reasoning: every OTHER clip was restored via download
  // above (a real render() call never happened for it), so baseRenderedSeconds
  // here reflects only the one clip actually re-filmed.
  const { baseRenderedSeconds: regenSeconds, extraRerollSeconds: regenRerollSeconds } = await readJsonOr(
    `${runtime.outDir}/qa-reroll-seconds.json`,
    { baseRenderedSeconds: 0, extraRerollSeconds: 0 },
  );
  const regenRenderedSeconds = regenSeconds + regenRerollSeconds;
  if (regenRenderedSeconds > 0) {
    const regenClipCostUsd = costOfClip(regenRenderedSeconds);
    await logSpend("clip", { userId: project.userId, projectId: project.id, units: regenRenderedSeconds, amountUsd: regenClipCostUsd });
  }

  // overwrite the target keyframe in R2 (same key) so future regens use the new one
  await uploadFile(`${runtime.outDir}/images/${targetId}.png`, `projects/${project.id}/image/${targetId}.png`).catch(() => {});

  const targetPath = `${runtime.outDir}/clips/${clipFile(breakdown, targetId)}`;
  const newClipKey = `projects/${project.id}/clip/${Date.now()}-${clipFile(breakdown, targetId)}`;
  const newUrl = await uploadFile(targetPath, newClipKey);
  const regenPoster = await makePoster(targetPath);
  if (regenPoster) await uploadFile(regenPoster, newClipKey.replace(/\.mp4$/i, ".jpg")).catch(() => {});
  await prisma.artifact.create({ data: { projectId: project.id, kind: "clip", url: newUrl } }).catch(() => {});
  // Re-check this shot's flag status against THIS run's fresh flag files,
  // rather than blindly carrying the old flagged/flagReason forward — a manual
  // regen that just fixed the problem must not stay stuck showing "flagged"
  // forever, and one that's flagged again should show the NEW reason, not
  // whatever it was flagged for before.
  const regenIdentityFlags = await readJsonOr<Record<string, string[]>>(`${runtime.outDir}/identity-flags.json`, {});
  const regenQaFlags = await readJsonOr<Record<string, string[]>>(`${runtime.outDir}/qa-flags.json`, {});
  const targetReasons = [...(regenIdentityFlags[targetId] ?? []), ...(regenQaFlags[targetId] ?? [])];
  const updated = clips.map((c) =>
    c.id === targetId
      ? { ...c, url: newUrl, flagged: targetReasons.length > 0, flagReason: targetReasons.length ? targetReasons.join("; ") : undefined }
      : c,
  );
  await prisma.project.update({ where: { id: project.id }, data: { clipsJson: updated as any, status: "clips_review", error: null } });
  await setJob(job.id, { status: "done", stage: "Clip updated", progress: 100 });
}

// ---- PHASE: assemble clips in the chosen order -> done ----
async function handleAssemble(project: any, job: any) {
  const order = ((job.payload as any)?.order as string[]) || [];
  const clips = (project.clipsJson || []) as Clip[];
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
  const ordered = (order.length ? order : clips.map((c) => c.id)).filter((id) => byId[id]);
  if (ordered.length === 0) throw new Error("No clips to assemble");

  // Same reason as handleRegenClip(): normalizeClip() reads targetDimensions()
  // off this shared runtime singleton, so it must be refreshed for THIS project
  // right before assembling, not left over from whatever job ran before it.
  applyProjectSettings(project);
  await setJob(job.id, { status: "running", stage: "Stitching your film", progress: 60 });
  await rmrf(runtime.outDir);
  await fs.mkdir(`${runtime.outDir}/clips`, { recursive: true });
  // runAssemble() groups clips into same-scene runs (for a dissolve instead of a
  // hard cut) by reading breakdown.json out of outDir. rmrf() above just wiped it,
  // and without this write it would silently degrade to a plain hard-cut concat.
  await writeBreakdown(project);
  // AI SONG VIDEOS — same reason writeBreakdown() re-writes breakdown.json
  // fresh for every assemble job (rmrf() above just wiped it): runAssemble()
  // reads song.json out of THIS job's own scratch outDir to know whether to
  // mux the real song as the master track instead of an instrumental score
  // bed (see finishFilm()'s own branch in 6-assemble.ts). Absent entirely
  // for an ordinary narrative film — project.songJson is only ever set by
  // handleSong().
  if (project.songJson) await writeJson(`${runtime.outDir}/song.json`, project.songJson);

  const localPaths: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const c = byId[ordered[i]];
    const local = `${runtime.outDir}/clips/${String(i + 1).padStart(2, "0")}-${c.id}.mp4`;
    await download(c.url, local);
    localPaths.push(local);
  }
  await fs.writeFile(`${runtime.outDir}/clips.json`, JSON.stringify(localPaths), "utf8");
  // USE THE RETURNED PATH, don't hardcode it — runAssemble() (6-assemble.ts)
  // is the single source of truth for what the finished file actually is
  // and does its own post-processing (music/score mixing, end fade,
  // broadcast audio export) in place before returning. Dialogue audio
  // itself comes from each clip's own Seedance generate_audio at
  // video-generation time, not a separate TTS/voice-mixing step here —
  // there is no ElevenLabs integration or lip-sync post-process in this
  // pipeline (see compiler.ts's R7.6b comment for why true lip-sync isn't
  // achievable against Seedance's API at all, stated honestly there).
  const assembled = await runAssemble({ userId: project.userId, projectId: project.id });

  // watermark the final film for FREE-plan users only (logo image only — this ffmpeg has no drawtext).
  // FORCE_WATERMARK=true overrides the plan check entirely — for pre-launch testing/ad
  // material on a paid/enterprise test account, where every render should carry the mark
  // regardless of plan (a real paying enterprise customer would never set this env var).
  let finalPath = assembled || `${runtime.outDir}/final.mp4`;
  try {
    const forceWatermark = (process.env.FORCE_WATERMARK ?? "false") === "true";
    const u = await prisma.user.findUnique({ where: { id: project.userId }, select: { plan: true } });
    const plan = (u?.plan || "lite").toLowerCase();
    if (forceWatermark || plan === "lite" || plan === "free") {
      const wm = `${runtime.outDir}/final-wm.mp4`;
      const logo = path.join(process.cwd(), "assets", "watermark.png");
      // scale the logo to ~44px tall and overlay bottom-right (use the full safa.ai logo image)
      const fc = `[1:v]scale=-1:44[wm];[0:v][wm]overlay=W-w-24:H-h-24`;
      execSync(`ffmpeg -y -i "${finalPath}" -i "${logo}" -filter_complex "${fc}" -c:a copy "${wm}"`, { stdio: "ignore" });
      finalPath = wm;
    }
  } catch (e) {
    console.error("watermark skipped:", (e as Error)?.message);
  }

  const filmKey = `projects/${project.id}/final-${Date.now()}.mp4`;
  const filmUrl = await uploadFile(finalPath, filmKey);
  const filmPoster = await makePoster(finalPath);
  if (filmPoster) await uploadFile(filmPoster, filmKey.replace(/\.mp4$/i, ".jpg")).catch(() => {});
  await prisma.project.update({ where: { id: project.id }, data: { filmUrl, status: "done", error: null } });
  await prisma.artifact.create({ data: { projectId: project.id, kind: "final", url: filmUrl } }).catch(() => {});

  // BROADCAST-SPEC AUDIO — CONFIRMED REAL GAP, FIXED: finishFilm() (6-assemble.ts)
  // writes final_broadcast.wav (and final_broadcast_5.1.wav, when
  // config.broadcast51Enabled) into runtime.outDir when config.
  // broadcastExportEnabled is on, but nothing previously uploaded them — and
  // tick()'s own finally block unconditionally rmrf()s this job's ENTIRE
  // output directory right after this handler returns. The feature ran, paid
  // for the real 2-pass loudnorm encode, logged success, and the result was
  // gone before the job was even marked done. Paths are deterministic (the
  // exact ones finishFilm() itself writes to), so no return-signature change
  // is needed — just check for them and upload here, same "best-effort,
  // never blocks the primary deliverable" discipline finishFilm() already
  // uses for this same feature.
  const broadcastWavPath = `${runtime.outDir}/final_broadcast.wav`;
  if (await fileExists(broadcastWavPath)) {
    try {
      const broadcastUrl = await uploadFile(broadcastWavPath, `projects/${project.id}/final-broadcast-${Date.now()}.wav`);
      await prisma.artifact.create({ data: { projectId: project.id, kind: "broadcast_audio", url: broadcastUrl } }).catch(() => {});
    } catch (e) {
      console.error("broadcast audio upload failed:", (e as Error)?.message);
    }
  }
  const broadcast51Path = `${runtime.outDir}/final_broadcast_5.1.wav`;
  if (await fileExists(broadcast51Path)) {
    try {
      const broadcast51Url = await uploadFile(broadcast51Path, `projects/${project.id}/final-broadcast-5.1-${Date.now()}.wav`);
      await prisma.artifact.create({ data: { projectId: project.id, kind: "broadcast_audio_51", url: broadcast51Url } }).catch(() => {});
    } catch (e) {
      console.error("broadcast 5.1 audio upload failed:", (e as Error)?.message);
    }
  }

  await setJob(job.id, { status: "done", stage: "Done", progress: 100 });
}

const HANDLERS: Record<string, (p: any, j: any) => Promise<void>> = {
  breakdown: handleBreakdown,
  song: handleSong,
  song_breakdown: handleSongBreakdown,
  regen_shot: handleRegenShot,
  options: handleOptions,
  shots: handleShots,
  regen_keyframe: handleRegenKeyframe,
  regen_sheet: handleRegenSheet,
  render_clips: handleRenderClips,
  regen_clip: handleRegenClip,
  assemble: handleAssemble,
  delete_shot: handleDeleteShot,
  insert_shot: handleInsertShot,
};

// on failure, revert sub-operations to their review screen; fail the major phases
// ("song" and "song_breakdown" are major phases, same tier as "breakdown" — not
// in this map, same reasoning: a permanent failure there falls through to
// REVERT[job.type] || "failed", i.e. a full stop needing a fresh submission).
// "shots" is ALSO not in this map, same reasoning again — it's the first real
// paid spend for a narrative film (same tier as "song"), so a permanent
// failure there falls through to "failed" rather than reverting to a review
// screen the user never actually reached.
const REVERT: Record<string, string> = {
  regen_shot: "breakdown_review", regen_clip: "clips_review", assemble: "clips_review",
  delete_shot: "clips_review", insert_shot: "clips_review",
  // regen_keyframe/render_clips revert to keyframes_review, not "failed" — the
  // user's already-approved (and already-paid-for) keyframes aren't lost just
  // because a clip failed to render.
  regen_keyframe: "keyframes_review", render_clips: "keyframes_review",
};

const MAX_ATTEMPTS = 3;                       // a job gets 3 tries before it is really failed
const BACKOFF_MS = [0, 30_000, 120_000];      // then wait 30s, then 2min before retrying
const STUCK_AFTER_MS = 30 * 60_000;           // a "running" job untouched for 30min is a dead worker
// Shared with tick()'s own liveness heartbeat below (see that comment for
// why 6 min): a genuinely alive worker touches its job's updatedAt at least
// this often even between real progress writes.
const HEARTBEAT_MS = Math.max(30_000, Math.floor(STUCK_AFTER_MS / 5));
// claimJob()'s per-project mutex (below) needs its OWN, much shorter
// staleness window than STUCK_AFTER_MS. CONFIRMED REAL, LIVE FAILURE
// (2026-08-13): the worker was killed (Ctrl+C) and restarted to pick up a
// fix. Its one in-flight job's row was still "running" in the DB — nothing
// updates that on a hard kill — and the mutex correctly refuses to let a
// SECOND job run concurrently against the same project, but it was using
// "any row with status running" as its definition of busy. The fresh worker
// polled, found the project "busy" because of that orphaned row, and sat
// idle — for the full 30 minutes it takes STUCK_AFTER_MS's own sweep
// (below) to reclaim it, since that threshold is deliberately conservative
// (see its own use-site comment: a legitimately slow phase, e.g. a long
// breakdown, can genuinely run 27+ minutes with no progress write). A dead
// worker's row stops updating entirely, forever; a live one refreshes it at
// least every HEARTBEAT_MS regardless of what phase it's in. So a row
// that's gone dark for longer than one heartbeat interval (with slack for
// jitter) is never a live worker's real progress — only ever a dead one —
// and can safely stop blocking other queued work for its project without
// touching the separate, more conservative 30-minute reclaim of the row
// itself.
const PROJECT_BUSY_GRACE_MS = HEARTBEAT_MS * 2;

/** Atomically claim ONE queued job.
 *  The old code did findFirst() then update(), which is a read-then-write race: two workers
 *  both read the same row and both render it, so you pay the provider twice. updateMany with
 *  `status: "queued"` in the WHERE clause makes the claim a single conditional write, so
 *  exactly one worker can win. This is what lets you run more than one worker. */
async function claimJob() {
  // Recover jobs abandoned by a worker that died mid-render.
  await prisma.job.updateMany({
    where: { status: "running", updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
    data: { status: "queued", stage: "Requeued after a stalled render" },
  }).catch(() => {});

  // A project can end up with more than one queued job of the same type —
  // e.g. a double-submitted "approve"/"continue" request, or this worker
  // being started a second time (in another terminal/session) while an
  // earlier instance is still processing the same project. Nothing enforced
  // a project could only have ONE active job: two workers could each claim a
  // different queued job for the SAME project and run them concurrently,
  // doubling every DB call, fal.ai call, and local-file write for that
  // project's outDir. CONFIRMED REAL, LIVE FAILURE (2026-08-13): exactly
  // this — a project sat with 4 render_clips jobs (1 running, 2 queued, 1
  // retrying) all created within 15 seconds of each other, and the running
  // job's DB queries started throwing "Timed out fetching a new connection
  // from the connection pool" (limit 17) until it failed outright — the
  // project could never reach clips_review because no single render_clips
  // attempt ever finished clean. Excluding any project that already has a
  // "running" job here is a project-level mutex: only one job per project
  // is ever in flight at a time, regardless of how many duplicates piled up
  // queued behind it or how many worker processes are polling.
  const busyProjects = await prisma.job.findMany({
    where: { status: "running", updatedAt: { gte: new Date(Date.now() - PROJECT_BUSY_GRACE_MS) } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  const busyProjectIds = busyProjects.map((j) => j.projectId);

  for (let i = 0; i < 5; i++) {
    const candidate = await prisma.job.findFirst({
      where: {
        status: "queued",
        OR: [{ runAfter: null }, { runAfter: { lte: new Date() } }],
        projectId: { notIn: busyProjectIds },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!candidate) return null;

    // Only succeeds if the row is STILL queued: whoever gets count === 1 owns the job.
    const claimed = await prisma.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", stage: "Starting" },
    });
    if (claimed.count === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
    // Another worker beat us to it: try the next job.
  }
  return null;
}

// CREDIT-REFUND AUDITOR (pre-launch ops automation, 2026-08-07) — every
// refund below used to be a bare `credits: { increment: 1 } }` mutation with
// no record anywhere of WHICH job/project it was for or WHY, so there was
// previously no way to audit refunds at all, not even a wrong-amount check.
// This doesn't change WHAT gets refunded — still always exactly 1 credit,
// matching this project's own confirmed-intentional flat-rate-per-action
// credit model (every render action costs 1 credit flat, not a variable/
// spend-proportional amount) — it makes the refund AUDITABLE: safa-web's own
// digest reads these OpsFinding rows and cross-references them against that
// project's real Spend history, flagging (never auto-correcting) anything
// that looks inconsistent for a human to review.
async function refundCredit(userId: string, jobId: string, projectId: string, reason: string, resetFreeFilm: boolean): Promise<void> {
  await prisma.user
    .update({
      where: { id: userId },
      data: resetFreeFilm ? { credits: { increment: 1 }, freeFilmUsedAt: null } : { credits: { increment: 1 } },
    })
    .catch(() => {});
  void logOpsFinding("refund-audit", "info", `Refunded 1 credit — ${reason}`, JSON.stringify({ userId, jobId, projectId }));
}

async function tick(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const project = await prisma.project.findUnique({ where: { id: job.projectId } });
  if (!project) { await setJob(job.id, { status: "failed", error: "Project not found" }); return true; }
  const handler = HANDLERS[job.type];
  if (!handler) { await setJob(job.id, { status: "failed", error: `Unknown job type: ${job.type}` }); return true; }

  // ISOLATE THIS JOB'S LOCAL SCRATCH DIRECTORY — see runtime.outDir's own
  // comment in config.ts. Set ONCE here (not per-handler) so every job type,
  // including any added to HANDLERS later, is covered automatically: without
  // it, every handler shares the same hardcoded "output" directory and calls
  // rmrf() on it at its own start, so a second worker process claiming ANY
  // other job would delete this job's in-progress local files out from under
  // it the moment more than one worker ever runs at once.
  setJobOutDir(job.id);
  const jobOutDir = runtime.outDir;

  console.log(`▶ job ${job.id} (${job.type}) for project ${project.id}`);

  // ── LIVENESS HEARTBEAT ───────────────────────────────────────────────────
  // claimJob() treats any "running" job whose `updatedAt` is older than
  // STUCK_AFTER_MS (30 min) as abandoned by a dead worker and requeues it. That
  // recovery is correct and necessary — but it cannot tell a DEAD worker from a
  // SLOW PHASE, and it only ever had the handler's own setJob() calls to go on.
  //
  // CONFIRMED REAL EXPOSURE: handleBreakdown() sets "Reading the script" and
  // then calls runBreakdown(), which for a long script does all its work — the
  // director call, repair rounds, the read-through, length reconciliation — with
  // NO setJob() in between. A real 26-shot breakdown already took 27 minutes; an
  // 83-shot one with iterative length reconciliation comfortably exceeds 30. So
  // `updatedAt` sits frozen, the sweep decides the worker died, and a SECOND
  // worker claims and re-runs the identical breakdown while the first is still
  // working: double LLM spend, and two writers racing to set breakdownJson on
  // the same project with last-write-wins.
  //
  // Touching `updatedAt` on a fixed interval separates the two cases properly:
  // "still alive" is now reported by the process itself rather than inferred
  // from whether a handler happened to log progress recently. Placed here in
  // tick() rather than inside any one handler so every job type — including any
  // added later — is covered automatically, the same reasoning setJobOutDir()
  // above is set here rather than per-handler.
  //
  // Deliberately writes ONLY updatedAt, never stage/progress: the UI reads
  // those, and a heartbeat must not overwrite whatever real progress the
  // handler last reported. Failures are swallowed — a missed heartbeat is not
  // worth failing a render over, and the next one is a few minutes away.
  const heartbeat = setInterval(() => {
    prisma.job
      .updateMany({ where: { id: job.id, status: "running" }, data: { updatedAt: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_MS);
  // Never hold the event loop open on this timer alone — if the worker is
  // otherwise finished, an un-unref'd interval would keep the process alive.
  heartbeat.unref?.();

  try {
    await handler(project, job);
    console.log(`✓ job ${job.id} done`);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    const attempts = (job.attempts ?? 0) + 1;

    // ── USER-REQUESTED STOP (not a failure, not transient) ─────────────────
    // See lib/cancel.ts. project.status is deliberately left untouched — it's
    // still whatever "generating_*" value it was, so a Resume just re-queues
    // a fresh job of the SAME type/payload and picks up from what's already
    // banked (clips bank incrementally as they finish; the keyframe pass now
    // banks whatever's on disk in a finally regardless of how it exited — see
    // renderKeyframesPass()). No refund: this is the same paid render
    // continuing, not a new one, same reasoning as the keyframes_review ->
    // render_clips resume already uses (chargeCredit: false).
    if (e instanceof JobCancelledError) {
      console.log(`⏸ job ${job.id} (${job.type}) cancelled by user for project ${project.id}`);
      await setJob(job.id, { status: "cancelled", stage: "Paused", cancelRequested: false });
      return true;
    }

    // ── NEEDS YOUR EDIT (not a bug, not transient) ─────────────────────────
    // The provider refused this prompt on content grounds. It will refuse the same
    // text forever, so retrying only burns money — but the user CAN fix it by
    // rewriting that one beat. Every other keyframe and clip stays banked in
    // artifacts, so the re-run resumes from exactly where this stopped.
    //
    // "shots"/"render_clips" are the two MAJOR, whole-render phases — a
    // refusal there pauses the WHOLE project in "needs_edit" (the full
    // breakdown editor screen) and resumes via chat's resumeForNeedsEdit().
    // Every OTHER job type here (regen_keyframe, regen_clip, insert_shot,
    // delete_shot) is a small, single-shot operation already reachable from —
    // and safely retryable directly on — its own review screen
    // (keyframes_review/clips_review), so it reverts straight there instead,
    // exactly like every other permanent failure for these types already
    // does (see REVERT map below).
    //
    // CONFIRMED REAL GAP, FIXED: this used to unconditionally set "needs_edit"
    // for EVERY job type, but chat's resumeForNeedsEdit() only ever knew how
    // to resume "shots" or "render_clips" — any other job type landed a
    // free-tier user in a permanent dead end (claimFreeFilm() failing against
    // an already-claimed flag, since only shots/render_clips reset it) and
    // silently overcharged a paid user a full new film's credit trying to
    // retry what should have been a single free regen.
    if (e instanceof ContentRefusedError) {
      console.error(`✋ Needs your edit — shot ${e.shotId} (${e.stage}): ${e.message}`);
      await setJob(job.id, { status: "failed", attempts, error: e.message });
      const isMajorPhase = job.type === "shots" || job.type === "render_clips";
      // regen_sheet: NEVER touches project.status (see the general permanent-
      // failure path below for the full reasoning — it's triggered from a
      // global, status-agnostic gallery, not a per-project review screen, so
      // there is no single correct "revert" status and none should be forced).
      if (job.type !== "regen_sheet") {
        await prisma.project
          // e.message, not e.toDetail(): CONFIRMED REAL GAP, FIXED — toDetail()'s
          // JSON blob was designed for a UI that would parse it back out via
          // parseRefusalDetail() into a friendly "edit this beat" prompt, but
          // nothing in safa-web ever actually called that — project.error is
          // shown verbatim as plain text everywhere (ErrorNotice), so users were
          // seeing raw JSON instead of a message. Both are removed; see refusal.ts.
          .update({ where: { id: project.id }, data: { status: isMajorPhase ? "needs_edit" : (REVERT[job.type] || "failed"), error: e.message } })
          .catch(() => {});
      }
      if (isMajorPhase) {
        // render_clips alongside shots: both are real, paid steps of the SAME
        // single free-film attempt (the flat film cost/free-film claim happens
        // once, at select time, and covers keyframes AND clips together — see
        // Project.creditsCost's own comment) — a content refusal during
        // EITHER stage means that one attempt didn't produce a finished film.
        //
        // freeFilmUsedAt: null ALONGSIDE the credit refund, not just the
        // credit — see the general permanent-failure path below for the full
        // reasoning. Content refusal specifically resumes (the user edits the
        // offending beat and re-submits), and that resume needs to re-claim
        // the free film — without this reset, claimFreeFilm() would find the
        // flag already set from this failed attempt and refuse forever.
        await refundCredit(project.userId, job.id, project.id, `content refusal on a major phase (${job.type})`, true);
      } else if (job.type === "insert_shot") {
        // insert_shot charges 1 credit up front (clips/route.ts), unrelated to
        // the free-film flag — same refund this job type already gets for any
        // OTHER permanent failure (see the general path below). Previously
        // missing on THIS path specifically, so a content-refused insert lost
        // the credit outright.
        await refundCredit(project.userId, job.id, project.id, "content refusal on insert_shot", false);
      }
      return true;
    }

    // A 4xx is DETERMINISTIC — the provider rejected the request itself, so it will fail
    // identically every single time. And because handleShots() calls rmrf(runtime.outDir),
    // every retry WIPES THE CACHE and re-pays for the character sheet and every keyframe.
    // Three attempts against one 422 = three full re-renders for zero chance of success.
    // That is where the credits went — not the failure. Retry transient errors only.
    const status = (e as any)?.status ?? (e as any)?.response?.status;
    const permanent =
      (typeof status === "number" && status >= 400 && status < 500) ||
      // A compiler block is DETERMINISTIC — the same script yields the same rejection
      // every time. Retrying is guaranteed to fail identically, so don't thrash.
      /cannot be rendered/i.test(msg) ||
      // A budget cap is ALSO deterministic within the retry window — if you're
      // over budget now, you're still over budget 30 seconds later. Without
      // this, checkCaps() callers got needlessly retried MAX_ATTEMPTS times
      // (with backoff delays) before the correct message finally reached the
      // user, even though nothing about retrying could ever fix it.
      e instanceof BudgetCapExceededError;
    if (permanent) console.error(`⛔ Permanent failure — not retrying (a retry would fail identically).`);

    if (attempts < MAX_ATTEMPTS && !permanent) {
      // RETRY: only for transient failures — network blips, 5xx, rate limits.
      // Note the cache does NOT survive a retry (rmrf wipes outDir), so retries are NOT free.
      const wait = BACKOFF_MS[attempts] ?? 120_000;
      console.warn(`↻ job ${job.id} failed (attempt ${attempts}/${MAX_ATTEMPTS}), retrying in ${wait / 1000}s: ${msg}`);
      reportJobError(e, { jobId: job.id, type: job.type, projectId: project.id, attempts });
      await setJob(job.id, {
        status: "queued",
        attempts,
        error: msg,
        stage: `Retrying after an error (attempt ${attempts + 1} of ${MAX_ATTEMPTS})`,
        runAfter: new Date(Date.now() + wait),
      });
      return true; // project status stays as-is: the user still sees it working
    }

    console.error(`✗ job ${job.id} failed permanently after ${attempts} attempts:`, msg);
    reportJobError(e, { jobId: job.id, type: job.type, projectId: project.id, attempts });
    await setJob(job.id, { status: "failed", attempts, error: msg });
    // regen_sheet: deliberately NOT in REVERT and deliberately exempted here
    // rather than falling through to "failed" — it's queued from safa-web's
    // global Artifacts gallery against a project in ANY status (including
    // "done"), so there is no single correct revert screen, and forcing
    // "failed" would incorrectly break a finished project's displayed status
    // over a background sheet-regen attempt that has nothing to do with the
    // film itself. The job row above already carries the failure/error for
    // the gallery to show inline.
    if (job.type !== "regen_sheet") {
      await prisma.project.update({ where: { id: project.id }, data: { status: REVERT[job.type] || "failed", error: msg } }).catch(() => {});
    }
    // freeFilmUsedAt: null ALONGSIDE the credit refund. A free-tier account
    // starts with exactly 1 credit, claimed together with freeFilmUsedAt in
    // ONE transaction (see safa-web's claimFreeFilm()) — so a "shots" job
    // permanently failing for a free-tier user is, in practice, always their
    // one-and-only free-film attempt (they could not have had a SECOND shots
    // job created without spendBlocked() already refusing them for having
    // used their free film). Refunding the credit alone left it permanently
    // unspendable: spendBlocked()'s free-plan gate checks freeFilmUsedAt
    // UNCONDITIONALLY, regardless of credit balance, so a technical failure
    // that was never the user's fault silently cost them their entire free
    // trial. Harmless no-op for a paid user, whose freeFilmUsedAt is never
    // set to begin with.
    if (job.type === "shots" || job.type === "song") {
      // "song" is treated the same tier as "shots": for a song video with NO
      // performer described, there is no options/select step at all (see
      // handleOptions()/runOptions()/runSheet()'s natural empty-array no-op
      // behavior) — "song" is the FIRST real paid spend, exactly the role
      // "shots" plays for narrative films, so the same free-film-reclaim
      // reasoning applies identically here.
      await refundCredit(project.userId, job.id, project.id, `permanent failure on a major phase (${job.type})`, true);
    } else if (job.type === "insert_shot") {
      // insert_shot charges 1 credit up front (clips/route.ts, before this job
      // is even queued) on a project that's ALREADY had its real free-film
      // credit claimed and spent — this failure has nothing to do with that
      // claim, so refund the credit only, without freeFilmUsedAt's reset.
      await refundCredit(project.userId, job.id, project.id, "permanent failure on insert_shot", false);
    }
  } finally {
    // FIRST, unconditionally: a heartbeat that outlived its job would keep
    // touching updatedAt on a row this worker no longer owns, which is exactly
    // the signal claimJob()'s stall recovery depends on being truthful. Cleared
    // here rather than after the try so it happens on EVERY exit path —
    // success, cancellation, a scheduled retry, or a permanent failure.
    clearInterval(heartbeat);
    // Every handler already rmrf()s + rebuilds this SAME directory from
    // scratch (R2 artifacts + DB fingerprints, never local-disk persistence)
    // the next time this job is attempted, so it's safe to always clean up
    // here regardless of outcome — success, a scheduled retry, or a permanent
    // failure. Without this, a namespaced-per-job directory that used to be
    // cleaned up implicitly (by the NEXT job's rmrf of the one shared "output"
    // dir) would instead just accumulate on disk forever, one per job ever run.
    await rmrf(jobOutDir).catch(() => {});
  }
  return true;
}

async function main() {
  console.log("👷 safa worker started — polling for jobs…");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let did = false;
    try { did = await tick(); } catch (e) { console.error("tick error:", e); }
    await sleep(did ? 500 : 3000);
  }
}
main();