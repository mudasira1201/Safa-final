import { config, runtime } from "./config";
import { ensureDir } from "./util";
import { runBreakdown } from "./steps/1-breakdown";
import { runOptions } from "./steps/2-options";
import { runSheet } from "./steps/3-sheet";
import { runPropSheet } from "./steps/3b-props";
import { runImages } from "./steps/4-images";
import { runVideos } from "./steps/5-videos";
import { runAssemble } from "./steps/6-assemble";

async function main() {
  console.log("\n🎬  AI FILM PRO\n" + "=".repeat(40));
  console.log(`Script:   ${config.scriptPath}`);
  console.log(`Images:   ${config.imageEditModel}`);
  console.log(`Video:    ${config.videoModel} @ ${config.videoResolution}`);
  console.log("\n⚠️  Paid AI APIs. Already-generated steps are cached and skipped (no re-charge).\n");

  await ensureDir(runtime.outDir);
  const t0 = Date.now();

  const breakdown = await runBreakdown();
  await runOptions(); // generates options the first time; reuses your selection after
  await runSheet();   // builds the 5-angle character sheet from your chosen option
  // CONFIRMED REAL GAP, FIXED: the production worker (worker.ts) always builds
  // the prop reference sheet before keyframes; this local CLI skipped it
  // entirely. 4-images.ts degrades gracefully with no props.json (readJsonOr),
  // so it didn't crash — it just silently rendered zero prop-anchoring for any
  // script with story-significant props when run locally.
  await runPropSheet(breakdown); // prop reference sheet (Gap A) — same anchoring 3-sheet.ts gives characters
  await runImages();  // per-shot keyframes locked to the sheet
  await runVideos();  // Seedance 1.5 Pro animation (see config.videoResolution)
  const finalPath = await runAssemble();

  console.log(`⏱  Total: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`📁 ${finalPath}`);
}

main().catch((e) => {
  console.error("\n❌ Pipeline failed:\n", e?.message || e);
  process.exit(1);
});
