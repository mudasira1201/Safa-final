import { runtime } from "../config";
import { breakdownAd, repairShots, repairCharacters } from "../providers/llm";
import { compileBreakdown, printIssues, blockingErrors, REPAIRABLE_WARN_CODES } from "../lib/compiler";
import { writeJson, readJsonOr, fileExists, isMain } from "../util";
import type { Breakdown } from "../types";

/** Same repair-loop shape as 1b-song-breakdown.ts's own (itself mirroring
 *  1-breakdown.ts's runBreakdown(), deliberately not imported directly — see
 *  that file's own comment for why: it's specific to script-breakdown's
 *  local closures that don't apply here either). */
const MAX_REPAIRS = 2;

const ADDITIVE = new Set([
  "NARRATIVE_GAP_NEEDS_TRANSITION", "ACTION_NEVER_COMPLETES", "THRESHOLD_NOT_CROSSED",
  "MISSING_HANDOFF_SHOT", "SCRIPT_DIALOGUE_LINE_DROPPED", "POINTLESS_BUSINESS",
]);

/** Same bracket-tag-prefix convention 1-breakdown.ts's parseTargetSeconds()
 *  already uses for duration — CreateFlow.tsx's ad-mode camera-style picker
 *  prepends `[Camera style: <key>]` (the library's raw key, e.g. "orbit_360",
 *  not its display name — no fuzzy name matching needed) to the script before
 *  POSTing; worker.ts strips it the same way it already strips the duration
 *  tag before calling runAd(). An unrecognized/missing key is safe: breakdownAd()
 *  just falls through to the unchanged default (a 360°/orbit shot). */
export function parseCameraStyle(script: string): string | undefined {
  const m = script.match(/\[Camera style:\s*([^\]]+)\]/i);
  return m ? m[1].trim() : undefined;
}

/** Ad mode's "Spokesperson" toggle — same bracket-tag convention as
 *  parseCameraStyle() above (written by app/api/projects/route.ts, stripped
 *  by worker.ts's handleBreakdown before runAd() sees the brief).
 *
 *  A person in the ad is now OPT-IN and INDEPENDENT of whether a character
 *  photo was uploaded. hasCharacter used to be derived from
 *  `project.characterImages.length` alone, which conflated two separate
 *  questions: "should a person appear at all?" and "do we already have their
 *  photo?". That made a spokesperson ad impossible without supplying your own
 *  photo, and silently forced one into the ad whenever a photo happened to be
 *  attached. No tag = faceless, product-only ad (the default). */
export function parseSpokesperson(script: string): boolean {
  return /\[Spokesperson:\s*yes\s*\]/i.test(script);
}

async function compileAndRepair(breakdown: Breakdown): Promise<Breakdown> {
  let raw = breakdown;
  let { breakdown: compiled, issues } = compileBreakdown(raw, { isAd: true });
  printIssues(issues);

  const originalCount = compiled.shots.length;
  const MAX_ADDED = Math.max(2, Math.ceil(originalCount * 0.2));

  for (let round = 1; round <= MAX_REPAIRS; round++) {
    const blockers = blockingErrors(issues);
    const repairable = issues.filter((i) => !i.autofixed && REPAIRABLE_WARN_CODES.has(i.code));
    const grown = compiled.shots.length - originalCount;
    const allowed = grown >= MAX_ADDED ? repairable.filter((i) => !ADDITIVE.has(i.code)) : repairable;
    if (grown >= MAX_ADDED && allowed.length < repairable.length) {
      console.log(`   ⏸  shot count has grown by ${grown} (cap ${MAX_ADDED}) — no more added beats.`);
    }
    const targets = [...blockers, ...allowed];
    if (!targets.length) break;

    console.log(`🔁 ${targets.length} shot(s) need work (${blockers.length} blocking) — repairing (round ${round}/${MAX_REPAIRS})...`);
    raw = await repairCharacters(compiled, targets);
    raw = await repairShots(raw, targets);
    ({ breakdown: compiled, issues } = compileBreakdown(raw, { isAd: true }));
    printIssues(issues);
  }

  const blockers = blockingErrors(issues);
  if (blockers.length) {
    throw new Error(
      `Ad breakdown still has ${blockers.length} blocking issue(s) after ${MAX_REPAIRS} repair round(s):\n` +
      blockers.map((b) => `  ${b.code}: ${b.detail}`).join("\n"),
    );
  }
  return compiled;
}

/** Project.type "ad" — a short creative prompt (never a narrative script) ->
 *  a director-planned Breakdown, via breakdownAd() (llm.ts). Deliberately
 *  reuses compileBreakdown() unchanged, same reasoning as runSongBreakdown():
 *  none of that machinery (identity locks, camera-continuity, negative
 *  prompts) is narrative-specific — an ad shot needs the same real endpoints/
 *  consistency discipline any other shot does. Does NOT call
 *  checkScriptContentInvention() (1-breakdown.ts's own extra pass) — there is
 *  no fixed script to compare against; the whole point of ad mode is that
 *  the director INVENTS the shot list from a brief, not preserves one. */
export async function runAd(prompt: string, productImageUrl: string | undefined, targetSeconds: number, hasCharacter: boolean, cameraStyleKey?: string): Promise<Breakdown> {
  const out = `${runtime.outDir}/breakdown.json`;
  if (await fileExists(out)) return readJsonOr<Breakdown>(out, undefined as any);

  const raw = await breakdownAd(prompt, productImageUrl, targetSeconds, hasCharacter, cameraStyleKey);
  const breakdown = await compileAndRepair(raw);

  await writeJson(out, breakdown);

  const secs = breakdown.shots.reduce((n, s) => n + (s.screenSeconds || s.duration), 0);
  console.log(
    `✅ "${breakdown.title}" ad — ${breakdown.characters.length} character(s), ` +
    `${breakdown.shots.length} shot(s), ~${secs.toFixed(1)}s planned (target ${targetSeconds}s).`,
  );
  return breakdown;
}

if (isMain(import.meta.url)) {
  runAd("Create a cinematic ad for a premium glass perfume bottle", undefined, 20, false).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
