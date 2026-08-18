// experiments/test-minimax-music-v2-smoketest.mjs
// -----------------------------------------------------------------------------
// STANDALONE. Does not import anything from src/ and does not touch config.ts
// or any provider this pipeline actually uses yet. Real smoke test for the
// "AI Song Videos" feature (Phase 1 of the plan): fal-ai/minimax-music/v2,
// a vocal song generator (lyrics + music), NOT the existing instrumental-only
// music.ts provider (cassetteai/music-generator). Uses the SAME FAL_KEY
// already configured for this project -- MiniMax Music is hosted on fal.ai
// too, no new credential needed.
//
// Field names below are from fal.ai's own published example payload (web
// search, 2026-08-05) -- NOT independently confirmed via the docs page
// itself (fal.ai's docs pages 429 rate-limited both WebFetch attempts this
// session, same as they did for Kling's docs earlier). This is exactly the
// "let a wrong guess surface in the real error" situation every other
// provider integration in this codebase has already handled the same way --
// this call's own response/error is the real confirmation, not the guess.
// -----------------------------------------------------------------------------
import "dotenv/config";
import { fal } from "@fal-ai/client";
import { writeFileSync } from "node:fs";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) { console.error("No FAL_KEY in environment/.env."); process.exit(1); }
fal.config({ credentials: FAL_KEY });

const STYLE_PROMPT = "Uplifting indie pop, warm acoustic guitar, hopeful, driving mid-tempo, female lead vocal";

const LYRICS_PROMPT =
  "[verse]Woke up to a golden light spilling through the blinds\n" +
  "Packed my whole world into a bag I left behind\n" +
  "[chorus]I'm going, I'm going, further than before\n" +
  "Every road unknown is a road worth walking for\n" +
  "[verse]City lights are fading in the mirror of my mind\n" +
  "Every mile behind me is a page I leave to time\n" +
  "[chorus]I'm going, I'm going, further than before\n" +
  "Every road unknown is a road worth walking for\n" +
  "[outro]Further than before";

async function main() {
  console.log("Submitting to fal-ai/minimax-music/v2 (vocal song, lyrics + style)...");
  try {
    const result = await fal.subscribe("fal-ai/minimax-music/v2", {
      input: {
        prompt: STYLE_PROMPT,
        lyrics_prompt: LYRICS_PROMPT,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") (update.logs ?? []).forEach((l) => console.log(`   ${l.message}`));
      },
    });
    console.log("\nRAW RESULT:", JSON.stringify(result.data ?? result, null, 2));
    writeFileSync(
      new URL("./minimax-music-v2-result.json", import.meta.url),
      JSON.stringify(result.data ?? result, null, 2),
    );
    console.log("\nSaved raw result to experiments/minimax-music-v2-result.json");
  } catch (e) {
    console.error("\nFAILED:", JSON.stringify(e?.body ?? e?.response?.data ?? e?.message ?? e, null, 2));
    process.exit(1);
  }
}
main();
