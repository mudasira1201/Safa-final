// experiments/test-runway-gen4-turbo.mjs
// -----------------------------------------------------------------------------
// STANDALONE. Does not import anything from src/ and does not touch config.ts,
// video.ts, or any provider this pipeline actually uses. Purely a smoke test to
// answer two questions before any real integration work happens:
//   1. Does Gen-4 Turbo hold character identity well from a single reference
//      image (the thing every keyframe->clip render in this pipeline depends on)?
//   2. Does it genuinely support first+last-frame (FLF) conditioning the way
//      Seedance's end_image_url does (the thing method:"flf" shots depend on)?
//
// SETUP:
//   1. export RUNWAY_API_KEY=your_key_here   (or set it in your shell/.env —
//      this script reads it from process.env, never hardcode it here)
//   2. Fill in TEST_IMAGE_SINGLE and TEST_IMAGE_START/TEST_IMAGE_END below with
//      real URLs from your own R2 bucket (an existing character angle-1.png,
//      and a startFrame/endFrame keyframe pair from a real two-endpoint shot).
//   3. node experiments/test-runway-gen4-turbo.mjs
//
// UNVERIFIED, STATED HONESTLY (same discipline as this codebase's own provider
// integrations): the model identifier "gen4_turbo" is inferred from several
// third-party resellers that all use it consistently, but was not confirmed
// against Runway's own direct API docs. If this is wrong, Runway's own error
// response will very likely say so directly -- read it, don't guess again.
// -----------------------------------------------------------------------------

const API_KEY = process.env.RUNWAY_API_KEY;
if (!API_KEY) {
  console.error("❌ Set RUNWAY_API_KEY in your environment first.");
  process.exit(1);
}

// ---- FILL THESE IN with real URLs from your own R2 bucket ------------------
const TEST_IMAGE_SINGLE = ""; // e.g. a character's angle-1.png (front-facing casting photo)
const TEST_IMAGE_START = "";  // e.g. a real shot's startFrame keyframe
const TEST_IMAGE_END = "";    // e.g. that SAME shot's endFrame keyframe

const API_BASE = "https://api.dev.runwayml.com/v1";
const HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  "X-Runway-Version": "2024-11-06",
};

async function createTask(promptImage, promptText, label) {
  const body = {
    model: "gen4_turbo", // UNVERIFIED — see header comment
    promptImage,
    promptText,
    ratio: "1280:720",
    duration: 5,
  };
  console.log(`\n▶ ${label}: submitting...`);
  const res = await fetch(`${API_BASE}/image_to_video`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`❌ ${label} failed (${res.status}):`, JSON.stringify(json, null, 2));
    return null;
  }
  console.log(`   task id: ${json.id}`);
  return json.id;
}

async function pollTask(id, label) {
  // UNVERIFIED polling path -- if this 404s, check Runway's real docs for the
  // correct task-retrieval endpoint and fix this one line. Same "let the real
  // error tell you" discipline as everywhere else here.
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${API_BASE}/tasks/${id}`, { headers: HEADERS });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`❌ ${label}: poll failed (${res.status}):`, JSON.stringify(json, null, 2));
      return null;
    }
    if (json.status === "SUCCEEDED") {
      console.log(`✅ ${label}: done -> ${json.output?.[0]}`);
      return json.output?.[0] ?? null;
    }
    if (json.status === "FAILED") {
      console.error(`❌ ${label}: generation failed:`, JSON.stringify(json, null, 2));
      return null;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error(`\n⚠️  ${label}: gave up polling after 5 minutes.`);
  return null;
}

async function run() {
  if (!TEST_IMAGE_SINGLE && !(TEST_IMAGE_START && TEST_IMAGE_END)) {
    console.error("❌ Fill in TEST_IMAGE_SINGLE and/or TEST_IMAGE_START + TEST_IMAGE_END at the top of this file first.");
    process.exit(1);
  }

  // TEST 1 — single reference image, plain i2v. Does the face/identity hold?
  if (TEST_IMAGE_SINGLE) {
    const id = await createTask(
      TEST_IMAGE_SINGLE,
      "The person turns their head slightly and speaks, natural expression, camera holds steady.",
      "TEST 1 (identity consistency, single frame)",
    );
    if (id) await pollTask(id, "TEST 1");
  }

  // TEST 2 — first+last frame. Does the model actually interpolate between
  // your two real endpoints, the way Seedance's end_image_url does?
  if (TEST_IMAGE_START && TEST_IMAGE_END) {
    const id = await createTask(
      [
        { uri: TEST_IMAGE_START, position: "first" },
        { uri: TEST_IMAGE_END, position: "last" },
      ],
      "The action completes naturally between the two states shown.",
      "TEST 2 (first+last frame / FLF)",
    );
    if (id) await pollTask(id, "TEST 2");
  }

  console.log("\nDownload both output URLs and compare by eye against:");
  console.log("  - the character's real reference sheet (identity match)");
  console.log("  - what Seedance would have produced for the same shot (motion/completion quality)");
}

run();
