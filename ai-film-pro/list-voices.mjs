/**
 * PUT THIS AT:  ai-film-pro/list-voices.mjs
 * RUN:          node list-voices.mjs
 *
 * Lists every voice your ElevenLabs account can reach, and marks which ones are
 * actually USABLE VIA THE API on your current plan.
 *
 * WHY THIS EXISTS: voices from the Voice Library are previewable on the website
 * but return 402 ("paid_plan_required") when called from the API on a free plan.
 * The "premade" voices ship with every account and work on free. This prints the
 * category so you can pick ones that will actually work.
 */
import fs from "node:fs";

const env = {};
for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const key = env.ELEVENLABS_API_KEY;
if (!key) { console.error("❌ ELEVENLABS_API_KEY missing from .env"); process.exit(1); }

const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
if (!res.ok) { console.error(`❌ ${res.status}`, await res.text()); process.exit(1); }
const { voices } = await res.json();

// Free plans can call "premade" voices; library ("generated"/"professional"/
// "cloned") voices need a paid subscription.
const FREE_OK = new Set(["premade"]);
const usable = voices.filter((v) => FREE_OK.has(v.category));
const locked = voices.filter((v) => !FREE_OK.has(v.category));

const describe = (v) => {
  const l = v.labels || {};
  const bits = [l.gender, l.age, l.accent, l.use_case].filter(Boolean).join(", ");
  return bits || "—";
};

console.log(`\n═══ USABLE ON YOUR PLAN (${usable.length}) — safe for .env ═══`);
for (const v of usable) {
  console.log(`  ${v.voice_id}  ${v.name.padEnd(14)} ${describe(v)}`);
}

if (locked.length) {
  console.log(`\n═══ NEEDS A PAID PLAN (${locked.length}) — these return 402 ═══`);
  for (const v of locked) {
    console.log(`  ${v.voice_id}  ${v.name.padEnd(14)} [${v.category}] ${describe(v)}`);
  }
}

// Suggest a ready-to-paste .env block from the usable set.
const pick = (pred) => usable.find(pred)?.voice_id;
const g = (v, want) => (v.labels?.gender || "").toLowerCase().includes(want);
const a = (v, want) => (v.labels?.age || "").toLowerCase().includes(want);

const male = usable.filter((v) => g(v, "male") && !g(v, "female"));
const female = usable.filter((v) => g(v, "female"));

console.log(`\n═══ SUGGESTED .env (from voices you can actually use) ═══`);
const line = (name, id) => console.log(`${name}=${id || "<none available — upgrade or reuse another>"}`);
line("ELEVENLABS_VOICE_ID", usable[0]?.voice_id);
line("ELEVENLABS_VOICE_MALE_ADULT", male.find((v) => a(v, "middle") || a(v, "old"))?.voice_id || male[0]?.voice_id);
line("ELEVENLABS_VOICE_FEMALE_ADULT", female.find((v) => a(v, "middle") || a(v, "old"))?.voice_id || female[0]?.voice_id);
line("ELEVENLABS_VOICE_MALE_YOUNG", male.find((v) => a(v, "young"))?.voice_id || male[1]?.voice_id || male[0]?.voice_id);
line("ELEVENLABS_VOICE_FEMALE_YOUNG", female.find((v) => a(v, "young"))?.voice_id || female[1]?.voice_id || female[0]?.voice_id);
line("ELEVENLABS_VOICE_MALE_OLD", male.find((v) => a(v, "old"))?.voice_id || male[0]?.voice_id);
line("ELEVENLABS_VOICE_FEMALE_OLD", female.find((v) => a(v, "old"))?.voice_id || female[0]?.voice_id);
line("ELEVENLABS_VOICE_CHILD", usable.find((v) => a(v, "young"))?.voice_id || usable[0]?.voice_id);
line("ELEVENLABS_VOICE_NARRATOR", usable.find((v) => (v.labels?.use_case || "").includes("narrat"))?.voice_id || usable[0]?.voice_id);
console.log("");
