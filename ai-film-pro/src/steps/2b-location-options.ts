import { config, runtime } from "../config";
import { generateImages } from "../providers/image";
import { readJson, writeJson, downloadToFile, fileExists, isMain } from "../util";
import { runBreakdown } from "./1-breakdown";
import { logSpend, costOfImages } from "../spend";
import { authoredOnly } from "../lib/compiler";
import { mapLimit, CONCURRENCY } from "../concurrency";
import type { Breakdown, LocationSelections, Shot } from "../types";

/**
 * Location casting, same treatment 2-options.ts already gives characters —
 * a few independent DESIGN variations (not camera angles) for the user to
 * pick from, before any generation, on the same early screen as character
 * casting. Deliberately EVERY distinct location in the film, not filtered to
 * "genuinely revisited" the way 3c-locations.ts's runLocationSheet() is —
 * that gate exists for a different question (does this place need a locked
 * multi-angle geometry reference for a later revisit?), not "does the user
 * get to see and choose a look for it at all." Confirmed real gap this
 * fixes: most short scripts never revisit a location, so most projects
 * previously got ZERO location images of any kind.
 */
// `mustFeature`: optional user-requested scenery (ad mode's regenerate note,
// passed through by worker.ts's handleOptions). The note already lives inside
// each shot's setting as plain scene text, but buried mid-prompt the image
// model treats it as optional set dressing and often drops it entirely —
// confirmed live: "roses and lilies" in the setting text still produced
// deserts and lighthouses. Stating it again as an explicit, non-negotiable
// requirement is what actually makes it land.
// `optionsCount`: optional per-call override of config.locationOptionsCount —
// ad mode passes 3 (one backdrop, three looks, UGC style); films keep the
// config default.
export async function runLocationOptions(projectId = "local", userId?: string, mustFeature?: string, optionsCount?: number): Promise<LocationSelections> {
  const sel = `${runtime.outDir}/location-selections.json`;
  if (await fileExists(sel)) {
    console.log(
      "🏛️  Location options already generated (skipping).\n" +
        "   → Open output/locations/options/ and pick your favorite for each location,\n" +
        "   → set its number in output/location-selections.json (the \"chosen\" field), then run `npm run film`.\n" +
        "   (Delete output/location-selections.json to regenerate options.)"
    );
    return readJson<LocationSelections>(sel);
  }

  // Make sure the breakdown exists first (it's cached, so this is a no-op if already done).
  await runBreakdown();

  const breakdown = await readJson<Breakdown>(`${runtime.outDir}/breakdown.json`);
  const shots = breakdown.shots ?? [];

  // Group EVERY shot with a locationId, not just revisited runs — see the
  // module comment above for why this differs from 3c-locations.ts's own
  // grouping (which then filters down to revisited-only for its own,
  // different purpose).
  const byId = new Map<string, Shot[]>();
  for (const s of shots) {
    if (!s.locationId) continue;
    const group = byId.get(s.locationId);
    if (group) group.push(s);
    else byId.set(s.locationId, [s]);
  }

  const selections: LocationSelections = {};
  const totalLocations = byId.size;
  let locsDone = 0;

  // PARALLEL ACROSS LOCATIONS. Each location's look-options are completely
  // independent — a different prompt, its own output folder, its own entry in
  // `selections` (keyed by locationId, so arrival order is irrelevant). Running
  // them one at a time meant a film with four locations paid four full image
  // round-trips back to back for no reason; this is the same mapLimit/CONCURRENCY
  // treatment the video pass already uses. Total provider cost is unchanged —
  // the same number of calls, just more in flight.
  //
  // NOT the same as 4-images.ts's keyframe pass, which stays deliberately
  // sequential because each keyframe references the previous shot's result for
  // cross-shot continuity. Nothing here reads another location's output.
  await mapLimit([...byId.entries()], CONCURRENCY, async ([locationId, group]) => {
    // Same "richest setting text" pick 3c-locations.ts uses — the fullest
    // spatial description authored anywhere across this location's shots,
    // not just whichever shot happens to be first.
    const richest = group.reduce((best, s) => (authoredOnly(s.setting || "").length > authoredOnly(best.setting || "").length ? s : best), group[0]);
    const richText = authoredOnly(richest.setting || "").trim() || richest.scene || locationId;
    // Card name from the PRISTINE setting when a regenerate note has been
    // folded into `setting` (ad mode keeps the original in baseSetting) —
    // otherwise the user's note text leaks into the UI title of every
    // location card.
    const baseText = authoredOnly((richest as any).baseSetting || "").trim();
    const name = (baseText || richText).slice(0, 60);
    const count = optionsCount ?? config.locationOptionsCount;
    // Counts COMPLETIONS now, not starts — with several in flight, a "(1/4)"
    // printed at start time would be meaningless.
    const emphasis = (mustFeature || "").trim()
      ? `The scene MUST clearly and prominently show: ${mustFeature!.trim()}. This is the client's explicit requirement — it is the defining feature of the image, not background detail. `
      : "";
    const prompt =
      `Wide establishing photograph of this location, photorealistic, shot on 35mm film, natural lighting and ` +
      `texture. ${richText}. ${emphasis}Showing the full space and its key fixed landmarks, no people. NOT cartoon, NOT 3D render.`;
    const urls = await generateImages(prompt, count, "16:9");
    await logSpend("image", { userId, projectId, units: urls.length, amountUsd: costOfImages(urls.length) });
    let n = 0;
    for (const url of urls) {
      n++;
      await downloadToFile(url, `${runtime.outDir}/locations/options/${locationId}/opt-${n}.png`);
    }
    selections[locationId] = { name, chosen: 1, options: urls };
    locsDone++;
    console.log(`🏛️  ${count} look-options ready for "${name}" (${locsDone}/${totalLocations})`);
  });

  await writeJson(sel, selections);
  if (totalLocations) {
    console.log(
      `\n✅ Location options ready in output/locations/options/.\n` +
        `   → Look at them, then set the winning number per location in output/location-selections.json ("chosen").\n` +
        `   → Then run \`npm run film\` to build the film. (Defaults to option 1 if you skip this.)`
    );
  }
  return selections;
}

if (isMain(import.meta.url)) {
  runLocationOptions().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
