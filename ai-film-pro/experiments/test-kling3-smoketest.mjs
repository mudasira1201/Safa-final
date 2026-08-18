// experiments/test-kling3-smoketest.mjs
// -----------------------------------------------------------------------------
// STANDALONE. Does not import anything from src/ and does not touch config.ts,
// video.ts, or any provider this pipeline actually uses. Real smoke test:
// Kling 3.0 (standard tier, fal.ai) against a real character reference image
// from "The Package" and a real shot description from the actual script --
// directly comparable to what Seedance 1.5 Pro produced for the same beat,
// not an abstract test prompt. Uses the SAME FAL_KEY already configured for
// this project -- Kling 3.0 is hosted on fal.ai too, no new credential needed.
//
// Real, confirmed schema (fal.ai's own docs, not guessed): image_url,
// end_image_url (optional), duration (3-15s), prompt, generate_audio.
// -----------------------------------------------------------------------------
import "dotenv/config";
import { fal } from "@fal-ai/client";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) { console.error("No FAL_KEY in environment/.env."); process.exit(1); }
fal.config({ credentials: FAL_KEY });

const IMAGE_URL = "https://pub-3a4f58d716dc4abba5e4950dd3c2d7df.r2.dev/projects/cmsenkfik000157sac5vbsn20/options/arjun/opt-1.png";

const PROMPT =
  "Arjun walks forward at a natural pace along a bustling pedestrian-only market footpath, weaving between " +
  "market stalls with striped awnings on both sides, passing a weathered brass fountain, a crowd of distinct " +
  "people moving in the background. His arms swing naturally as he walks, eyes scanning the crowd with a wary " +
  "expression. Cinematic photorealistic video, natural daylight, camera tracking alongside him.";

async function main() {
  console.log("Submitting to fal-ai/kling-video/v3/standard/image-to-video (walking motion, 16:9)...");
  try {
    const result = await fal.subscribe("fal-ai/kling-video/v3/standard/image-to-video", {
      input: {
        image_url: IMAGE_URL,
        prompt: PROMPT,
        duration: "5",
        aspect_ratio: "16:9",
        generate_audio: false,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") (update.logs ?? []).forEach((l) => console.log(`   ${l.message}`));
      },
    });
    console.log("\nRAW RESULT:", JSON.stringify(result.data ?? result, null, 2));
  } catch (e) {
    console.error("\nFAILED:", JSON.stringify(e?.body ?? e?.message ?? e, null, 2));
    process.exit(1);
  }
}
main();
