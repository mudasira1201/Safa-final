import { promises as fs } from "node:fs";
import { config, runtime } from "../config";
import { breakdownScript, repairShots, repairCharacters, directorReadThrough, reconcileLength, inferActionRule, inferStagingRule, checkShotVariety, reviseShotVariety, checkScriptContentInvention } from "../providers/llm";
import {
  compileBreakdown, printIssues, blockingErrors, REPAIRABLE_WARN_CODES, cacheInferredAction, cacheInferredStaging,
  checkScriptDialogueCoverage, checkTranslatedDialogueCoverage, synthesizeEndFrame, type CompileIssue,
} from "../lib/compiler";
import { loadPersistedActionRule, persistActionRule, loadPersistedStagingRule, persistStagingRule } from "../lib/actionRuleStore";
import type { ActionRule } from "../lib/actionLibrary";
import { inferredToStagingRule } from "../lib/stagingLibrary";
import { writeJson, readJsonOr, fileExists, isMain } from "../util";
import { mapLimit } from "../concurrency";
import type { Breakdown } from "../types";
import { parseLanguage, languageName, isTranslated, DEFAULT_LANGUAGE } from "../lib/languages";

/** How many times we hand a rejection back to the LLM before giving up. */
const MAX_REPAIRS = 2;

/** TEMPORARY PHASE-TIMING INSTRUMENTATION (2026-08-06) — added specifically
 *  to find out WHERE a real 13.78-minute breakdown actually spends its time,
 *  after two real speed fixes (parallelized inference resolution, a raised
 *  repair-batch token cap) confirmed working exactly as intended (repair
 *  calls dropped from 15-20+ sequential ones to 2 total) barely moved the
 *  total — meaning the dominant cost is the NUMBER of sequential major
 *  phases, not batch-splitting within any one of them. Logs each phase's
 *  own wall-clock time plus a final summary, so the next optimization
 *  targets the real bottleneck instead of guessing again. Safe to remove
 *  once that's identified and fixed — purely diagnostic, no behavior change. */
const phaseLog: { label: string; sec: number }[] = [];
async function timedPhase<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const sec = (Date.now() - start) / 1000;
  phaseLog.push({ label, sec });
  console.log(`   ⏱  [${label}] ${sec.toFixed(1)}s`);
  return result;
}

/** CONCURRENCY for resolvePendingInferences() below, DELIBERATELY separate
 *  from concurrency.ts's own CONCURRENCY constant (tuned to fal.ai's
 *  documented 10-simultaneous-request account cap, a completely different
 *  provider/limit). inferActionRule()/inferStagingRule() calls are small
 *  (confirmed real: ~750-900 tokens each, vs. a repair batch's ~27,000) and
 *  fully independent of each other — no call's result depends on another's
 *  — so running a handful at once is safe against any reasonable OpenAI
 *  per-minute token budget, unlike repairShots()'s batches (which stay
 *  strictly sequential on purpose: a later batch must see an earlier
 *  batch's repairs already applied for continuity-chained fixes to be
 *  correct, and each batch alone can already approach the account's real
 *  TPM ceiling — see REPAIR_MAX_INPUT_TOKENS's own history in .env.example). */
const INFERENCE_CONCURRENCY = 5;

/** Parses the "[Target length: ...]" marker safa-web folds into the script
 *  (see app/api/projects/route.ts). Handles both forms CreateFlow.tsx sends
 *  ("<N> min" for an exact multiple of 60s, "<N> seconds" otherwise) and sums
 *  both defensively in case a future caller ever combines them. Returns null
 *  when there's no marker at all (a bare script, or the CLI path reading
 *  straight from scripts/sample.txt) — length reconciliation below is
 *  skipped entirely in that case, exactly like today's behaviour. */
export function parseTargetSeconds(script: string): number | null {
  const m = script.match(/\[Target length:\s*([^\]]+)\]/i);
  if (!m) return null;
  const body = m[1];
  let seconds = 0;
  let found = false;
  const min = body.match(/(\d+(?:\.\d+)?)\s*min/i);
  if (min) { seconds += parseFloat(min[1]) * 60; found = true; }
  const sec = body.match(/(\d+(?:\.\d+)?)\s*sec/i);
  if (sec) { seconds += parseFloat(sec[1]); found = true; }
  return found && seconds > 0 ? Math.round(seconds) : null;
}

/** Reconciliation only fires once the total planned duration misses the
 *  target by more than this fraction — matching the same +20% discipline
 *  MAX_ADDED already applies to shot-count growth elsewhere in this file. */
const LENGTH_TOLERANCE = 0.2;

/**
 * How many shots the SCRIPT ITSELF explicitly enumerates, or 0 when it is
 * prose with no shot list. Drives both shot-list-preservation guards in
 * runBreakdown() — over-expansion (inventing content) and under-expansion
 * (silently dropping it).
 *
 * WAS a single inline regex, `/^\s*\d+\.\s+\S/gm`, which recognised ONLY a
 * plain "1. …" / "2. …" list. CONFIRMED REAL FAILURE, and the reason this is
 * now a function: a real 83-shot, 4-minute script written in the standard
 * industry form —
 *
 *     SHOT 1 — 0:00–0:03 BLACK SCREEN. No visual...
 *     SHOT 2 — 0:03–0:07 INT. MILITARY BUNKER — NIGHT...
 *
 * matched that regex ZERO times. explicitShots came back 0, both guards
 * require >= 2, so BOTH were skipped, and the breakdown quietly shipped 26
 * shots totalling 92 on-screen seconds against a 240-second target — losing
 * roughly two thirds of the film with no warning at any point. The
 * under-expansion guard directly below exists for exactly that failure and
 * never got the chance to fire.
 *
 * Takes the HIGHEST count across the recognised forms rather than summing
 * them: a script that writes "SHOT 1 —" headers AND numbers its scenes would
 * otherwise double-count and inflate the expected shot count. Each pattern
 * requires a digit bound to a shot-ish token, so ordinary prose (and
 * timecodes like "0:00–0:03") cannot register.
 */
export function countExplicitShots(script: string): number {
  const text = String(script || "");
  const counts = [
    // "SHOT 1 — ...", "SHOT 12: ...", "Shot 3 ..." at the start of a line.
    (text.match(/^\s*SHOT\s+\d+\b/gim) ?? []).length,
    // The same header mid-line, for scripts that run shots together in a
    // paragraph (common in exported/OCR'd documents, where the line breaks
    // between shots are lost but the "SHOT n" markers survive).
    (text.match(/\bSHOT\s+\d+\s*[—–\-:]/gi) ?? []).length,
    // The original plain numbered list, unchanged.
    (text.match(/^\s*\d+\.\s+\S/gm) ?? []).length,
  ];
  return Math.max(...counts);
}

/** For each pending action/staging inference, check the DURABLE store first
 *  (a rule inferred in an earlier run, possibly a different process, reused
 *  at zero LLM spend) and only fall back to a real inferActionRule()/
 *  inferStagingRule() call on a genuine miss, immediately persisting the
 *  result either way so every future run — this one included, via the
 *  in-memory cacheInferred*() call — skips the LLM call too. */
async function resolvePendingInferences(
  pendingActionInferences: { key: string; sceneContext: string }[],
  pendingStagingInferences: { key: string; sceneText: string }[],
): Promise<void> {
  // PARALLELIZED (2026-08-06) — CONFIRMED REAL: a real render with 17 pending
  // actions + 7 pending staging domains ran all 24 of these SEQUENTIALLY,
  // each paying its own full round-trip latency, as one real contributor to
  // a 15-20 minute total breakdown time. Each call is independent (a
  // different action/scene text, writing to its own cache key) — nothing
  // here depends on another item's result, unlike repairShots()'s batches
  // (see INFERENCE_CONCURRENCY's own comment for why THOSE stay sequential).
  if (pendingActionInferences.length) {
    console.log(`🔍 ${pendingActionInferences.length} action(s) not in the core library — checking persisted cache / inferring...`);
    await mapLimit(pendingActionInferences, INFERENCE_CONCURRENCY, async ({ key, sceneContext }) => {
      const persisted = await loadPersistedActionRule(key);
      if (persisted) {
        cacheInferredAction(key, persisted);
        console.log(`   💾 loaded persisted rule "${persisted.label}" (${persisted.category}) — no LLM call needed`);
        return;
      }
      const inferred = await inferActionRule(key, sceneContext);
      if (inferred) {
        const rule: ActionRule = { label: inferred.label, category: inferred.category, pattern: null, precondition: inferred.precondition, effect: inferred.effect };
        cacheInferredAction(key, rule);
        await persistActionRule(key, rule);
        console.log(`   🧠 inferred "${inferred.label}" (${inferred.category}) — persisted for future runs`);
      }
    });
  }

  if (pendingStagingInferences.length) {
    console.log(`🔍 ${pendingStagingInferences.length} scene(s) with an unrecognized domain — checking persisted cache / inferring staging rules...`);
    await mapLimit(pendingStagingInferences, INFERENCE_CONCURRENCY, async ({ key, sceneText }) => {
      const persisted = await loadPersistedStagingRule(key);
      if (persisted) {
        cacheInferredStaging(key, persisted);
        console.log(`   💾 loaded persisted staging rule "${persisted.label}" — no LLM call needed`);
        return;
      }
      const inferred = await inferStagingRule(sceneText);
      const rule = inferred ? inferredToStagingRule(inferred) : null;
      if (rule) {
        cacheInferredStaging(key, rule);
        await persistStagingRule(key, rule);
        console.log(`   🧠 inferred staging rule "${rule.label}" — persisted for future runs`);
      }
    });
  }
}

/** compileBreakdown() stays synchronous and just COLLECTS actions/staging
 *  domains matching neither the core library nor the (in-memory,
 *  process-lifetime) inference cache; this is where they actually get
 *  resolved, followed by ONE recompile so the newly-cached rules apply
 *  immediately — a WORLD_STATE_ACTION_CONTRADICTION or STAGING_RULE_
 *  VIOLATION this recompile surfaces is then eligible for the same repair
 *  attempt every other REPAIRABLE_WARN_CODES entry gets.
 *
 *  Every recompile anywhere in this file's pipeline — not just the first
 *  one — goes through this function, not a bare compileBreakdown() call.
 *  CONFIRMED REAL GAP this closes: a REPAIR round, the director's
 *  read-through, or the length-reconciliation pass can all introduce fresh
 *  shot text with its own not-yet-recognized action/staging domain, and
 *  every one of those recompiles used to destructure only
 *  `{ breakdown, issues }`, silently discarding any newly-generated pending
 *  inferences — so a domain first introduced by a LATER pass never got
 *  inference-checked at all, this render or any future one, and the
 *  deterministic core-library/cache checks it depends on kept silently
 *  skipping it forever. `src` is whatever object generated `raw`'s current
 *  content for compileBreakdown() to read (`raw` for most call sites, but
 *  `reviewed`/`reconciled` where a pass hands back a not-yet-assigned-to-raw
 *  revision) — the resolve-then-recompile MUST run against that exact same
 *  object, since the pending list was collected from calling
 *  compileBreakdown() on it in the first place. */
async function compileAndResolvePending(src: Breakdown, script: string): Promise<{ breakdown: Breakdown; issues: CompileIssue[] }> {
  let { breakdown, issues, pendingActionInferences, pendingStagingInferences } = compileBreakdown(src);
  printIssues(issues);
  if (pendingActionInferences.length || pendingStagingInferences.length) {
    await resolvePendingInferences(pendingActionInferences, pendingStagingInferences);
    ({ breakdown, issues } = compileBreakdown(src));
    printIssues(issues);
  }
  // SCRIPT COVERAGE — compileBreakdown() itself never sees the raw script (it
  // only validates the breakdown's own internal consistency), so this runs as
  // a separate pass after every recompile, same as every other check in this
  // function — a repair round can just as easily drop a dialogue line as the
  // original breakdown call can. See checkScriptDialogueCoverage()'s own
  // comment (compiler.ts) for what it catches and why.
  //
  // A TRANSLATED FILM USES THE COUNT-BASED VARIANT — the content match the
  // normal check performs cannot work across two languages (see
  // checkTranslatedDialogueCoverage()'s own comment for the full reasoning and
  // for the real Kannada run that proved a blanket skip here loses lines
  // silently).
  const dialogueIssues = isTranslated(breakdown.language)
    ? checkTranslatedDialogueCoverage(breakdown.shots, script)
    : checkScriptDialogueCoverage(breakdown.shots, script);
  if (dialogueIssues.length) {
    issues = [...issues, ...dialogueIssues];
    printIssues(dialogueIssues);
  }
  return { breakdown, issues };
}

/** `scriptOverride`, when given, is used directly instead of reading
 *  config.scriptPath off disk — see worker.ts's handleBreakdown(), which
 *  passes project.script this way. config.scriptPath is ONE hardcoded,
 *  shared path (unlike runtime.outDir, this one was never namespaced per
 *  job): two worker processes both handling a "breakdown" job at the same
 *  moment would each write their own project's script to that same file and
 *  then read whichever one landed last — silently building shot breakdowns
 *  from a completely different project's script, with no error at all. The
 *  CLI path (no override, isMain() below) is single-process/single-user by
 *  design and keeps reading from config.scriptPath exactly as before. */
export async function runBreakdown(scriptOverride?: string): Promise<Breakdown> {
  const out = `${runtime.outDir}/breakdown.json`;
  if (await fileExists(out)) {
    console.log("📖 Breakdown already exists (skipping). Delete output/breakdown.json to redo.");
    return readJsonOr<Breakdown>(out, { title: "", characters: [], shots: [], colorPalette: "", colorGradeFilter: "", domainPack: null, characterSceneStates: [], sceneDurations: [], props: [], language: DEFAULT_LANGUAGE });
  }

  let script = scriptOverride;
  if (script === undefined) {
    console.log(`📖 Reading script: ${config.scriptPath}`);
    script = await fs.readFile(config.scriptPath, "utf8");
  }

  // SPOKEN LANGUAGE — read from the script's "[Language: ...]" tag, the same
  // bracket-tag convention parseTargetSeconds() above already reads. No tag
  // (a bare script, the CLI path, or any project created before this feature)
  // means English, i.e. exactly the previous behaviour.
  const language = parseLanguage(script) ?? DEFAULT_LANGUAGE;
  if (isTranslated(language)) {
    console.log(`🗣  Spoken language: ${languageName(language)} — dialogue will be written and performed in ${languageName(language)}.`);
  }

  console.log("🧠 Directing: breaking the script into characters + shots...");
  let raw = await timedPhase("breakdownScript", () => breakdownScript(script, language, countExplicitShots(script)));

  // SHOT-LIST OVER-EXPANSION GUARD. Confirmed real failure: a script with an
  // explicit 3-shot numbered list came back as 9 base shots, inventing plot
  // content that was never written (a keys hand-off, a note, two mirror-
  // reflection compositions for a beat that should have been direct coverage)
  // — 3x the shots, each now billed at the full Veo "Quality" tier, is most of
  // how a 15-20s test render became a $50 charge that still didn't finish.
  // SYSTEM_PROMPT already says "at most ONE OR TWO added shots for the ENTIRE
  // film" when a script has its own numbered list, but that's a request, not
  // an enforcement — the LLM disobeys it a real, non-trivial fraction of the
  // time, the same "sampling problem, not a prompting one" reasoning the
  // repair loop below already exists for. This check runs BEFORE any paid
  // image/video work starts, so a miss here costs nothing but a text call.
  const explicitShots = countExplicitShots(script);
  if (explicitShots >= 2) {
    console.log(`🎬 Script enumerates ${explicitShots} shot(s) — shot-list preservation is ACTIVE for this film.`);
  }
  const ALLOWED_OVER = 2; // legitimate RULE-3B splits (one crammed shot -> two)
  if (explicitShots >= 2 && raw.shots.length > explicitShots * 2 + ALLOWED_OVER) {
    console.warn(
      `⚠️  Script listed ${explicitShots} numbered shot(s), breakdown produced ${raw.shots.length} — ` +
      `that's a shot-list-preservation violation, not a legitimate expansion. Retrying once with an explicit correction...`,
    );
    const corrected = await breakdownScript(
      `${script}\n\n` +
      `[SYSTEM CORRECTION — READ BEFORE PLANNING]\n` +
      `A previous attempt at this EXACT script produced ${raw.shots.length} shots for a script that explicitly ` +
      `numbers only ${explicitShots}. That attempt invented plot content and shots not written above — this is a ` +
      `violation of the shot-list-preservation rule, not creative expansion. This script's numbered list is the ` +
      `backbone of the film; you are not rewriting it. Produce a NEW breakdown with a shot count close to ` +
      `${explicitShots} (at most ${explicitShots + ALLOWED_OVER}, only for a genuine RULE 3 split of one crammed ` +
      `numbered beat into two shots — never for new content). Use ONLY what the numbered list above actually ` +
      `describes. Do not add a hand-off, an object, or a reflective-surface (mirror/glass) shot that isn't ` +
      `explicitly written above.`,
      // Same language as the first attempt — a retry that drops it would silently
      // re-plan the whole film in English (and reset Breakdown.language to the
      // "en" default), which is exactly what happened on the first real Kannada
      // test run before this argument was added.
      language,
      explicitShots,
    );
    console.log(`   ↻ retry produced ${corrected.shots.length} shot(s) (was ${raw.shots.length}).`);
    raw = corrected;
  }

  // SHOT-LIST UNDER-EXPANSION GUARD — the mirror image of the over-expansion
  // guard just above. Confirmed real failure, evidenced directly by real
  // script/shot pairs: a script with an explicit 8-item numbered list came
  // back as only 5 generated shots, silently dropping real content — in one
  // confirmed case, the entire final beat of the script (a phone call, with
  // its dialogue line) never appeared anywhere in the output, replaced by an
  // unrelated invented action. The over-expansion guard only ever checks the
  // direction "did it invent too much"; nothing previously checked "did it
  // drop too much" at all. Same asymmetric-risk reasoning as everywhere else
  // in this file: catching this before any paid image/video work starts costs
  // one text call; missing it means the finished film is silently incomplete.
  // Threshold is looser than the over-expansion guard's (which allows up to
  // 2x): RULE 3B splits only ever INCREASE shot count relative to the
  // numbered list, never decrease it, so a genuine drop below roughly 70% of
  // the numbered count is never a legitimate compression — it is lost content.
  const UNDER_EXPANSION_FLOOR = 0.7;
  if (explicitShots >= 2 && raw.shots.length < Math.floor(explicitShots * UNDER_EXPANSION_FLOOR)) {
    console.warn(
      `⚠️  Script listed ${explicitShots} numbered shot(s), breakdown produced only ${raw.shots.length} — ` +
      `that's a shot-list-preservation violation in the OTHER direction: real content is being dropped, not ` +
      `expanded. Retrying once with an explicit correction...`,
    );
    const corrected = await breakdownScript(
      `${script}\n\n` +
      `[SYSTEM CORRECTION — READ BEFORE PLANNING]\n` +
      `A previous attempt at this EXACT script produced only ${raw.shots.length} shots for a script that ` +
      `explicitly numbers ${explicitShots}. That attempt SILENTLY DROPPED real content from the numbered list — ` +
      `this is a shot-list-preservation violation, the same rule that forbids inventing content, just in the ` +
      `other direction. EVERY numbered beat in the script must appear as its own shot (or, per RULE 3B, be split ` +
      `across two shots if it is genuinely too much for one) — never merged away, never compressed into a later ` +
      `shot's "CONTINUITY" restatement instead of actually being shown, and never silently replaced with a ` +
      `different action the script didn't ask for. Pay special attention to the SCRIPT's final beat and any line ` +
      `of dialogue — both are exactly the content this failure mode drops most often. Produce a NEW breakdown ` +
      `with a shot count close to ${explicitShots} (at or above it, never meaningfully below).`,
      language,
      explicitShots, // see the retry above — neither may be dropped
    );
    console.log(`   ↻ retry produced ${corrected.shots.length} shot(s) (was ${raw.shots.length}).`);
    raw = corrected;
  }

  // CONTENT-INVENTION GUARD — runs for EVERY script, not just prose ones. WAS
  // gated `if (explicitShots < 2)` on the reasoning that the two shot-list-
  // preservation guards just above (over/under-expansion) already cover
  // scripts with a numbered list. CONFIRMED REAL GAP: those two guards only
  // ever compare the resulting shot COUNT against the script's numbered
  // count — they cannot tell whether the shots are the RIGHT ones. A real
  // 83-shot numbered script came back with 86 shots (well inside the
  // over-expansion guard's allowance) but one of them was a rearview-mirror
  // reflection shot that does not exist anywhere in the script, replacing
  // what should have been direct coverage of a written beat. A numbered list
  // constrains shot count, not shot content, so a script having one is not a
  // reason to skip this check — see checkScriptContentInvention()'s own
  // comment (llm.ts) for the full history including this failure. Runs
  // BEFORE any paid image/video work, same as the guards above.
  {
    const { invented, detail } = await timedPhase("checkScriptContentInvention", () => checkScriptContentInvention(script, raw.shots));
    if (invented) {
      console.warn(
        `⚠️  The breakdown invented content the script never wrote: ${detail} — retrying once with an explicit correction...`,
      );
      const corrected = await breakdownScript(
        `${script}\n\n` +
        `[SYSTEM CORRECTION — READ BEFORE PLANNING]\n` +
        `A previous attempt at this EXACT script invented content the script does not describe: ${detail}. ` +
        `This is a shot-list-preservation violation — every shot must trace back to something this script actually ` +
        `writes or clearly implies. Paraphrasing and reasonable connective/establishing shots are fine; inventing a ` +
        `new obstacle, action sequence, location, or object the script never wrote is not. Produce a NEW breakdown ` +
        `that stays faithful to exactly what is written above — do not add dramatic beats the script didn't ask for.`,
        language,
        explicitShots, // see the shot-count retry above — neither may be dropped
      );
      console.log(`   ↻ retry produced a breakdown with ${corrected.shots.length} shot(s) (was ${raw.shots.length}).`);
      raw = corrected;
    }
  }

  // ── MISSING CAST DESCRIPTION SOURCE ─────────────────────────────────────
  // CONFIRMED REAL: a script with no CHARACTERS: block (or equivalent
  // physical-description text) at all still produces a fully-formed
  // characters[] array — R0.6 in compiler.ts guarantees every character's
  // appearance opens with a sex+age word and states facial hair, so the
  // breakdown never fails structurally. But when the SCRIPT itself never
  // described a character, that appearance text is entirely INVENTED by the
  // LLM rather than sourced from the writer's own intent, which gives the
  // identity-lock system a materially weaker, more arbitrary anchor to hold
  // onto shot to shot. Confirmed real: of four otherwise-comparable test
  // scripts, the one with no CHARACTERS: block had by far the worst
  // character/gear consistency of the four. This can't be auto-repaired —
  // there's no missing information a retry could supply, since the script
  // itself never had it — so this is informational only, the same "surface
  // it, don't silently proceed" discipline a missing-reference-photo flag
  // elsewhere in this pipeline already uses.
  const hasCastBlock = /^\s*CHARACTERS\s*:/im.test(script);
  if (!hasCastBlock && raw.characters.length > 0) {
    console.warn(
      `⚠️  This script has no "CHARACTERS:" block (or equivalent) describing what ` +
      `${raw.characters.map((c) => c.name).join(", ")} actually look like — their appearance was entirely ` +
      `invented from context, not sourced from the script. This usually means weaker face/gear consistency ` +
      `across shots than a script with an explicit cast description. Consider adding a short CHARACTERS: block ` +
      `(age, build, distinguishing features per name) and re-running for better identity lock.`,
    );
  }

  // ── COMPILE → REPAIR → RECOMPILE ────────────────────────────────────────────
  // The compiler runs BEFORE step 2, and that ordering is the point: steps 2 and 3
  // generate look-options and a five-angle character sheet for EVERY character in
  // the cast. An earpiece VOICE parsed as a character means paying fal to build a
  // full character sheet for a body that does not exist — and step 4 then locks
  // that face into a keyframe. Cull him here, before the money leaves.
  //
  // And when the compiler REJECTS a shot, don't just die. The LLM splits a vault
  // into push-off + landing maybe half the time; that's a sampling problem, not a
  // prompting one, and no amount of shouting in the system prompt fixes it. So hand
  // the rejection straight back and make it fix that shot. One cheap LLM call
  // instead of a dead run. A director doesn't re-shoot the film because one setup
  // was wrong — they fix the setup.
  let { breakdown, issues } = await timedPhase("compile+resolve[initial]", () => compileAndResolvePending(raw, script));

  // THE REPAIR LOOP MUST NOT REWRITE THE FILM.
  //
  // Some repairs legitimately ADD a shot (a missing bridging beat, a completing
  // gesture). But every added shot creates new adjacencies, which trigger new
  // warnings, which add more shots. Left uncapped this ran away: a horror script
  // whose ending was "parents frozen, door creaks shut, exterior, text" came back
  // with four extra shots of the family walking out of the house — the ending was
  // gone, replaced by transitions the repair loop invented to satisfy its own
  // warnings. The script is the authority; repairs may mend shots, not reauthor
  // the story.
  const originalCount = breakdown.shots.length;
  const MAX_ADDED = Math.max(2, Math.ceil(originalCount * 0.2));   // +20%, floor of 2

  for (let round = 1; round <= MAX_REPAIRS; round++) {
    const blockers = blockingErrors(issues);
    // Fuzzy warns worth one rewrite too (a "hiding" beat, a dubious keyframe):
    // they never block the run, but a cheap LLM pass usually fixes them for real
    // — a static state becomes a break-from-cover action with two endpoints.
    const repairable = issues.filter((i) => !i.autofixed && REPAIRABLE_WARN_CODES.has(i.code));

    // Once the film has grown as far as it is allowed to, stop chasing warnings
    // that can only be fixed by ADDING shots. Blockers still get repaired —
    // those are structural and a shot literally cannot render without them.
    const grown = breakdown.shots.length - originalCount;
    const ADDITIVE = new Set([
      "NARRATIVE_GAP_NEEDS_TRANSITION", "ACTION_NEVER_COMPLETES", "THRESHOLD_NOT_CROSSED",
      "MISSING_HANDOFF_SHOT", "SCRIPT_DIALOGUE_LINE_DROPPED",
      // Now allowed to actually add its completing shot (see MAY_ADD_SHOTS's own
      // comment in llm.ts for the confirmed real failure this closes) — subject to
      // the same MAX_ADDED budget as every other add-eligible code here, so it
      // can't run away either.
      "POINTLESS_BUSINESS",
      // Same reasoning, same real failure class (see MAY_ADD_SHOTS's own comment
      // in llm.ts for the confirmed real render this closes) — a genuine
      // time-skip bridging beat is a real added shot, so it must respect the
      // same MAX_ADDED budget as every other add-eligible code here too.
      "TIME_OF_DAY_JUMP_NO_SKIP",
    ]);
    const allowed = grown >= MAX_ADDED ? repairable.filter((i) => !ADDITIVE.has(i.code)) : repairable;
    if (grown >= MAX_ADDED && allowed.length < repairable.length) {
      console.log(`   ⏸  shot count has grown by ${grown} (cap ${MAX_ADDED}) — no more added beats; the script's shape is preserved.`);
    }

    const targets = [...blockers, ...allowed];
    if (!targets.length) break;

    console.log(`🔁 ${targets.length} shot(s) need work (${blockers.length} blocking) — asking the director to fix them (round ${round}/${MAX_REPAIRS})...`);
    await timedPhase(`repairLoop[main round ${round}]`, async () => {
      // Character-level rejections (shotId "—" — APPEARANCE_MISSING_SEX_AGE_PREFIX/
      // FACIAL_HAIR) and shot-level rejections go through two different repair
      // calls, chained so neither overwrites the other's fix (see repairCharacters()'s
      // own comment for the confirmed bug this closes: repairShots() alone silently
      // dropped shotId "—" problems every round, so those two codes had NO repair
      // path at all and would permanently fail unconditionally).
      raw = await repairCharacters(breakdown, targets);
      raw = await repairShots(raw, targets);

      ({ breakdown, issues } = await compileAndResolvePending(raw, script));
    });
  }

  // DIRECTOR'S READ-THROUGH — a quality pass on top of an already-valid plan,
  // not a substitute for one. Only runs once the loop above has actually
  // produced a blocker-free shot list (reviewing an invalid plan would just
  // spend the extra call on a film that's about to be rejected anyway). See
  // directorReadThrough()'s own comment for what it catches that per-shot
  // compiler regex checks structurally cannot: motivation, sequence-level
  // pacing, geography that doesn't hold together as a whole. Any revision it
  // makes is recompiled and re-validated exactly like a fresh LLM shot would
  // be, including one more trip through the SAME repair loop if it happens to
  // introduce a new blocker.
  if (config.directorReviewEnabled && !blockingErrors(issues).length) {
    console.log("🎬 Director's read-through: reviewing the full sequence...");
    await timedPhase("directorReadThrough[total]", async () => {
      const reviewed = await directorReadThrough(breakdown);
      ({ breakdown, issues } = await compileAndResolvePending(reviewed, script));

      for (let round = 1; round <= MAX_REPAIRS && blockingErrors(issues).length; round++) {
        const readThroughBlockers = blockingErrors(issues);
        console.log(`🔁 the read-through's own revisions need ${readThroughBlockers.length} fix(es) — repairing (round ${round}/${MAX_REPAIRS})...`);
        raw = await repairCharacters(breakdown, readThroughBlockers);
        raw = await repairShots(raw, readThroughBlockers);
        ({ breakdown, issues } = await compileAndResolvePending(raw, script));
      }
    });
  }

  // ── LENGTH RECONCILIATION ─────────────────────────────────────────────────
  // Nothing above this point ever checks the TOTAL planned duration against
  // what was actually requested — shot count is only ever a soft instruction
  // to the director (see the SHOTS section of the system prompt), and every
  // per-shot duration is capped independently of the film's overall length.
  // Runs on the FINAL shot list, once, only when a real target was requested
  // (the script carries a "[Target length: ...]" marker) AND the plan missed
  // it by more than LENGTH_TOLERANCE — a bounded, single correction pass,
  // never a loop chasing an exact number an LLM cannot guarantee anyway.
  const targetSeconds = parseTargetSeconds(script);
  if (targetSeconds && !blockingErrors(issues).length) {
    // ON-SCREEN runtime, not render cost: a shot trimmed down for a rapid
    // hard cut (see Shot.screenSeconds) is rendered at Seedance's 4s floor
    // but only screenSeconds of it actually appears in the final film — the
    // film's real length is what the viewer sees, not what got paid for.
    // screenSeconds is always populated (compileBreakdown() sets it equal to
    // duration whenever no trim applies), so this sum is correct for every
    // shot whether or not it's trimmed.
    const actualSeconds = breakdown.shots.reduce((n, s) => n + (s.screenSeconds || s.duration), 0);
    const gap = Math.abs(actualSeconds - targetSeconds) / targetSeconds;
    if (gap > LENGTH_TOLERANCE) {
      console.log(
        `⏱  Planned ${actualSeconds}s vs. a ${targetSeconds}s target (${(gap * 100).toFixed(0)}% off) — reconciling length...`,
      );
      // ITERATES NOW, INSTEAD OF ONE PASS AND SHIP.
      //
      // This used to call reconcileLength() exactly once and then print how far
      // off it still was — "shipping as-is, one pass only" — no matter how bad
      // the miss. CONFIRMED REAL FAILURE: a 4-minute (240s) script planned 92
      // on-screen seconds, reconciliation ran its single pass, and the film
      // shipped at 1:32 against a 4:00 target, 62% short. Printing the number
      // and continuing is not reconciling; the user asked for a four-minute
      // film and got a third of one.
      //
      // Bounded on THREE separate conditions so this can never become an
      // expensive spin: a hard pass cap, the tolerance being met, and — the
      // important one — a NO-PROGRESS bail. If a pass fails to close the gap by
      // a meaningful amount, another pass asking the same model the same
      // question will not do better, so it stops rather than paying for
      // identical answers (the same reasoning image.ts's transient-vs-permanent
      // split applies to retries).
      const MAX_LENGTH_PASSES = 3;
      const MIN_GAP_IMPROVEMENT = 0.05; // 5 percentage points of the target
      await timedPhase("reconcileLength[total]", async () => {
        let currentSeconds = actualSeconds;
        let currentGap = gap;
        for (let pass = 1; pass <= MAX_LENGTH_PASSES; pass++) {
          const reconciled = await reconcileLength(breakdown, targetSeconds, currentSeconds);
          ({ breakdown, issues } = await compileAndResolvePending(reconciled, script));

          for (let round = 1; round <= MAX_REPAIRS && blockingErrors(issues).length; round++) {
            const lengthBlockers = blockingErrors(issues);
            console.log(`🔁 the length pass's own revisions need ${lengthBlockers.length} fix(es) — repairing (round ${round}/${MAX_REPAIRS})...`);
            raw = await repairCharacters(breakdown, lengthBlockers);
            raw = await repairShots(raw, lengthBlockers);
            ({ breakdown, issues } = await compileAndResolvePending(raw, script));
          }

          const passSeconds = breakdown.shots.reduce((n, s) => n + (s.screenSeconds || s.duration), 0);
          const passGap = Math.abs(passSeconds - targetSeconds) / targetSeconds;
          console.log(
            `⏱  length pass ${pass}/${MAX_LENGTH_PASSES}: ${currentSeconds}s → ${passSeconds}s ` +
            `(target ${targetSeconds}s, now ${(passGap * 100).toFixed(0)}% off)`,
          );

          if (passGap <= LENGTH_TOLERANCE) {
            currentSeconds = passSeconds;
            break;
          }
          if (currentGap - passGap < MIN_GAP_IMPROVEMENT) {
            console.log(
              `⏱  that pass moved the gap by less than ${(MIN_GAP_IMPROVEMENT * 100).toFixed(0)} points — ` +
              `further passes would just re-ask the same question. Stopping here.`,
            );
            currentSeconds = passSeconds;
            break;
          }
          currentSeconds = passSeconds;
          currentGap = passGap;
        }
      });

      const newActual = breakdown.shots.reduce((n, s) => n + (s.screenSeconds || s.duration), 0);
      const newGap = Math.abs(newActual - targetSeconds) / targetSeconds;
      console.log(
        `⏱  After reconciliation: ${newActual}s vs. a ${targetSeconds}s target` +
        (newGap > LENGTH_TOLERANCE
          ? ` — STILL ${(newGap * 100).toFixed(0)}% OFF after ${MAX_LENGTH_PASSES} pass(es). The finished film will be ` +
            `about ${Math.floor(newActual / 60)}:${String(newActual % 60).padStart(2, "0")} rather than ` +
            `${Math.floor(targetSeconds / 60)}:${String(targetSeconds % 60).padStart(2, "0")}.`
          : " (within tolerance)."),
      );
    }
  }

  // ── LAST-RESORT ENDFRAME RESCUE ──────────────────────────────────────────
  // STATE_CHANGE_NEEDS_ENDFRAME is a real structural blocker and the repair LLM
  // is still the primary way it gets fixed — every repair round above ran first.
  // But when those rounds fail, throwing is wildly disproportionate: the throw
  // below happens BEFORE the project row is written, so the whole breakdown is
  // discarded. CONFIRMED TWICE in this project's own job history — "1 shot(s)
  // still cannot be rendered ... [shot_31a] STATE_CHANGE_NEEDS_ENDFRAME" with
  // breakdownJson NOT SAVED. An 83-shot film and half an hour of LLM spend,
  // deleted over one missing sentence on one shot, with nothing the user could
  // act on except "simplify the action".
  //
  // This is also the failure mode the compiler's own notes describe as an
  // unstable flip-flop between FLF_NOT_NEEDED stripping an endFrame and this
  // rule demanding one back — a loop that can burn the entire repair budget
  // without ever converging, no matter how well the script is written. That is
  // not something a user can fix by editing their script.
  //
  // So: for THIS code only, synthesize a deterministic endFrame from the shot's
  // own text (synthesizeEndFrame(), which reuses distillEndState()) and
  // recompile. Same principle as ENTRANCE_ENDPOINTS_AUTOFILLED (Gap G) — where
  // the compiler can write a defensibly correct endpoint itself, shipping a
  // slightly-less-than-ideal frame beats discarding the film. Every OTHER
  // blocking code still throws exactly as before: this narrows what is fatal,
  // it does not stop anything from being fatal.
  {
    let blockers = blockingErrors(issues);
    const rescuable = blockers.filter((b) => b.code === "STATE_CHANGE_NEEDS_ENDFRAME");
    if (rescuable.length && rescuable.length === blockers.length) {
      console.warn(
        `🛟 ${rescuable.length} shot(s) still lack an endFrame after ${MAX_REPAIRS} repair round(s) ` +
        `(${rescuable.map((b) => b.shotId).join(", ")}). Rather than discarding the whole breakdown, ` +
        `writing a deterministic endFrame for each from the shot's own action text.`,
      );
      const rescueIds = new Set(rescuable.map((b) => b.shotId));
      const patched = {
        ...breakdown,
        shots: breakdown.shots.map((s) =>
          rescueIds.has(s.id) && !s.endFrame?.trim() ? { ...s, endFrame: synthesizeEndFrame(s) } : s,
        ),
      };
      ({ breakdown, issues } = await compileAndResolvePending(patched, script));
      blockers = blockingErrors(issues);
      console.log(
        blockers.length
          ? `🛟 rescue left ${blockers.length} blocker(s) — failing as before.`
          : `🛟 rescue succeeded — every shot is renderable. Review these shots' end frames in the shot list.`,
      );
    }
  }

  const blockers = blockingErrors(issues);
  if (blockers.length) {
    throw new Error(
      `${blockers.length} shot(s) still cannot be rendered after repair attempts. ` +
      `Nothing has been spent. Simplify the action in the script, or regenerate these shots by hand:\n` +
      blockers.map((b) => `  • [${b.shotId}] ${b.code}`).join("\n"),
    );
  }

  // PRIORITY 4 — DIRECTORIAL JUDGMENT LAYER (shot variety/pacing). Runs on
  // the TRULY FINAL shot list (after length reconciliation may have added
  // or removed shots). checkShotVariety() detects; reviseShotVariety() now
  // actually fixes what it finds (camera/motion/duration only — see its own
  // comment for why that's narrow on purpose), instead of leaving findings
  // as a report nobody acts on. Gated on the SAME config.directorReviewEnabled
  // flag as the read-through above — same LLM-judgment tier, same "skip this
  // extra call" opt-out. Never blocks the render: a judgment-tier finding
  // that can't be cleanly fixed is logged and shipped as-is, not fatal.
  if (config.directorReviewEnabled) {
    try {
      await timedPhase("shotVariety[total]", async () => {
        const varietyFindings = await checkShotVariety(breakdown);
        if (varietyFindings.length) {
          console.log(`🎬 Shot-variety review: ${varietyFindings.length} scene(s) flagged for directorial review:`);
          for (const f of varietyFindings) {
            console.log(`   ⚠️  scene "${f.scene}" [${f.shotIds.join(", ")}] — ${f.issue}: ${f.detail}`);
          }
          await writeJson(`${runtime.outDir}/shot-variety-review.json`, varietyFindings);

          const revised = await reviseShotVariety(breakdown, varietyFindings);
          ({ breakdown, issues } = await compileAndResolvePending(revised, script));

          for (let round = 1; round <= MAX_REPAIRS && blockingErrors(issues).length; round++) {
            const varietyBlockers = blockingErrors(issues);
            console.log(`🔁 the shot-variety revision's own changes need ${varietyBlockers.length} fix(es) — repairing (round ${round}/${MAX_REPAIRS})...`);
            raw = await repairCharacters(breakdown, varietyBlockers);
            raw = await repairShots(raw, varietyBlockers);
            ({ breakdown, issues } = await compileAndResolvePending(raw, script));
          }
        } else {
          console.log("🎬 Shot-variety review: no directorial concerns flagged.");
        }
      });
    } catch (e) {
      console.warn(`   ⚠️  shot-variety review failed (${(e as Error)?.message}) — skipping it for this render, never blocking.`);
    }
  }

  {
    const blockers = blockingErrors(issues);
    if (blockers.length) {
      throw new Error(
        `${blockers.length} shot(s) still cannot be rendered after the shot-variety revision's own repair attempts. ` +
        `Nothing extra has been spent beyond the text calls above:\n` +
        blockers.map((b) => `  • [${b.shotId}] ${b.code}`).join("\n"),
      );
    }
  }

  // FINAL CONTENT-INVENTION CHECK — the guard earlier in this file only ever
  // inspects the FIRST draft, straight out of breakdownScript(). Everything
  // between there and here (the repair loop, the director's read-through,
  // length reconciliation, the shot-variety revision) rewrites or adds shots
  // of its own, and every one of those passes is itself capable of
  // introducing content the script never wrote — this file's own repair-loop
  // comment already documents a CONFIRMED case of exactly that ("parents
  // frozen, door creaks shut" replaced by four invented shots of the family
  // walking out of the house). So this runs a SECOND time, on the truly
  // final shot list, right before it ships. Unlike the first guard (which
  // discards the whole draft and asks for a fresh one), this targets ONLY
  // the flagged shot(s) through the same repairShots() mechanism every other
  // rejection in this pipeline already goes through — cheaper, and it can't
  // undo any of the legitimate fixes every earlier pass already made.
  try {
    await timedPhase("checkScriptContentInvention[final]", async () => {
      const { invented, shotIds, detail } = await checkScriptContentInvention(script, breakdown.shots);
      if (!invented || !shotIds.length) {
        console.log("🎬 Final script-fidelity check: no invented content flagged.");
        return;
      }
      console.warn(`⚠️  Final script-fidelity check: ${detail} — repairing the flagged shot(s) (${shotIds.join(", ")})...`);
      const targets = shotIds.map((shotId) => ({ shotId, code: "CONTENT_INVENTION_NOT_IN_SCRIPT", detail }));
      raw = await repairShots(breakdown, targets);
      ({ breakdown, issues } = await compileAndResolvePending(raw, script));

      for (let round = 1; round <= MAX_REPAIRS && blockingErrors(issues).length; round++) {
        const inventionBlockers = blockingErrors(issues);
        console.log(`🔁 the content-fidelity repair's own changes need ${inventionBlockers.length} fix(es) — repairing (round ${round}/${MAX_REPAIRS})...`);
        raw = await repairCharacters(breakdown, inventionBlockers);
        raw = await repairShots(raw, inventionBlockers);
        ({ breakdown, issues } = await compileAndResolvePending(raw, script));
      }
    });
  } catch (e) {
    console.warn(`   ⚠️  final script-fidelity check failed (${(e as Error)?.message}) — skipping it for this render, never blocking.`);
  }

  {
    const blockers = blockingErrors(issues);
    if (blockers.length) {
      throw new Error(
        `${blockers.length} shot(s) still cannot be rendered after the content-fidelity repair's own attempts. ` +
        `Nothing extra has been spent beyond the text calls above:\n` +
        blockers.map((b) => `  • [${b.shotId}] ${b.code}`).join("\n"),
      );
    }
  }

  await writeJson(out, breakdown);

  const flf = breakdown.shots.filter((s) => s.method === "flf").length;
  const secs = breakdown.shots.reduce((n, s) => n + (s.screenSeconds || s.duration), 0);
  console.log(
    `✅ "${breakdown.title}" — ${breakdown.characters.length} character(s), ` +
    `${breakdown.shots.length} shot(s), ${flf} interpolated, ~${secs}s total.`,
  );

  // TEMPORARY — see timedPhase()'s own comment for why this exists. Sorted
  // by duration so the real bottleneck is immediately visible, not buried in
  // the middle of a scroll of per-phase lines.
  const totalPhaseSec = phaseLog.reduce((n, p) => n + p.sec, 0);
  console.log(`\n⏱  PHASE TIMING BREAKDOWN (total ${totalPhaseSec.toFixed(1)}s):`);
  for (const p of [...phaseLog].sort((a, b) => b.sec - a.sec)) {
    console.log(`   ${p.sec.toFixed(1)}s (${((p.sec / totalPhaseSec) * 100).toFixed(0)}%)  ${p.label}`);
  }

  // READABLE TIMECODED SHOT LIST — compileBreakdown() already computed
  // timecodeStart/timecodeEnd for every shot (see Shot.timecodeStart's own
  // comment in types.ts); this just makes that running timeline visible
  // before any money is spent rendering it, in the "00:00-00:04 ... " form
  // a real shot list is reviewed in.
  console.log(`\n🎬 Shot list:`);
  for (const s of breakdown.shots) {
    const trimmed = s.screenSeconds > 0 && s.screenSeconds < s.duration;
    const tag = trimmed ? ` (rendered ${s.duration}s, trimmed to ${s.screenSeconds}s)` : "";
    console.log(`   ${s.timecodeStart}–${s.timecodeEnd}  [${s.id}] ${s.description.slice(0, 90)}${s.description.length > 90 ? "…" : ""}${tag}`);
  }

  return breakdown;
}

if (isMain(import.meta.url)) {
  runBreakdown().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}