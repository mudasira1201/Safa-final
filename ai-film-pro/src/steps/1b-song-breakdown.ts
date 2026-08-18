import { runtime } from "../config";
import { breakdownSong, repairShots, repairCharacters } from "../providers/llm";
import { compileBreakdown, printIssues, blockingErrors, REPAIRABLE_WARN_CODES } from "../lib/compiler";
import { writeJson, readJsonOr, fileExists, isMain } from "../util";
import type { Breakdown } from "../types";
import type { SongData } from "./0-song";

/** Same repair-loop shape as 1-breakdown.ts's runBreakdown() (blockingErrors
 *  + REPAIRABLE_WARN_CODES warns, repairCharacters() then repairShots() each
 *  round, recompile, up to MAX_REPAIRS) — deliberately NOT importing that
 *  function directly, since it's specific to script-breakdown's own local
 *  closures (checkScriptContentInvention, action/staging inference caching)
 *  that don't apply here. HONEST GAP vs that function: this loop skips the
 *  action/staging-rule INFERENCE CACHING (pendingActionInferences/
 *  pendingStagingInferences) — a performance optimization for repeat runs
 *  against the SAME action library, not a correctness requirement; add it
 *  later if song-video repair rounds turn out to be slow/expensive enough
 *  to matter. */
const MAX_REPAIRS = 2;

/** Same set as 1-breakdown.ts's own ADDITIVE — codes whose fix genuinely
 *  requires inserting a new shot, capped once the shot list has grown past
 *  MAX_ADDED so a repair round can't run away inflating the shot count
 *  (and therefore cost) indefinitely. */
const ADDITIVE = new Set([
  "NARRATIVE_GAP_NEEDS_TRANSITION", "ACTION_NEVER_COMPLETES", "THRESHOLD_NOT_CROSSED",
  "MISSING_HANDOFF_SHOT", "SCRIPT_DIALOGUE_LINE_DROPPED", "POINTLESS_BUSINESS",
]);

async function compileAndRepair(breakdown: Breakdown): Promise<Breakdown> {
  let raw = breakdown;
  let { breakdown: compiled, issues } = compileBreakdown(raw);
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
    ({ breakdown: compiled, issues } = compileBreakdown(raw));
    printIssues(issues);
  }

  const blockers = blockingErrors(issues);
  if (blockers.length) {
    throw new Error(
      `Song breakdown still has ${blockers.length} blocking issue(s) after ${MAX_REPAIRS} repair round(s):\n` +
      blockers.map((b) => `  ${b.code}: ${b.detail}`).join("\n"),
    );
  }
  return compiled;
}

/** PHASE 2 of a song video (see worker.ts's "song_breakdown" job /
 *  handleSongBreakdown()): the already-generated song (song.json, written by
 *  0-song.ts) -> a Breakdown-shaped shot list timed to its real section
 *  durations. Deliberately reuses compileBreakdown() unchanged — same
 *  negative-prompt/lens-library/identity-lock/camera-continuity enforcement
 *  a narrative film's breakdown gets, since none of that machinery is
 *  narrative-specific (see breakdownSong()'s own comment in llm.ts). Does
 *  NOT call checkScriptDialogueCoverage() (1-breakdown.ts's own extra pass)
 *  — there is no script to compare lyrics against, and lyrics aren't
 *  spoken-in-scene dialogue the way a screenplay's quoted lines are. */
export async function runSongBreakdown(visualTheme: string, performerAppearance?: string): Promise<Breakdown> {
  const out = `${runtime.outDir}/breakdown.json`;
  if (await fileExists(out)) return readJsonOr<Breakdown>(out, undefined as any);

  const songData = await readJsonOr<SongData | null>(`${runtime.outDir}/song.json`, null);
  if (!songData) throw new Error("No song.json found — run the song step before the song breakdown step.");

  const raw = await breakdownSong(songData.lyrics, songData.song, visualTheme, performerAppearance);
  const breakdown = await compileAndRepair(raw);

  await writeJson(out, breakdown);

  const secs = breakdown.shots.reduce((n, s) => n + (s.screenSeconds || s.duration), 0);
  console.log(
    `✅ "${breakdown.title}" song video — ${breakdown.characters.length} character(s), ` +
    `${breakdown.shots.length} shot(s), ~${secs.toFixed(1)}s planned (song is ${songData.song.durationSec.toFixed(1)}s).`,
  );
  return breakdown;
}

if (isMain(import.meta.url)) {
  runSongBreakdown("warm golden-hour visuals, empty rooms, packed boxes, a road stretching ahead").catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
