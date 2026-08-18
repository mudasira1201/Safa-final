# 🎬 AI Film Pro — Nano Banana + Seedance 1.5 Pro

A complete, consistency-first pipeline: a screenplay becomes a realistic film where your character stays the same across every shot.

**The workflow:** script → break into shots → generate character **look-options** → **you pick one** → build a **5-angle character sheet** → that sheet locks identity in every keyframe → Seedance animates each at 720p → stitched into one film. Everything is **cached**, so re-running never re-charges you for work already done.

---

## ✅ One-time setup

1. **Node 20+** — https://nodejs.org (`node -v`)
2. **ffmpeg** — `brew install ffmpeg` (mac) / `winget install Gyan.FFmpeg` (win) / `sudo apt install ffmpeg` (linux)
3. **fal.ai key + credits** — https://fal.ai/dashboard/keys (load ~$20; see costs below)
4. **An OpenAI-compatible LLM key** — https://platform.openai.com/api-keys
5. In the project folder:
   ```bash
   npm install
   cp .env.example .env      # then paste FAL_KEY and LLM_API_KEY into .env
   ```

The `.env` is already set to **Nano Banana 2** (images) + **Seedance 1.5 Pro @ 720p** (video). Nothing else to configure.

---

## ▶️ Making a film (the recommended flow)

**1. Put your script** in `scripts/sample.txt` (or point `SCRIPT_PATH` at another `.txt`).

**2. Generate character options and pick your favorite:**
```bash
npm run characters
```
This breaks down the script and generates **4 look-options per character** into `output/characters/options/<character>/`. Open that folder, decide which look you want, and **set its number** in `output/selections.json` (the `"chosen"` field). *(If you skip picking, it uses option 1.)*

**3. Build the film:**
```bash
npm run film
```
This builds the 5-angle sheet from your chosen look, then generates keyframes, animates them, and stitches the final movie.

**4. Get your film:** `output/final.mp4`

> Why two steps? So *you* choose the character before any money is spent on the full film — exactly the "select one character, reuse everywhere" flow.

---

## 🔁 Re-rolling a bad shot (without paying for the whole film again)

Everything is cached per shot. To redo just one shot:
```bash
# delete only that shot's keyframe and clip, then re-run
rm output/images/shot-3.png output/clips/03-shot-3.mp4
npm run film     # regenerates ONLY the missing shot, reuses everything else
```
To start completely fresh: `rm -rf output`.

Run stages individually any time: `npm run breakdown` · `characters` · `sheet` · `images` · `videos` · `assemble`.

---

## 💸 Costs (fal, approximate)

- Nano Banana 2 image: ~$0.08 · Seedance 1.5 Pro video @720p: ~$0.05/sec.
- A **1-minute, 8-shot film, 1 character** ≈ **$4–5** for a clean pass (5 options + 5 sheet angles + 8 keyframes + ~60s of video).
- **Plan for re-rolls** — a *polished* minute realistically runs **~$10–15**. **Load ~$20.**
- Cheaper drafting: set `VIDEO_RESOLUTION=480p` (cuts video cost ~half), then switch to `720p` for the final render. The character sheet is one-time — future films of the same character only pay for keyframes + video.

---

## 🎚 Quality vs cost knobs (`.env`)

| Want | Change |
|---|---|
| Top image quality | `IMAGE_MODEL=fal-ai/nano-banana-pro`, `IMAGE_EDIT_MODEL=fal-ai/nano-banana-pro/edit` |
| Cheaper images | `IMAGE_EDIT_MODEL=fal-ai/bytedance/seedream/v4/edit` |
| Cheaper drafts | `VIDEO_RESOLUTION=480p` |
| Longer/shorter clips | `SHOT_DURATION=4..12` |
| Faster (if your fal tier allows) | raise `CONCURRENCY` |

---

## ⚠️ Honest expectations

This setup gets you **good, mostly-consistent, realistic** output — a huge step up from generic image-to-video. But:
- **Consistency is strong, not perfect.** The sheet locks each keyframe, but the video model still re-renders faces during motion, so expect some drift and a few re-rolls — especially with **2+ characters in frame** or **fast action/fighting**, which are the hardest cases for any current tool.
- **Simple actions** (walking, drinking, jogging) look realistic; **complex contact action** is the frontier.
- Generating shot-by-shot and re-rolling the weak shots is the normal, expected way to get a clean final cut.

---

### File map
```
src/
  run.ts                full pipeline (cached, resumable)
  config.ts             models + settings from .env
  providers/{llm,image,video}.ts
  steps/
    1-breakdown.ts      script -> shots
    2-options.ts        character look-options (you pick)
    3-sheet.ts          5-angle character sheet
    4-images.ts         per-shot keyframes (identity-locked)
    5-videos.ts         Seedance animation @ 720p
    6-assemble.ts       ffmpeg stitch -> final.mp4
```
