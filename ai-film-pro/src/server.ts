import express from "express";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config, runtime } from "./config";
import { runBreakdown } from "./steps/1-breakdown";
import { runOptions } from "./steps/2-options";
import { runSheet } from "./steps/3-sheet";
import { runPropSheet } from "./steps/3b-props";
import { runImages } from "./steps/4-images";
import { runVideos } from "./steps/5-videos";
import { runAssemble } from "./steps/6-assemble";
import type { Breakdown, Selections } from "./types";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/files", express.static(path.resolve(runtime.outDir)));
app.use(express.static(path.resolve("public")));

type Job = {
  id: string;
  stage: string;
  progress: number;
  done: boolean;
  error?: string;
  characters?: { id: string; name: string; options: string[] }[];
  film?: string;
};

const jobs = new Map<string, Job>();
const newId = () => Math.random().toString(36).slice(2, 10);
const rmrf = (p: string) => fs.rm(p, { recursive: true, force: true });

// --- Step 1 + 2: break down the script and generate character options ---
app.post("/api/generate", async (req, res) => {
  const script: string = (req.body?.script || "").trim();
  if (!script) return res.status(400).json({ error: "Script is required." });

  const id = newId();
  const job: Job = { id, stage: "Starting", progress: 5, done: false };
  jobs.set(id, job);
  res.json({ jobId: id });

  (async () => {
    try {
      await rmrf(runtime.outDir); // fresh film each time (single-user local)
      await fs.mkdir(path.dirname(config.scriptPath), { recursive: true });
      await fs.writeFile(config.scriptPath, script, "utf8");

      job.stage = "Reading the script"; job.progress = 18;
      await runBreakdown();

      job.stage = "Designing character looks"; job.progress = 40;
      const sel = await runOptions();

      job.characters = Object.entries(sel).map(([cid, info]) => ({
        id: cid,
        name: info.name,
        options: info.options.map((_, i) => `/files/characters/options/${cid}/opt-${i + 1}.png`),
      }));
      job.stage = "awaiting-selection";
      job.progress = 50;
    } catch (e: any) {
      job.error = e?.message || String(e);
      job.done = true;
    }
  })();
});

// --- Step 3–6: user picked characters -> build the film ---
app.post("/api/select", async (req, res) => {
  const { jobId, selections } = req.body || {};
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json({ ok: true });

  (async () => {
    try {
      const selPath = `${runtime.outDir}/selections.json`;
      const sel: Selections = JSON.parse(await fs.readFile(selPath, "utf8"));
      for (const [cid, idx] of Object.entries(selections || {})) {
        if (sel[cid]) sel[cid].chosen = Number(idx) + 1; // UI is 0-based
      }
      await fs.writeFile(selPath, JSON.stringify(sel, null, 2), "utf8");

      job.stage = "Building the character sheet"; job.progress = 60;
      await runSheet();
      // CONFIRMED REAL GAP, FIXED: the production worker (worker.ts) always
      // builds the prop reference sheet before keyframes; this local dev
      // server skipped it entirely. 4-images.ts degrades gracefully with no
      // props.json (readJsonOr), so it didn't crash — it just silently
      // rendered zero prop-anchoring for any script with story-significant
      // props. breakdown.json is re-read from disk here (not passed via the
      // in-memory job across the two separate /api/generate + /api/select
      // requests) to match this file's own existing convention — selections.json
      // is read the same way just above.
      const breakdown: Breakdown = JSON.parse(await fs.readFile(`${runtime.outDir}/breakdown.json`, "utf8"));
      await runPropSheet(breakdown);
      job.stage = "Painting each shot"; job.progress = 74;
      await runImages();
      job.stage = "Filming the clips (this is the slow part)"; job.progress = 86;
      await runVideos();
      job.stage = "Stitching your film"; job.progress = 95;
      await runAssemble();

      job.film = "/files/final.mp4";
      job.stage = "done";
      job.progress = 100;
      job.done = true;
    } catch (e: any) {
      job.error = e?.message || String(e);
      job.done = true;
    }
  })();
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json(job);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`\n🎬  safa is running → http://localhost:${PORT}\n`);
});
