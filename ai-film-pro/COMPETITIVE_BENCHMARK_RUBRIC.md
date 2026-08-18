# Competitive Benchmark Rubric

Priority 7 of the 2026-08-04 "best in the industry" session. This is
evaluative work, not implementation — no real comparative render was run
this session (that requires explicit authorization: it means spending real
money rendering the identical script through both this pipeline and a
competitor platform like M Studio, or at minimum paying for a real render
here to compare against a competitor's published marketing examples). This
rubric is the structured deliverable for when that comparison is authorized,
so the axes worth judging on are defined and ready rather than the
comparison being skipped entirely.

## How to run a real comparison, when authorized

1. Pick ONE script, submitted verbatim to both platforms — no favorable
   editing for either side.
2. Render at the closest matching settings available on both (resolution,
   duration, audio on).
3. Score each axis below independently, on the FINISHED output only (not
   the process) — a blind side-by-side where the rater doesn't know which
   file came from which platform is the most honest version of this.
4. Where this pipeline now has a real, automated proxy for an axis (see
   "Automated signal" column), pull that number too — it's evidence, not a
   substitute for actually watching the film.

## The axes

| # | Axis | What a 1 looks like | What a 5 looks like | Automated signal available in this pipeline |
|---|------|---------------------|----------------------|----------------------------------------------|
| 1 | **Consistency & continuity** | A character's face changes between shots, a prop teleports, headcount is wrong, day flips to night with no reason | Every character, prop, and location reads as the same real thing across every cut, with no jarring resets | `QaEvent` pass/fail/unverified rates (Priority 5), the compiler's own `issues` count on the final breakdown |
| 2 | **Visual / cinematic quality** | Flat lighting, visible compression artifacts, no color grade, looks like a raw AI-model output | Real film-grain, deliberate color grade, sharp detail preserved, reads as shot on a real camera | None automated — genuinely a human-eye judgment call; CRF/preset settings (this session's encode-quality fix) are a floor, not a score |
| 3 | **Directorial craft (shot variety & pacing)** | Every shot is the same static medium framing at the same duration regardless of content | Deliberate, motivated coverage — wides, mediums, close-ups used where the beat calls for them; duration matches content | `checkShotVariety()`'s findings (Priority 4) — judgment-tier, not a hard score, but a real signal |
| 4 | **Audio** | Dialogue is inaudible/mistimed, no emotional direction, jarring loudness jumps between clips, no mix | Dialogue is clear, timed naturally to the shot, delivered with real emotional weight, consistent loudness, a real mix (score/ducking) | `DIALOGUE_TIMING_MISMATCH` findings (Priority 3), loudnorm target compliance (already-shipped) |
| 5 | **Narrative fidelity** | The output invents content the script never asked for, or silently drops real beats/dialogue the user wrote | Every beat and every line of dialogue the user actually wrote appears, faithfully, nothing invented | `SCRIPT_DIALOGUE_LINE_DROPPED` / under-expansion-guard trigger rate (this session's breakdown-fidelity fixes) |
| 6 | **Reliability (does it actually finish)** | The render fails, times out, or needs many manual retries to get a usable film at all | A submitted script reliably produces a finished film without hand-holding | Job `status: "failed"` rate, `attempts` distribution (already logged in the `Job` table) |
| 7 | **Safety & compliance, without being needlessly restrictive** | Either lets through content it clearly shouldn't, OR refuses ordinary storytelling (a thriller, a villain, dramatic conflict) | Refuses genuine violations, renders ordinary fiction without friction | `SafetyRefusal` log rate + manual spot-check of a sample of refusals for false positives (Priority 1) |
| 8 | **Cost & speed** | Expensive and/or slow relative to the finished film's length and quality | Competitive real-dollar cost and wall-clock time per finished minute | `Spend` table (already shipped), per-render `costUsd` |

## Scoring

For each axis, 1–5. A platform's overall score is NOT a simple average — a 1
on axis 5 (narrative fidelity) or axis 7 (safety) should be treated as a
near-disqualifying result on its own, since those represent the product not
actually doing its one job, not a quality-of-degree issue the way axis 2
(visual polish) is.

## What this session could NOT evaluate

No competitor render was made, authorized, or paid for this session. The
axes above and their automated signals are all real and already wired into
this pipeline (most as a direct result of this session's own work) — what's
missing is the other half of the comparison, which needs either (a)
authorization to spend real money on a side-by-side render, or (b) a
lower-fidelity comparison against a competitor's own published marketing
examples (weaker evidence — those are cherry-picked best cases, not a random
or representative sample — but usable if real rendering isn't authorized).
