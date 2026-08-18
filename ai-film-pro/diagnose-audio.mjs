/**
 * PUT THIS AT:  ai-film-pro/diagnose-audio.mjs
 * RUN:          node diagnose-audio.mjs
 *
 * Checks every link in the audio chain and tells you which one is broken.
 * Read-only — it renders nothing and costs nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = process.env.OUT_DIR || "output";
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

// ── load .env manually (no deps) ───────────────────────────────────────────
const env = {};
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch { bad("no .env file found in this directory"); }

console.log("\n═══ 1. ELEVENLABS KEY ═══");
const key = env.ELEVENLABS_API_KEY || "";
if (!key) bad("ELEVENLABS_API_KEY is not set");
else if (key.includes("=")) bad(`key contains "=" — two .env lines merged: "${key.slice(0, 45)}"`);
else if (key.length < 20) bad(`key looks too short (${key.length} chars)`);
else ok(`key present (${key.length} chars)`);

console.log("\n═══ 2. CODE WIRING ═══");
const has = (f, needle) => { try { return fs.readFileSync(f, "utf8").includes(needle); } catch { return null; } };
const clipaudio = fs.existsSync("src/lib/clipaudio.ts");
clipaudio ? ok("src/lib/clipaudio.ts exists") : bad("src/lib/clipaudio.ts MISSING — the per-clip audio pass");
const wired = has("src/steps/5-videos.ts", "addAudioToClip");
wired ? ok("5-videos.ts calls addAudioToClip") : bad("5-videos.ts does NOT call addAudioToClip (stale file)");
const cacheFixed = has("src/steps/5-videos.ts", "hasAudioStream");
cacheFixed ? ok("cached clips get topped up with audio") : warn("cache fix missing — cached clips stay silent");
const assembleClean = has("src/steps/6-assemble.ts", "synthesizeLines");
assembleClean === false ? ok("6-assemble.ts is the pure-concat version") :
  assembleClean === true ? warn("6-assemble.ts still has voice code — double-audio risk") : null;

console.log("\n═══ 3. DOES THE SCRIPT HAVE DIALOGUE? ═══");
let bd = null;
try { bd = JSON.parse(fs.readFileSync(path.join(OUT, "breakdown.json"), "utf8")); } catch {}
if (!bd) {
  warn(`no ${OUT}/breakdown.json — run a film first, then re-run this`);
} else {
  const spoken = bd.shots.filter((s) => (s.dialogue || "").trim());
  if (!spoken.length) {
    bad(`ZERO shots have dialogue — there is nothing to say, so silence is CORRECT.`);
    console.log(`     Your script needs actual spoken lines, e.g.:`);
    console.log(`       RIYA: Do minute! Train chhootne wali hai.`);
  } else {
    ok(`${spoken.length} of ${bd.shots.length} shots have dialogue`);
    for (const s of spoken) {
      const onCam = !s.offscreenSpeaker && s.speaker && s.characters.includes(s.speaker);
      const who = s.speaker || "—";
      const ch = bd.characters.find((c) => c.id === s.speaker);
      console.log(`     ${s.id}: ${who} (${ch?.voice ?? "no archetype"}) ${onCam ? "ON-camera → voice + lip-sync" : "off-camera → voice only"}  "${(s.dialogue || "").slice(0, 34)}"`);
    }
  }
}

console.log("\n═══ 4. WERE VOICE FILES ACTUALLY MADE? ═══");
const vdir = path.join(OUT, "voice");
if (!fs.existsSync(vdir)) bad(`${vdir}/ does not exist — synthesizeLines never wrote anything`);
else {
  const mp3s = fs.readdirSync(vdir).filter((f) => f.endsWith(".mp3"));
  mp3s.length ? ok(`${mp3s.length} voice file(s): ${mp3s.join(", ")}`)
              : bad(`${vdir}/ is empty — ElevenLabs returned nothing`);
}

console.log("\n═══ 5. DO THE CLIPS CARRY AUDIO? ═══");
const cdir = path.join(OUT, "clips");
if (!fs.existsSync(cdir)) warn(`${cdir}/ not found`);
else {
  for (const f of fs.readdirSync(cdir).filter((f) => f.endsWith(".mp4")).sort()) {
    const p = path.join(cdir, f);
    let hasA = false, vol = "";
    try {
      hasA = execFileSync("ffprobe", ["-v","error","-select_streams","a","-show_entries","stream=index","-of","csv=p=0", p]).toString().trim() !== "";
    } catch {}
    if (hasA) {
      try {
        const o = execFileSync("ffmpeg", ["-hide_banner","-i",p,"-af","volumedetect","-f","null","-"], { stdio:["ignore","pipe","pipe"] });
        vol = "";
      } catch (e) {
        const m = String(e.stderr || "").match(/mean_volume:\s*(-?[\d.]+) dB/);
        vol = m ? ` mean ${m[1]}dB${parseFloat(m[1]) < -80 ? " (SILENT)" : " ← has sound"}` : "";
      }
    }
    console.log(`     ${hasA ? "🔊" : "🔇"} ${f}${vol}`);
  }
}

console.log("\n═══ VERDICT ═══");
if (!key || key.includes("=")) console.log("  → Fix ELEVENLABS_API_KEY in .env, then rerun with a clean output/.");
else if (!clipaudio || !wired) console.log("  → Copy the latest clipaudio.ts + 5-videos.ts, restart the worker.");
else if (bd && !bd.shots.some((s) => (s.dialogue || "").trim())) console.log("  → Your script has no spoken lines. Add dialogue and re-run.");
else console.log("  → Check the worker log for '🎙️' or 'ElevenLabs rejected' lines and paste them.");
console.log("");
