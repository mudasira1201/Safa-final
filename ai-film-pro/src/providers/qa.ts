// src/providers/qa.ts
// -----------------------------------------------------------------------------
// POST-RENDER QA + AUTO-REGENERATION.
//
// Your compiler + repair loop fix shots BEFORE they render. This fixes what only
// shows up AFTER: a face that morphs mid-clip, a duplicated ball, extra people who
// materialise, a body clipping through a wall, a cricket bat that came out shaped
// like a baseball bat despite the plan being correct. It samples frames from the
// finished clip, has a vision model compare them to the shot you asked for, and —
// if it fails — re-renders that ONE shot with a single corrective note appended
// (reuse the same seed), up to a retry cap, then leaves it for human review.
//
// Ported to YOUR types: it reads a real `Shot` from ../types. The only things you
// supply are a VisionClient (any multimodal model you already have) and an Uploader
// (your existing fal storage upload). Both are tiny adapters.
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shot } from "../types";

// --- You implement these two against providers you already run. ---------------

export interface VisionClient {
  /** Multimodal call: system + user text + ordered image URLs -> strict JSON. */
  inspectJson<T>(args: { system: string; user: string; imageUrls: string[] }): Promise<T>;
}

export interface Uploader {
  /** Host a JPEG and return a public URL. Back this with your fal storage upload. */
  upload(bytes: Uint8Array, filename: string): Promise<string>;
}

// --- Result shape -------------------------------------------------------------

export interface QAFinding {
  kind:
    | "morphing_transformation"
    | "identity_drift"
    | "identity_swap"
    | "background_identity_bleed"
    | "extra_people"
    | "missing_person"
    | "duplicated_object"
    | "fragmented_object"
    | "wrong_equipment"
    | "wrong_wardrobe"
    | "environment_changed"
    | "reflection_reality_violation"
    | "physics_violation"
    | "body_interpenetration"
    | "anatomy_error"
    | "treadmill"
    | "stalled_shot"
    | "motion_loop"
    | "reversed_motion"
    | "sequence_order_violation"
    | "shot_internal_cut"
    | "voiceonly_has_body"
    | "blurry_or_soft_focus"
    | "unnatural_motion"
    | "flat_performance"
    | "unscripted_event"
    | "other";
  detail: string;
  /** 0..1, where 1 = ruins the shot. */
  severity: number;
}

export interface QAResult {
  pass: boolean;
  findings: QAFinding[];
  /** One instruction to feed the retry. Empty if pass. */
  correction: string;
}

// --- ffmpeg helpers -----------------------------------------------------------

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${c}: ${err.slice(-200)}`))));
  });
}

async function probeDurationSec(file: string): Promise<number> {
  try {
    const out = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    const d = parseFloat(out.trim());
    return Number.isFinite(d) && d > 0 ? d : 5;
  } catch {
    return 5; // ffprobe missing / unreadable — assume a short clip
  }
}

/**
 * Download the clip, pull `count` evenly spaced frames, upload each, return URLs
 * in temporal order. Cleans up the temp dir on the way out.
 */
export async function sampleFrames(videoUrl: string, uploader: Uploader, count = 4): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "qa-"));
  try {
    const vid = join(dir, "clip.mp4");
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`fetch clip ${res.status}`);
    await writeFile(vid, new Uint8Array(await res.arrayBuffer()));

    const dur = await probeDurationSec(vid);
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      // spread across the clip but stay off the exact first/last frame
      const frac = count === 1 ? 0.5 : (i + 0.5) / count;
      const ts = Math.min(Math.max(0.05, frac * dur), Math.max(0.05, dur - 0.05));
      const out = join(dir, `f${i}.jpg`);
      await run("ffmpeg", ["-y", "-ss", ts.toFixed(2), "-i", vid, "-frames:v", "1", "-q:v", "2", out]);
      urls.push(await uploader.upload(new Uint8Array(await readFile(out)), `qa_${Date.now()}_${i}.jpg`));
    }
    return urls;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- The judgment -------------------------------------------------------------

const QA_SYSTEM = `You are a film QA supervisor with vision. You are shown, in order:
 (1) OPTIONALLY each named character's ORIGINAL, canonical reference photo — one per character, the SAME
     photo used to anchor every shot of that character across the whole film, not this shot's own keyframe —
     labelled by name in the text below. NOT EVERY NAME IN THIS BLOCK IS NECESSARILY LISTED AS "present" IN
     THIS SHOT (see below) — some are shown ONLY so you can check that no background or incidental person in
     this shot has been rendered wearing that absent character's face (see background_identity_bleed), then
 (2) OPTIONALLY tracked-prop reference photos, then OPTIONALLY one LOCATION reference photo — this shot's own
     scene's fixed, canonical appearance, the SAME anchor image used to keep every shot in that scene visually
     consistent — labelled and explained in the text below, then
 (3) OPTIONALLY the intended keyframe the clip was supposed to start from, then
 (4) several frames sampled from the GENERATED clip, SPREAD ACROSS ITS FULL DURATION and given to you in
     TEMPORAL ORDER — not just a first/last pair. When "Motion over the clip" below describes MULTIPLE
     distinct, ordered sub-beats (e.g. "opens the door, then steps through, then sets the bag down"), use
     this ordered sequence of frames to check not just THAT each beat happened, but that they happened in
     THAT STATED ORDER — see sequence_order_violation below.
Judge the generated frames against the stated intent. Report concrete failures from EXACTLY this set:
 "morphing_transformation","identity_drift","identity_swap","background_identity_bleed","extra_people","missing_person","duplicated_object","fragmented_object",
 "wrong_equipment","wrong_wardrobe","environment_changed","reflection_reality_violation","physics_violation","body_interpenetration","anatomy_error","treadmill",
 "stalled_shot","motion_loop","reversed_motion","sequence_order_violation","shot_internal_cut","voiceonly_has_body","blurry_or_soft_focus","unnatural_motion",
 "flat_performance","unscripted_event","other".
Definitions to hold you honest:
 - morphing_transformation: a person/animal changes into a different person, age, gender, or thing, OR a
   named OBJECT changes into a visibly different object with no on-screen pickup, hand-off, or put-down to
   explain it (e.g. car keys held in a hand become a phone by the next frame, with no moment showing the
   keys set down and the phone picked up). This is exactly as serious a failure as a person's face changing
   — an object's identity must stay fixed across a shot and across chained shots the same way a character's
   identity must. THIS ALSO INCLUDES A SUBTLER CASE: the SAME named object visibly changing its own real-
   world shape, size, or color partway through the clip with no on-screen cause — a wrapped parcel that
   starts rectangular and becomes envelope-shaped, a cricket bat whose blade shape or color shifts, a ball
   that changes color — even though it is still recognizably "the same kind of object" and nothing else
   swapped it out. If a PROP REFERENCE PHOTO was provided for a named prop (see above), that is its
   permanent ground-truth appearance — judge drift against THAT specifically, the same way identity_drift
   judges a character against their reference photo rather than only the keyframe; a prop that matches its
   own reference at the clip's start and then visibly drifts in shape/size/color by the clip's later frames
   is exactly this failure, at the same severity as a character's face changing. If no prop reference photo
   was provided but the intended starting KEYFRAME image was, treat its depiction of any named prop as that
   prop's correct reference appearance for THIS shot instead — the same fallback identity_drift uses when no
   character reference is available.
 - identity_drift: the same character's face/hair/clothes change across the frames OF THIS CLIP. If a
   character's ORIGINAL reference photo was provided (see above), this ALSO includes the case where the
   clip is internally consistent but the person no longer matches THAT reference photo — a clip that is
   perfectly faithful to its own (already-drifted) starting keyframe is STILL identity_drift if it does not
   match the character's true reference photo. The reference photo is ground truth; the keyframe is not.
   Ignore pose, expression, camera angle, lighting, and GENERAL wardrobe (a shirt or jacket colour/style can
   legitimately vary shot to shot) when comparing to the reference photo — but face shape, features, skin
   tone, hair colour/style, and apparent age must not. ACCESSORIES ARE PART OF IDENTITY, NOT WARDROBE — do
   NOT lump them in with clothing that's allowed to change: if the reference photo shows the character
   wearing glasses, a distinctive hat or headwear, an earring, a necklace, a ring, a beard, or any other
   specific, named accessory or distinguishing feature, that accessory is a FIXED part of who this character
   is and must be present, in the same form, in every frame of this clip — its absence, or a visibly
   different version of it, is identity_drift exactly the same as a changed face. Confirmed real: a
   character's glasses appeared in some shots and were simply absent in others, with nothing in the shot's
   own text describing them being removed. (For two DIFFERENT characters' identities ending up SWAPPED
   between each other's established positions — a genuinely distinct, more severe failure — see
   identity_swap below, not this category.)
 - identity_swap: MORE SEVERE than identity_drift, and judged differently — this is not "does a face still
   match its own reference," it's "does each POSITION in frame match the RIGHT character's reference, not
   just A reference." Applies when 2+ named characters, each with a reference photo, are present AND the
   shot text below establishes which position or role each one occupies (e.g. "the customer stays on the
   public side... the shopkeeper stays behind the counter", a named character approaching from the left vs
   the right, one person's role stated explicitly). For EACH position, do a COMPARATIVE judgment, not an
   isolated one: does the face in this position match ITS OWN assigned character's reference BEST, better
   than it matches any OTHER named character's reference? A face that clears some vague "looks like a
   person" bar is not enough — check it against every reference photo you were given and confirm the
   assigned one is the best match specifically. If the face in character A's established position instead
   matches character B's reference better (even though character A's own face is still cleanly rendered
   somewhere ELSE in frame — on B's position), that is identity_swap: the two identities have traded places.
   Report this even when each individual face, judged alone, looks anatomically fine — the defect is the
   cross-assignment between two real, distinct people, not either face being malformed. Confirmed real: a
   customer and a shopkeeper at a market stall, each with their own reference photo and an explicit
   "customer stays on the public side, shopkeeper stays behind the counter" instruction, ended up with their
   faces on each other's side of the counter mid-shot.
 - background_identity_bleed: a BACKGROUND or INCIDENTAL person in this shot — someone who is NOT one of the
   named characters listed as present below — has a face that matches one of the reference photos you were
   shown for a DIFFERENT named character, one who is not stated as present in this shot at all. This is
   distinct from identity_swap (which is about two PRESENT characters trading positions with each other) and
   from extra_people (which is about someone unnamed appearing at all, regardless of whose face they wear) —
   this specifically judges WHOSE FACE an incidental figure was rendered with. A vendor, shopkeeper,
   passerby, or any other background figure must be a visibly DIFFERENT, unrelated person from every named
   character's reference photo you were given, unless that specific character is actually listed as present
   in this exact shot. Confirmed real: in a market scene, a background vendor at one stall in one shot and an
   unrelated background vendor at a different stall in another shot both rendered with the SAME face as a
   named character who was established elsewhere in the film — as if the model quietly reused a principal
   cast member's identity for an extra who was never supposed to be them. Report this even if the background
   figure's face is, on its own, cleanly and correctly rendered — the defect is WHOSE identity it is wearing,
   not how well-formed the face looks.
 - extra_people: THE HEADCOUNT ITSELF IS WRONG. Do this as an explicit COUNT, not an impression: count every
   distinct human figure visible anywhere in the frame — foreground AND background, however small or
   blurred — and compare that total to the exact number of named people stated as present below. Report
   extra_people if the counted total is HIGHER than that stated number, for EITHER of two completely
   different reasons, and both are equally the SAME defect:
     (a) DUPLICATION — one of the named people appears more than once (the same character, or the same
         background figure, rendered twice, merged, or ghosted);
     (b) A WHOLLY NEW PERSON — a figure who resembles NONE of the named people and was never named as
         present at all appears anywhere in frame, even once, even if they look nothing like anyone else in
         the shot. This second case is NOT a lesser or different failure than duplication — it is reported
         under this exact same "extra_people" kind, at the exact same severity, precisely because the
         underlying defect is identical either way: the frame contains MORE people than the shot's own stated
         headcount allows. Do not reason about whether the extra figure "looks like" a tracked character
         before deciding whether to report it — an unrelated stranger who was never named is just as much an
         extra_people violation as a duplicate of someone who was.
   This applies to ANY person in the frame, not only the named lead — a secondary or background character
   (a shopkeeper, a vendor, a bystander) appearing TWICE in the same frame, OR a stranger appearing who
   resembles nobody at all, is exactly as serious a failure as the lead duplicating, and must be reported as
   extra_people, not waved off as a background detail or as "just an extra."
 - missing_person: THE HEADCOUNT ITSELF IS WRONG THE OTHER WAY — the exact mirror of extra_people's
   undercounting case, and just as serious. Check each name listed as present below individually: is a body
   matching that name actually visible at some point in EVERY sampled frame, or does it disappear partway
   through the clip (or never appear at all) with nothing in the shot's own text (description/motion/
   startFrame/endFrame) describing them leaving, exiting, or moving out of frame? Confirmed real: a named
   character present at a shot's start was simply gone from later frames of the SAME clip, then reappeared
   the very next shot, with no exit ever depicted — as if the render had temporarily forgotten they existed
   mid-take. Report this the moment a listed person is absent from any sampled frame without an on-screen
   reason, even if they are present in other frames of the same clip — a person who is there, then isn't,
   then is again, is exactly as broken as one who was never there at all. Do NOT report this when the shot's
   own text explicitly describes that person stepping out of frame, leaving through a door, or being
   obscured behind something (a pillar, a wall, another person) — only when a listed person simply isn't
   visible with nothing in the text explaining why.
 - duplicated_object / fragmented_object: a single object (ball, letter, weapon, parcel) appears twice, or splits/multiplies.
 - wrong_equipment: an object has the wrong real-world shape for its domain (e.g. a rounded baseball bat where a flat cricket bat belongs; a torch that became a candle).
 - environment_changed: the location/layout/furniture changes, or a close-up adds architecture that was not in the wide.
   If a LOCATION REFERENCE PHOTO was provided (see above) for this shot's scene, that is this location's
   permanent ground-truth appearance for the WHOLE scene — judge drift against THAT specifically, the same
   way identity_drift judges a character against their reference photo rather than only this shot's own
   keyframe: a location that matches its own keyframe internally but no longer matches the scene's reference
   photo (different landmarks, furniture, or fixed background features — a signal post that vanished, a
   market stall that's now a different structure) is STILL environment_changed, even if nothing about THIS
   shot's own frames looks internally inconsistent. Confirmed real: a scene established with a specific fixed
   landmark (a traffic signal the character was about to cross at) rendered a later shot in the "same" scene
   as a visually different, landmark-free version of the location.
 - reflection_reality_violation: a mirror, window, monitor, screen, or other reflective/transparent surface
   is treated as more than a flat picture of a second view of the SAME space. Report TWO distinct shapes of
   this, both equally serious: (a) AN OBJECT OR PERSON CROSSES THE REFLECTION/REALITY BOUNDARY — something
   (a hand, an object, a figure) appears to emerge FROM the reflected image INTO real space, or the reverse,
   as if the glass were a passage between two different places rather than a flat surface. Confirmed real: a
   letter appeared to materialize out of a mirror's reflected image directly into a character's real-space
   hand. (b) THE SURFACE'S OWN NATURE CHANGES MID-SHOT — a doorway, window, or other surface renders as an
   ordinary opening in some frames and as a reflective, mirror-like surface in others, within the SAME clip,
   with nothing in the shot's own text describing that kind of state change. Confirmed real: a doorway/mirror
   surface morphed between the two states partway through one shot. Do NOT report this for a shot that
   correctly shows the reflection DISAGREEING with reality in content while the surface's own physical nature
   stays consistent throughout (a screen showing a sleeping infant while the crib is empty is a deliberate,
   correctly-composed story beat, not this defect) — this category is specifically about the boundary or the
   surface's identity being violated, not about what the reflection happens to depict.
 - physics_violation: bodies/hands pass through walls, furniture, or each other; a struck object behaves
   impossibly; coins or money spill/scatter instead of transferring as a held handful; an object appears to
   float against or stick to an open palm with no real grip; a character's head/neck rotates independently
   of, or further than, their own shoulders and body (an "owl-neck" effect) — for example the body keeps
   walking one way while the head keeps turning past a natural look-back, sometimes a full 360 degrees, but
   THIS APPLIES JUST AS MUCH TO A STATIONARY BODY: a character standing still, or performing an unrelated
   small action (adjusting glasses, reaching for something), whose head or neck rotates through an angle or a
   number of degrees a real neck cannot reach while the rest of the body stays still or turns far less — the
   defect is the HEAD/NECK's own rotation being anatomically impossible relative to the shoulders, not
   specifically about locomotion. Confirmed real: a character's body turned partway while adjusting his
   glasses, and in that same beat his head rotated a full 360 degrees and held there. Report this at critical
   severity whether the body is walking, running, or standing still; OR — during a
   HAND-TO-HAND OBJECT EXCHANGE specifically (money, a parcel, keys, any item passed directly between two
   people) — the object visibly HANGS OR HOVERS IN MID-AIR for any part of the transfer instead of moving
   continuously from one hand's grip to the other's, or ends up held with a visible GAP between the palm/
   fingers and the object instead of a real, closed grip. Confirmed real: a parcel handed across a counter
   was visibly suspended in the air for a beat mid-transfer, then ended up held with daylight between the
   receiving hand and the object rather than actually gripped. Report this last case (hand-to-hand exchange)
   and the "owl-neck" case even if the rest of the body's motion looks otherwise normal — these are among the
   most visible failures a viewer can spot. (For two people's BODIES blending or interpenetrating during
   contact — not an object passing between them — see body_interpenetration below, its own distinct category.)
 - body_interpenetration: when the shot describes TWO PEOPLE IN PHYSICAL CONTACT (an embrace, a handshake, a
   carry, a hand-to-hand object exchange/handoff, any action naming direct contact between two named
   characters) — their bodies visibly BLEND or INTERPENETRATE at the point of contact instead of staying two
   separate, complete bodies: a face passing through the other person's head or shoulder, hair or skin tone
   bleeding from one body into the other, or — specifically for a handoff — the two hands themselves visibly
   overlapping, merging, or passing through each other at the moment an object changes hands, rather than
   meeting cleanly with a real seam between the two separate hands. Two people in contact must always read as
   two distinct, solid bodies meeting at one clean point of contact — never merging, blending, or passing
   through each other, even briefly, even in a single frame. Confirmed real: during a scripted embrace, one
   character's face visibly passed through the other character's head rather than resting against it; during
   a scripted coin handoff, the giving and receiving hands visibly overlapped rather than meeting at a clean
   seam. Distinct from anatomy_error (which is about ONE body's own malformed construction) and from
   physics_violation (the OBJECT floating mid-transfer, not the two hands overlapping) — this is specifically
   about TWO separate named bodies (or their hands, during an exchange) failing to stay separate. Only applies
   when the shot actually describes physical contact or a direct object handoff between two people — do not
   report ordinary close proximity (standing near each other, walking side by side) that never involves
   touching or exchanging anything.
 - anatomy_error: the BODY ITSELF is structurally malformed, independent of how it's moving — a STATIC defect
   in a single frame, distinct from unnatural_motion (which is about how a CORRECTLY-formed body moves) and
   from physics_violation (which is about the body's interaction with the environment or another body, not the
   body's own construction). Report: an extra or missing arm/leg/finger; a hand with the wrong number of
   fingers, or fingers that are fused, webbed, or melted together; a joint (elbow, knee, wrist, neck) bent at
   an angle no real human joint can reach; a limb that appears twisted, warped, doubled, or melting into
   itself, another limb, or another person; a face with a structurally wrong number or placement of
   features (a doubled eye or mouth, a feature in the wrong location on the face); OR A HEAD/FACE THAT IS
   MISSING, BLANK, OBSCURED BY A RENDERING FAILURE, OR OTHERWISE NOT ACTUALLY PRESENT on a named character
   who should have one visible — a headless or faceless figure is exactly as severe a structural defect as a
   missing limb, and must be reported at critical severity, not waved off as "just a bad angle" or "hair
   covering the face" unless the shot's own text specifically calls for a face intentionally hidden (e.g. a
   figure whose face is obscured by tangled hair as a deliberate horror beat — read the shot's stated intent
   before deciding this is a defect rather than the requested image). Look closely at hands in particular —
   they are the single most common site of the hand/finger version of this failure and are easy to miss at a
   glance, especially in a wide or medium shot where they're small in frame.
 - treadmill: the subject does not make real progress despite the shot describing continuous self-locomotion
   — a running/walking subject where the background does not stream past, OR a stair-climbing/descending
   subject whose body height and position never actually change relative to the steps (climbing in place).
   Specifically about LOCOMOTION beats; for the same "nothing actually happened" failure in a shot that
   ISN'T about self-locomotion (a static shot that should show an action, an object state change, or an
   expression developing), see stalled_shot below instead — real motion/progress was asked for and the
   render substituted little or none, either way.
 - stalled_shot: the shot's OWN text (description/motion/dialogue) describes something that should visibly
   develop over the clip's duration — an action progressing, an object being manipulated, an expression
   shifting, any beat that isn't just "hold still" — but comparing the sampled frames across the clip's full
   duration (see above — they are given to you in temporal order specifically for checks like this one)
   shows negligible change throughout: the first and last sampled frames look essentially the same, as if the
   render just held one static moment for the whole clip instead of performing the described beat at all.
   This is the GENERAL form of treadmill's narrower locomotion-only case above — report THIS kind for a
   non-locomotion stall (a close-up that should show a reaction building but stays flat and motionless the
   entire time, an envelope that should visibly get opened but the hands never move) and treadmill for a
   locomotion one; do not report both for the same shot. Confirmed real: a static close-up held for a
   shot's full duration with no visible development at all, wasting the render on a shot with no narrative
   content. Do NOT report this for a shot whose own text genuinely calls for stillness (a held reaction, a
   quiet beat, someone staring in silence) — this is about a DESCRIBED development never appearing, not
   about every calm or minimal shot being a defect.
 - motion_loop: the clip's own motion repeats or restarts WITHIN ITSELF — the same movement cycle (a wave,
   a step cycle, a reach-grab-release, a full gesture) plays out more than once in the one clip, as if the
   render looped back to an earlier point in the motion instead of continuing forward, OR the subject
   visibly re-covers ground, re-performs an action, or passes the same landmark a second time that it
   already completed earlier in this SAME clip. This is distinct from treadmill (no real progress at all,
   ever) and from unnatural_motion's incomplete-action case (the action never finishes) — here the action
   DOES complete, and then it happens again. Report this even when each individual repetition looks
   physically natural on its own; the defect is the repetition itself, not how any one cycle looks.
   ALSO REPORT THE CROSS-SHOT-BOUNDARY VERSION OF THIS SAME FAILURE: if "Motion over the clip" below
   contains a sentence starting "ALREADY COMPLETE — DO NOT RE-PERFORM: ...", that names an action the
   PREVIOUS shot already finished before this clip begins — this clip's own footage must continue from
   that finished state, never depict that named action happening again from its own beginning (the sit
   starting from standing, the embrace starting from apart, the handoff starting from the object not yet
   passed). This is the single most frequently confirmed real defect across this whole project's test
   renders: a sit-down, hug, or handoff completing once via the seeded starting frame and then playing out
   a second time within the clip that was supposed to already be past it. Report it as motion_loop even
   though the repeat here is the FIRST depiction of the action within this clip, not a second cycle inside
   it — the completion the previous shot already established counts as the first occurrence, so showing it
   again here is still a repeat from the audience's perspective, which is what motion_loop exists to catch.
 - reversed_motion: the subject's direction of travel is the OPPOSITE of what the shot intends — described as
   approaching, coming closer, or walking toward something, but the render shows them receding, moving away,
   or backing up instead, OR the walk/run cycle itself reads as if the footage were playing in reverse (a
   heel striking the ground before the toe, a limb recoiling backward instead of extending forward, weight
   shifting the wrong way through the stride). Distinct from treadmill (no net progress in EITHER direction)
   and motion_loop (the cycle repeats, not necessarily reversed) — here the subject visibly moves, just the
   wrong way, or the motion itself looks undone rather than done. If the motion text below contains an
   explicit "MOVING DIRECTION: ..." sentence, treat that as the AUTHORITATIVE, unambiguous statement of
   intended direction — it exists specifically so you don't have to infer direction from looser prose
   elsewhere in the shot, and any render contradicting it is reversed_motion regardless of how the rest of
   the shot reads.
 - sequence_order_violation: "Motion over the clip" below describes TWO OR MORE distinct, separately-named
   sub-beats within this ONE shot, in a stated order (commonly joined by "then", "and then", "after", or a
   comma-separated list of actions — e.g. "opens the door, then steps through, then sets the bag down on the
   table"). Using the sampled frames' own temporal order (see above — they are spread across the clip's full
   duration specifically so you can do this), check whether those sub-beats actually occur in THAT SAME
   stated order. Report this when a LATER-described beat is visibly happening BEFORE an EARLIER-described
   one in the actual frame sequence, or the beats appear shuffled/reversed relative to the stated order —
   even if every individual beat, looked at alone, is well-rendered. This is DIFFERENT from reversed_motion
   above: reversed_motion is about ONE continuous motion's direction of travel looking undone (a walk that
   reads like reversed footage); sequence_order_violation is about MULTIPLE discrete, separately-described
   actions within one shot happening in the wrong ORDER relative to each other (the bag is set down before
   the door is opened, or the letter is unfolded before it's picked up). Confirmed real: a scripted sequence
   of "open door, enter, drop bag" rendered with the beats out of chronological order. Only report this when
   the shot's own text genuinely describes multiple SEPARATE, ORDERED beats — a single unbroken action
   described in one continuous clause is not this category, and neither is a shot with only one beat.
 - shot_internal_cut: this clip, which is supposed to be ONE continuous, unbroken take, instead contains a
   HARD DISCONTINUITY partway through that reads like an actual edit cut spliced into the middle of it — a
   sudden jump in head/body position, camera angle, or background between two sampled frames with no
   continuous motion in between to explain how one became the other, as if two separate shots had been
   stitched together into one clip. Confirmed real: a character was looking one direction, then in the very
   next moment of the SAME clip was looking a completely different direction with no turn visible in between
   — twice in the same clip. DIFFERENT from sequence_order_violation above (which is about MULTIPLE described
   beats happening in the wrong order, each individually well-formed) and from reversed_motion (direction of
   travel undone) — this is about a single JUMP where continuity itself breaks, the frame-to-frame link a real
   continuous take can never lose. Also different from ordinary fast motion or a hard camera whip, which is a
   real, continuous (if quick) motion — the defect here is the ABSENCE of any motion connecting two positions,
   not motion that is merely fast. Use the sampled frames' temporal order to check specifically for this: does
   each frame plausibly connect to its neighbor through continuous motion, or does the scene appear to
   restart/reset at some point mid-clip as if a new shot began.
 - voiceonly_has_body: a role meant to be heard-only (narrator, commentator, phone/radio voice) is shown as a body.
 - blurry_or_soft_focus: a frame is significantly out of focus, smeared, warped, or "melted"-looking in a way
   that is NOT explained by fast intentional camera or subject motion — most commonly seen in the first
   moments of a shot before motion settles, or a clip that never resolves into a sharp, legible image at all.
   Confirmed on camera: a two-endpoint (first-last-frame) clip's opening seconds rendered as a smeared,
   impressionistic blur of the whole frame before sharpening. Do NOT report ordinary, brief motion blur on a
   genuinely fast-moving subject or a deliberate camera pan/whip — that is a normal, expected camera effect,
   not a defect. Only report this when the image itself looks broken or unresolved, not merely "in motion."
 - unnatural_motion: the bar here is "does this read as a real human body, filmed" — not "did the right verb
   happen." Report this whenever a person's movement itself looks synthetic rather than lived-in, including:
   (a) STIFF OR ROBOTIC MOVEMENT — limbs moving with mechanical, constant-speed uniformity instead of the
   natural acceleration/deceleration of a real body (a real reach speeds up then slows into contact; a real
   step has weight settling into it); a walk/gesture with no natural sway, weight shift, or momentum;
   (b) DISCONTINUOUS OR JUDDERING MOTION — a limb or the body jumping between poses instead of moving smoothly
   through the space between them, a joint bending at an angle a real body could not reach, or motion that
   stutters/skips rather than flowing;
   (c) AN INCOMPLETE ACTION — the shot's stated action visibly has NOT finished by the clip's last frame: a
   reach that never arrives, a sit that ends half-lowered, a turn that stops rotating partway with nothing
   else happening, a door left swinging instead of open or shut, a step frozen mid-stride. The clip must show
   the action reach its real, natural completion, not just progress toward it;
   (d) MISMATCHED TIMING — an action happening implausibly fast or slow for its own physical nature (a full
   sit-down in a single frame, a punch that travels in slow motion while everything else moves normally, a
   walk covering an unrealistic distance for the clip's duration).
   Do NOT report a shot just because the motion is calm, minimal, or subtle — stillness and small gestures are
   often the correct choice and are not this defect. Only report actual mechanical stiffness, discontinuity,
   incompleteness, or physically wrong timing.
 - flat_performance: you are told what emotion or line this shot is supposed to carry. Judge whether the FACE
   and BODY actually, visibly sell it, the way a real actor's would — not whether a generic expression is
   present. Report this when: (a) a shot calls for a specific, strong emotion (fear, grief, joy, fury,
   tenderness, dread) and the face instead reads as neutral, blank, generic, or only weakly related to that
   emotion — a raised eyebrow standing in for terror, a flat mouth standing in for grief; (b) a character is
   speaking dialogue and the mouth is not visibly, continuously articulating in a natural speech rhythm —
   static or barely-moving lips during a spoken line read as dubbed-over, not spoken; (c) an emotional beat
   that should hold or build in intensity across the clip instead flattens out or drifts toward neutral
   partway through, even if it started correctly. This is the single biggest difference between "technically
   correct" and "a viewer believes a real person felt this" — judge it that way, not as a checklist.
   Do NOT report a shot for having a SUBTLE or QUIET emotional register when the shot itself calls for
   subtlety or restraint (a stoic character, a controlled moment) — flat_performance is about the face failing
   to match what the shot ASKS FOR, not about every face being maximally expressive.
 - unscripted_event: the render depicts a distinct EVENT or ACTION BEAT that has NO corresponding description
   anywhere in this shot's stated intent (description/motion/startFrame/endFrame below) — the model invented
   a narrative beat that was never authored. This is different from every other kind above, which judge
   whether the DESCRIBED action was rendered correctly — this judges whether an action that was NEVER
   DESCRIBED AT ALL got rendered anyway. Judgment call, deliberately conservative for MINOR cases: do NOT
   report ordinary incidental motion that naturally accompanies a described action and wasn't worth spelling
   out individually (a hand brushing hair aside while walking, a natural blink, minor balance-adjustment).
   When in doubt whether it's a real invented beat or just normal incidental motion, do NOT report it — false
   positives here cost an unnecessary regeneration.
   SEVERITY MUST MATCH SCALE — this is NOT one uniform bar. A single invented incidental beat (a character
   collapsing/fainting with nothing in the text describing it) is a real defect, reported at moderate
   severity. But when the invented content is a WHOLESALE, MULTI-BEAT SEQUENCE that CONTRADICTS or REPLACES
   what the shot actually describes — not just adding one extra beat, but substituting a different sequence
   of actions for the described one — that is a FAR more severe failure and MUST be reported at severity
   >= 0.8: it does not just add noise, it breaks the story the shot was supposed to tell. Confirmed real: a
   shot whose own text described a character picking up a package and turning to leave was rendered instead
   as the character picking the package up, putting it back down, picking it up again, and running away
   entirely — a wholesale invented sequence contradicting the actual described action, not an incidental
   addition to it. Ask yourself: does the render still tell the SAME story the shot's text describes, just
   with one small extra flourish (moderate severity), or has it told a DIFFERENT story altogether (severity
   >= 0.8, critical)? Report at the severity the actual scale of the fabrication warrants.
For each failure: a short detail and a severity 0..1 (1 = ruins the shot).
Then write ONE short "correction": a single instruction to feed the re-generation that would fix the worst issues, phrased as a positive directive.
Output ONLY JSON, no prose:
{"pass": boolean, "findings":[{"kind":string,"detail":string,"severity":number}], "correction": string}
Set pass=false if ANY finding has severity >= 0.5.`;

/**
 * Compare the sampled frames to the shot you planned. Pass the keyframe you fed
 * to the video model as image_url when you have it — it makes identity/environment drift far
 * easier for the model to catch. Pass characterRefs (the SAME canonical photo used to anchor every
 * shot of that character — see 3-sheet.ts) when you have it too: without it, identity_drift can only
 * ever be judged against this shot's OWN keyframe, which misses drift that happened at the keyframe
 * generation stage itself and simply rendered faithfully into video. Pass propRefs (Gap A — see
 * 3b-props.ts) the same way for any tracked prop present in this shot: without it,
 * morphing_transformation can only judge a prop's appearance against this shot's OWN keyframe, the
 * same limitation identity_drift has without characterRefs.
 *
 * characterRefs does NOT have to be limited to this shot's own s.characters — for a shot.crowd shot,
 * the caller may also include OTHER named characters from later/earlier in the same scene who are NOT
 * present here. Passing their reference photos too is what lets background_identity_bleed actually
 * catch a background extra secretly wearing one of THEIR faces (see 5-videos.ts); "present" below is
 * still built from s.characters alone, so the model always knows which of the photos it was shown
 * belong to someone who's supposed to be in this exact frame and which are absent-check-only.
 */
export async function runQA(args: {
  vision: VisionClient;
  frameUrls: string[];
  shot: Shot;
  keyframeUrl?: string;
  characterRefs?: { name: string; url: string }[];
  propRefs?: { name: string; url: string }[];
  /** Gap (Priority 7) — this scene's own EARLIEST keyframe from this render,
   *  the same "scene anchor" image 4-images.ts already feeds forward for
   *  PIXEL continuity within a scene. Passing its URL here too gives
   *  environment_changed a fixed ground-truth photo to judge location drift
   *  against, mirroring characterRefs/propRefs — no separate location-photo
   *  generation step needed, since this image already exists in images.json
   *  by the time QA runs; the gap was purely that QA never received it. */
  locationRef?: { name: string; url: string };
}): Promise<QAResult> {
  const s = args.shot;
  const refs = args.characterRefs?.filter((r) => r.url) ?? [];
  const propRefs = args.propRefs?.filter((r) => r.url) ?? [];
  const locationRef = args.locationRef?.url ? args.locationRef : undefined;
  const present = s.characters.length ? s.characters.join(", ") : "(no named characters)";
  const presentCount = s.characters.length;
  const intent = [
    refs.length
      ? `Character reference photos, in this order, one per name: ${refs.map((r) => r.name).join(", then ")}. ` +
        `Each is that character's permanent ground-truth identity photo. For any of these names ALSO listed as ` +
        `present below, judge identity_drift against their photo, not against the keyframe or an earlier clip ` +
        `frame. For any of these names NOT listed as present below, their photo is shown ONLY so you can check ` +
        `no background or incidental person in this shot is wearing that absent character's face — see ` +
        `background_identity_bleed.`
      : ``,
    propRefs.length
      ? `Prop reference photos, in this order, one per name (shown after any character photos above): ` +
        `${propRefs.map((r) => r.name).join(", then ")}. Each is that object's permanent ground-truth appearance ` +
        `photo — judge morphing_transformation's shape/size/color drift against these specifically, not just ` +
        `against the keyframe.`
      : ``,
    locationRef
      ? `Location reference photo (shown after any character/prop photos above, before the keyframe): the ` +
        `permanent ground-truth appearance of "${locationRef.name}", this shot's own scene — the SAME photo used ` +
        `to anchor every shot in this scene for background continuity. Judge environment_changed's location/ ` +
        `layout/landmark drift against THIS specifically, not just against this shot's own keyframe or earlier ` +
        `clip frame.`
      : ``,
    args.keyframeUrl ? `The clip should START on the provided keyframe (next image after any reference photos above).` : ``,
    `SHOT ${s.id}. Setting (must stay fixed): ${s.setting}`,
    `We should see: ${s.description}`,
    `ONLY these people are in the foreground, each exactly once: ${present}. No one else, no duplicates, ` +
      `and none of them missing — see missing_person if any of these ${presentCount || "listed"} names isn't ` +
      `actually visible in some sampled frame with no on-screen exit shown.` +
      // Strict "exactly N total humans anywhere in frame" is correct ONLY for a
      // non-crowd shot — a shot.crowd shot legitimately has an unspecified
      // number of blurred background figures by design (see the crowd/no-crowd
      // line further below), so applying this exact-total count-check there
      // would misfire on every intended background figure. Named-character
      // duplication is still checked by the base extra_people definition either
      // way; this stricter, explicit COUNT instruction only adds the "a wholly
      // new stranger is just as much a violation" reinforcement where the shot's
      // OWN headcount really is meant to be a hard, exact number.
      (s.crowd
        ? ``
        : ` COUNT-CHECK for extra_people: count every distinct human figure anywhere in the frame, foreground ` +
          `and background, however small or blurred, and confirm the total is EXACTLY ${presentCount} — not one ` +
          `more, whether the excess figure duplicates one of these ${presentCount} names or is a completely new ` +
          `person who resembles none of them.`),
    s.startFrame ? `Start state: ${s.startFrame}` : ``,
    s.endFrame ? `End state: ${s.endFrame}` : ``,
    `Motion over the clip: ${s.motion}`,
    `Lighting/time (must stay fixed): ${s.lighting}`,
    s.dialogue
      ? `Dialogue is spoken ${s.offscreenSpeaker ? "OFF-SCREEN (the speaker has no body in frame)" : "by an on-screen character"}: "${s.dialogue}".`
      : ``,
    s.crowd
      ? `Any background crowd stays blurred and several metres behind the lead; it never approaches, touches, or merges with the lead.`
      : `There is no crowd; background people should not appear close to the lead.`,
  ].filter(Boolean).join("\n");

  return args.vision.inspectJson<QAResult>({
    system: QA_SYSTEM,
    user: intent,
    imageUrls: [...refs.map((r) => r.url), ...propRefs.map((r) => r.url), locationRef?.url, args.keyframeUrl, ...args.frameUrls].filter((u): u is string => !!u),
  });
}

// DUPLICATE/MERGED PEOPLE ARE A HARD DEALBREAKER, NOT A DEFECT LIKE THE OTHERS.
// A user will tolerate a slightly stiff walk or a background prop that looks a
// little off. A second copy of the lead character standing next to themselves, or
// two people fusing into one body, reads as broken software, not an imperfect
// film -- it is the single fastest way to make the whole product look unusable.
// So these finding kinds get their own, much stricter gate: a LOWER severity
// threshold (catch it even when the vision model is only moderately confident,
// rather than waiting for it to be "quite bad already"), checked separately from
// the general 0.5 cutoff every other defect category uses. blurry_or_soft_focus
// joins this set for the same reason, confirmed on camera: a smeared, unresolved
// opening frame is exactly as immediately "this looks broken" to a viewer as a
// duplicated person, and it disproportionately hits a film's FIRST few seconds --
// the single worst place for a defect to land, since it's what a viewer judges
// the whole film by before anything else has a chance to land.
// unnatural_motion joins this set because it is the single most direct measure of
// this whole product's stated bar: a viewer should feel a real human performed
// the action, not a synthetic approximation of one. A stiff, robotic, or visibly
// incomplete action is exactly as immediately "this is AI" to a viewer as a
// duplicated person or a smeared frame, even when nothing else in the shot is wrong.
// flat_performance joins for the same reason, one layer up: a body that moves
// naturally but a face that doesn't sell the emotion (or a mouth that isn't
// really speaking the line) is just as immediate a tell — "every emotion, every
// line" is the explicit bar this product is held to, not an optional polish pass.
// identity_drift and treadmill joined LAST, and were a real gap: they are the
// LITERAL QA categories for "character consistency" and "movement consistency"
// — the two things named most often across this whole project's real render
// reviews — yet had been sitting at the loose, general 0.5 threshold with only
// the normal retry budget this entire time, unlike every other "obviously AI"
// tell above. A face that's noticeably a different person, or a runner whose
// background never moves, is exactly as immediate a defect as a blurry frame.
// anatomy_error joined for the SAME reason, from a systematic gap audit rather
// than a specific render review: BASE_NEGATIVE (compiler.ts) has explicitly
// asked every generation call to avoid "distorted limbs, extra limbs, deformed
// hands... impossible joint bend... rubber limbs... melting anatomy" since
// early in this project, but nothing on the QA side ever checked whether that
// negative prompt actually held — a warped hand or a sixth finger is exactly
// as immediately "this is AI" to a viewer as a duplicated person, and was
// previously invisible to this whole post-render QA pass no matter how badly
// it happened, because no finding kind existed to name it.
// body_interpenetration joined alongside anatomy_error, same reasoning and
// same request — two people visibly blending or passing through each other
// during a scripted embrace/handshake is exactly as immediately "this is
// broken" to a viewer as a duplicated person or a warped hand, confirmed on
// camera (a face passing through the other person's head during a hug), and
// was previously only a sub-clause of physics_violation with no name of its
// own — split out specifically so it gets its own dedicated correction text
// below rather than being diluted into physics_violation's much broader
// wall/furniture/self-contact scope.
// identity_swap joined for the same "split it out, give it its own
// correction" reasoning, from identity_drift this time: two named
// characters trading identities/positions (a customer and a shopkeeper
// ending up on each other's side of a counter, each with their own,
// individually well-rendered face) is a MORE severe, differently-shaped
// failure than one character's face gradually drifting — the fix isn't
// "render this face more faithfully," it's "put the right face in the
// right place," a different instruction entirely. Confirmed real on camera;
// previously only a sub-clause of identity_drift with a generic drift
// correction that didn't actually address a swap.
// background_identity_bleed joined for a related but distinct reason: an
// UNNAMED background extra (a second vendor at a different stall, a
// bystander) rendered wearing a NAMED character's face, even though that
// character was never present in the shot at all. Confirmed real on camera,
// twice, in the same market scene. Different from identity_swap (which needs
// TWO present, named characters trading positions) and from extra_people
// (which doesn't care whose face the extra has, only that they exist) — this
// is specifically "an extra is secretly wearing a principal's identity,"
// which reads to a viewer as the SAME character impossibly appearing twice
// in two different, unrelated places, and is exactly as damaging as any
// other identity failure above.
// EXPORTED so callers (5-videos.ts's flag-reason label) can read the real set
// directly instead of maintaining their own duplicate list — a duplicate list
// is exactly how a critical kind gets added here and silently NOT reflected in
// the human-facing flag label elsewhere, which happened three separate times
// before this export existed.
// sequence_order_violation joined for the same reason motion_loop/reversed_motion
// did: a multi-beat action playing out of chronological order (drop the bag
// before opening the door) is exactly as immediately "this is broken" to a
// viewer as a reversed walk or a looped gesture — it is the SAME class of
// temporal-integrity failure, just at the level of discrete named beats
// rather than one continuous motion. Priority-1 user report, confirmed real:
// "open door, enter, drop bag" rendered out of order.
// reflection_reality_violation joined for the same reason body_interpenetration
// did: an object physically crossing from a reflection into real space (or a
// surface's own nature flipping mid-shot) is exactly as immediately "this is
// broken" to a viewer as a duplicated person or a warped hand — a letter
// materializing out of a mirror into a real hand is not a subtle continuity
// note, it is a viewer-visible impossibility, confirmed real on camera.
// unscripted_event joined after a real render (Track A regression audit)
// exposed the actual gap: it was NOT under-detecting — the definition itself
// says to report it — it was under-BUDGETED. A single retry attempt (the
// non-critical default) is not enough for a case severe enough to warrant
// this kind's own new severity>=0.8 "wholesale fabrication" tier (see its
// definition's own escalation language, added the same session) — a shot
// whose entire described action got replaced by an invented one is exactly
// as damaging as a duplicated person, and deserves the same extended retry
// budget, not the same single attempt as an incidental extra blink.
// shot_internal_cut joined for the same immediate-tell reason as motion_loop/
// sequence_order_violation: a clip that visibly contains a spliced-in edit
// cut reads as broken software, not an imperfect film, exactly as fast as a
// duplicated person — confirmed real, twice in the same clip, on a shot that
// was supposed to be one continuous take.
// morphing_transformation ADDED (identity-priority audit) — CONFIRMED REAL
// GAP: its own definition above explicitly says a named object or person
// changing identity mid-shot is "exactly as serious a failure as a person's
// face changing" (identity_drift, which WAS already critical) — but it had
// never actually been added to this set, so it sat at the general 0.5
// threshold with only the ordinary retry budget the entire time.
export const CRITICAL_KINDS = new Set<QAFinding["kind"]>([
  "extra_people", "missing_person", "duplicated_object", "blurry_or_soft_focus", "unnatural_motion", "flat_performance",
  "identity_drift", "identity_swap", "background_identity_bleed", "treadmill", "motion_loop", "reversed_motion",
  "sequence_order_violation", "anatomy_error", "body_interpenetration", "reflection_reality_violation",
  "unscripted_event", "shot_internal_cut", "morphing_transformation",
]);
const CRITICAL_SEVERITY_THRESHOLD = 0.3;

// IDENTITY-CRITICAL KINDS — a STRICTER sub-tier of CRITICAL_KINDS above, not
// a replacement for it (both identity_drift and morphing_transformation stay
// IN CRITICAL_KINDS too, for hasCriticalDefect()'s "does this shot deserve
// the extended retry budget at all" question). For a character-driven
// product, a face or a named object visibly becoming someone/something else
// is the single most damaging thing a viewer can see — worse than an
// ordinary critical defect like a blurry frame, which is bad but still
// unmistakably "the same film, one rough shot." A blurry frame reads as a
// technical hiccup; a face that's quietly become a different person reads as
// the product not knowing who its own characters are. That distinction is
// worth a lower bar to trigger on, not just the same 0.3 every other
// critical kind shares.
export const IDENTITY_CRITICAL_KINDS = new Set<QAFinding["kind"]>(["identity_drift", "morphing_transformation"]);
const IDENTITY_SEVERITY_THRESHOLD = 0.2;

export function shouldRegenerate(qa: QAResult, threshold = 0.5): boolean {
  if (!qa.pass) return true;
  return qa.findings.some((f) =>
    IDENTITY_CRITICAL_KINDS.has(f.kind)
      ? f.severity >= IDENTITY_SEVERITY_THRESHOLD
      : CRITICAL_KINDS.has(f.kind)
      ? f.severity >= CRITICAL_SEVERITY_THRESHOLD
      : f.severity >= threshold,
  );
}

/** True when this result flagged ANY critical-tier defect (duplicate/extra
 *  person, a named person vanishing mid-clip, a blurry/unresolved frame, unnatural/incomplete motion, a flat
 *  performance, identity drift, a person/object morphing into someone/something else, OR a swap between two
 *  characters' identities, a treadmill/no-real-progress beat, the clip's own motion looping/
 *  repeating within itself, reversed direction of travel, a structural
 *  anatomy error — extra/missing limbs, warped hands, impossible joints —
 *  OR two people's bodies blending/interpenetrating during physical
 *  contact) — used by the caller to grant this shot extra retry attempts
 *  beyond the normal cap (see 5-videos.ts). identity_drift/
 *  morphing_transformation specifically are gated at the stricter
 *  IDENTITY_SEVERITY_THRESHOLD, not the general CRITICAL_SEVERITY_THRESHOLD
 *  every other kind here uses — see IDENTITY_CRITICAL_KINDS' own comment for
 *  why. Renamed from hasCriticalPersonDefect: it stopped being
 *  person-specific the moment blurry_or_soft_focus (and later
 *  unnatural_motion, flat_performance, identity_drift, treadmill,
 *  motion_loop, reversed_motion, anatomy_error) joined CRITICAL_KINDS. */
export function hasCriticalDefect(qa: QAResult): boolean {
  return qa.findings.some((f) =>
    IDENTITY_CRITICAL_KINDS.has(f.kind)
      ? f.severity >= IDENTITY_SEVERITY_THRESHOLD
      : CRITICAL_KINDS.has(f.kind) && f.severity >= CRITICAL_SEVERITY_THRESHOLD,
  );
}

/** True when specifically a duplicate/extra person (not blur) was found at
 *  critical severity — withCorrection() below needs to know WHICH critical
 *  kind fired, since the two hard-coded override texts address completely
 *  different problems and sending the wrong one back would confuse the retry
 *  (e.g. lecturing the model about duplicated people on a shot whose only
 *  real problem was a blurry opening frame). */
function hasCriticalPersonDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => (f.kind === "extra_people" || f.kind === "duplicated_object") && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the blur/soft-focus critical kind specifically. */
function hasCriticalBlurDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "blurry_or_soft_focus" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the unnatural-motion critical kind specifically. */
function hasCriticalMotionDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "unnatural_motion" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the flat-performance critical kind specifically. */
function hasCriticalPerformanceDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "flat_performance" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the identity-drift critical kind specifically — uses the
 *  stricter IDENTITY_SEVERITY_THRESHOLD (see IDENTITY_CRITICAL_KINDS' own
 *  comment), not the general CRITICAL_SEVERITY_THRESHOLD every other helper
 *  here uses. */
function hasCriticalIdentityDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "identity_drift" && f.severity >= IDENTITY_SEVERITY_THRESHOLD);
}

/** Same idea, for the morphing/identity-transformation critical kind
 *  specifically — also gated at IDENTITY_SEVERITY_THRESHOLD, same reasoning
 *  as hasCriticalIdentityDefect() above. Kept as its own helper rather than
 *  folded into that one because morphing_transformation covers TWO different
 *  things (a person/animal turning into someone/something else, OR a named
 *  OBJECT changing shape/size/color mid-shot) that a face-drift correction
 *  wouldn't address at all if the actual defect was an object. */
function hasCriticalMorphingDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "morphing_transformation" && f.severity >= IDENTITY_SEVERITY_THRESHOLD);
}

/** Same idea, for the identity-swap critical kind specifically — kept
 *  separate from hasCriticalIdentityDefect() above (rather than checking
 *  both kinds in one helper) because withCorrection() needs to know WHICH
 *  one fired: a drifted face and two swapped identities need genuinely
 *  different correction text, and conflating them would send a "render
 *  this character's face exactly as established" instruction to a shot
 *  whose real problem was two correct faces on the wrong bodies. */
function hasCriticalIdentitySwapDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "identity_swap" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the background-identity-bleed critical kind specifically —
 *  kept separate from both identity helpers above because the correction
 *  text is different again: not "render this present character's face more
 *  faithfully" and not "put the right present face in the right position,"
 *  but "an ABSENT character's face must never appear on anyone in this
 *  shot at all." */
function hasCriticalBackgroundBleedDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "background_identity_bleed" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the treadmill critical kind specifically. */
function hasCriticalTreadmillDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "treadmill" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the motion-loop critical kind specifically. */
function hasCriticalMotionLoopDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "motion_loop" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the reversed-motion critical kind specifically. */
function hasCriticalReversedMotionDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "reversed_motion" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the sequence-order critical kind specifically — kept
 *  separate from hasCriticalReversedMotionDefect() above because the
 *  correction is a different shape: reversed_motion is "make this ONE
 *  motion go the other way," this is "keep these SEVERAL beats in their
 *  stated order," and conflating them would send a direction-of-travel
 *  correction to a shot whose real problem was two discrete actions
 *  swapping places. */
function hasCriticalSequenceOrderDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "sequence_order_violation" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the reflection/reality-boundary critical kind specifically. */
function hasCriticalReflectionDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "reflection_reality_violation" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the unscripted-event critical kind specifically. Only
 *  meaningfully reachable via the definition's own severity>=0.8 "wholesale
 *  fabrication" tier in practice (CRITICAL_SEVERITY_THRESHOLD is 0.3, but a
 *  minor incidental beat the definition asks to be scored at moderate
 *  severity would rarely clear even that) — kept as its own helper anyway,
 *  matching every other critical kind, rather than folding it into a
 *  generic bucket. */
function hasCriticalUnscriptedEventDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "unscripted_event" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the shot-internal-cut critical kind specifically. */
function hasCriticalInternalCutDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "shot_internal_cut" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the anatomy-error critical kind specifically. */
function hasCriticalAnatomyDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "anatomy_error" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

/** Same idea, for the body-interpenetration critical kind specifically. */
function hasCriticalInterpenetrationDefect(qa: QAResult): boolean {
  return qa.findings.some((f) => f.kind === "body_interpenetration" && f.severity >= CRITICAL_SEVERITY_THRESHOLD);
}

// --- WHOLE-FILM IDENTITY CONSISTENCY (periodic, cheap, keyframe-level) --------
//
// Everything above judges a rendered CLIP against ITS OWN shot intent (and,
// via keyframeUrl, that shot's own keyframe). That has no way to catch SLOW
// drift that compounds across MANY shots, because it never looks back at the
// character's ORIGINAL reference photos — a face can drift a tiny amount
// every shot and pass every individual check while still ending up a
// different-looking person by shot 50. That's a real risk for a 10-30 minute
// film (a long scene can run dozens of shots) that a 1-minute test never
// exercises. This is a separate, much cheaper check than the clip QA above —
// one still KEYFRAME compared to the reference sheet, no frame sampling or
// ffmpeg needed — run periodically (see identityReanchorInterval in
// 4-images.ts) as a direct audit against the ground truth, not against
// whatever the reference chain has quietly become.
const IDENTITY_CONSISTENCY_SYSTEM = `You are a continuity supervisor checking ONE thing: does a character in a
newly generated image still look like the SAME person shown in their reference photos?
You are shown, in order: (1) the character's ORIGINAL reference photos (multiple angles), then (2) ONE new image from later in the film.
Compare ONLY identity — face shape, eyes, nose, jawline, skin tone, hair colour/style, apparent age. Ignore pose, expression, camera angle, lighting, and wardrobe (clothing can legitimately change; identity should not).
Output ONLY JSON, no prose:
{"pass": boolean, "detail": string}
Set pass=false only if the person in the new image is noticeably a DIFFERENT-looking person than the reference photos — a different face shape, a different apparent age, or someone else entirely. A close, faithful likeness is a pass even with a different expression, angle, or outfit.`;

/**
 * Compare a shot's keyframe directly against a character's ORIGINAL reference
 * sheet — not against the shot's own intent, and not against whatever the
 * previous-shot reference chain has drifted to. Cheap (one image, one vision
 * call) precisely so it's affordable to run periodically across a long film.
 */
export async function checkIdentityConsistency(args: {
  vision: VisionClient;
  referenceUrls: string[];
  newImageUrl: string;
  characterName: string;
}): Promise<{ pass: boolean; detail: string }> {
  return args.vision.inspectJson<{ pass: boolean; detail: string }>({
    system: IDENTITY_CONSISTENCY_SYSTEM,
    user: `Character: ${args.characterName}. Does the new image still show this same person as the reference photos?`,
    imageUrls: [...args.referenceUrls, args.newImageUrl],
  });
}

/** Append the QA correction to the motion/prompt string for the retry. For
 *  each critical-tier failure category, the vision model's own free-text
 *  "correction" is backed up with a hard-coded, maximally explicit override --
 *  these are the categories where a generic positive directive isn't strong
 *  enough given how badly they damage the film if they recur. The overrides
 *  are independent (a shot can trigger any combination of them) so each is
 *  only appended when its OWN specific defect actually fired -- otherwise a
 *  blur-only failure would incorrectly get lectured about duplicated people
 *  or robotic motion it never had, diluting the correction with irrelevant
 *  instructions instead of focusing the retry on the real problem. */
export function withCorrection(motion: string, qa: QAResult): string {
  const parts = [motion];
  if (qa.correction) parts.push(`Correction for this retry: ${qa.correction}`);
  if (hasCriticalPersonDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's HEADCOUNT was wrong — it showed more people " +
      "than this shot's stated cast. This is the single worst possible failure for this shot and must not " +
      "repeat, and it must not repeat FOR EITHER of its two forms, which are equally serious: either the same " +
      "named character rendered twice or fused into one body (duplication), OR a completely NEW figure who " +
      "resembles nobody already named appearing anywhere in frame at all (an unscripted extra) — count every " +
      "human figure in the new render, foreground and background, and confirm the total matches this shot's " +
      "stated headcount EXACTLY, with no excess of either kind. Render EXACTLY ONE instance of each named " +
      "character, each with one complete, separate body — one head, two arms, two legs — nowhere else " +
      "duplicated, blurred, ghosted, or overlapping, AND render NO additional person beyond that exact named " +
      "list, however minor, distant, or blurred. If a background crowd is present, every background figure " +
      "must be a visibly DIFFERENT individual from the named character(s): a different face, different hair, " +
      "different clothing — but the crowd's own stated scale/density still applies; do not add a figure the " +
      "shot never called for at all. No person, named or background, ever shares the same face as another " +
      "person in this frame, and no person appears who was never named as present in the first place.",
    );
  }
  if (hasCriticalBlurDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render was significantly blurry, smeared, or out of " +
      "focus and never resolved into a sharp, legible image. This must not repeat. Render a crisp, sharp, " +
      "in-focus image throughout the ENTIRE clip from its very first frame — no soft, melted, or unresolved " +
      "opening, no persistent blur anywhere in the shot. This is distinct from intentional motion blur on a " +
      "genuinely fast-moving subject or camera pan, which is fine; the frame itself must never look broken " +
      "or unfinished.",
    );
  }
  if (hasCriticalMotionDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's motion looked synthetic rather than like a " +
      "real human body — stiff/robotic movement, discontinuous or juddering motion, an action that never " +
      "reached its natural completion, or timing that does not match how the action actually takes to " +
      "physically happen. This must not repeat. Every movement must accelerate and decelerate the way a real " +
      "body's weight and momentum actually do, move continuously through the space between poses rather than " +
      "jumping between them, and the shot's action must be fully, visibly finished by its last frame — not " +
      "left partway through. Match the actual physical duration a human body needs to perform this specific " +
      "action; do not compress or stretch it to fit the clip.",
    );
  }
  if (hasCriticalPerformanceDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's face and body did not actually sell the " +
      "emotion or line this shot calls for — a flat, neutral, or generic expression where a real actor would " +
      "show something specific, or a mouth that was not visibly, continuously articulating the spoken " +
      "dialogue in a natural speech rhythm. This must not repeat. The face must show the SPECIFIC named " +
      "emotion in real muscle detail throughout the clip (the brow, the eyes, the set of the jaw or mouth, " +
      "exactly as described) and hold or build it, never drift toward neutral partway through. Any spoken " +
      "line must show the lips and jaw actively, continuously shaping each word in sync with the dialogue, " +
      "from the first word to the last — never a static or barely-moving mouth during speech.",
    );
  }
  if (hasCriticalIdentityDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's character no longer matched their own " +
      "established identity — a noticeably different face shape, features, hair, or apparent age than this " +
      "same character in every other shot of this film, OR a notable accessory from their reference photo " +
      "(glasses, a distinctive hat, jewelry, a beard) was missing or visibly different. This must not repeat. " +
      "Render this character's face EXACTLY as already established — the same face shape, eyes, nose, jawline, " +
      "skin tone, hair colour and style, and apparent age as their reference — do not reinterpret or " +
      "approximate it. If their reference photo shows a specific accessory, it is part of who they are, not " +
      "optional wardrobe — include it, unchanged, exactly as shown. This is the single most damaging failure " +
      "this film can have: it must read as unmistakably the same person, shot to shot.",
    );
  }
  if (hasCriticalMorphingDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render showed a person, animal, or named object " +
      "visibly turning into someone or something else mid-clip — a face becoming a different person, OR a " +
      "named object (a held item, a piece of clothing, a prop) changing its real-world shape, size, or color " +
      "with no on-screen pickup, hand-off, or cause to explain it. This must not repeat. Every person and " +
      "every named object must keep EXACTLY the same identity and appearance from the clip's first frame to " +
      "its last — the same face, the same object shape/size/color — with no unexplained transformation of " +
      "any kind.",
    );
  }
  if (hasCriticalIdentitySwapDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render had TWO NAMED CHARACTERS' IDENTITIES SWAPPED " +
      "between the positions/roles this shot assigns them (e.g. the customer's face rendered on the " +
      "shopkeeper's side of the counter, and vice versa) — this is NOT a face drifting, it is two correct " +
      "faces on the wrong bodies. This must not repeat. Whichever position or role this shot assigns to a " +
      "named character, THAT character's own reference face — and only that character's — must appear there. " +
      "Check each position against its assigned character's reference individually before finalizing: the " +
      "customer's position gets the customer's face, the shopkeeper's position gets the shopkeeper's face, " +
      "never crossed, never traded, regardless of how correctly each individual face is rendered elsewhere " +
      "in the frame.",
    );
  }
  if (hasCriticalBackgroundBleedDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render showed a BACKGROUND or INCIDENTAL person — " +
      "someone who is not one of this shot's named, present characters — wearing the FACE of a different, " +
      "named character who is not even in this shot. This must not repeat. Every background, incidental, or " +
      "crowd figure in this shot must be given their OWN distinct, unrelated face and appearance — never the " +
      "face of any named character from this film's cast, whether or not that character's reference photo was " +
      "shown to you, unless that specific character is actually stated to be present in this shot. A named " +
      "character's identity belongs ONLY to that character; it must never be reused, copied, or approximated " +
      "for anyone else, anywhere in this film.",
    );
  }
  if (hasCriticalTreadmillDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's subject did not make real progress despite " +
      "the shot describing continuous self-locomotion (running, walking, climbing) — the background stayed " +
      "static, or the body's position relative to its surroundings barely changed across the clip. This must " +
      "not repeat. The camera and background must show real, continuous ground being covered at a speed " +
      "matching the subject's actual pace — streets, walls, steps, or terrain visibly moving past or receding " +
      "throughout, ending at a clearly different position than where the clip began. A subject who appears to " +
      "move in place, with the world around them frozen, is not an acceptable result under any circumstance.",
    );
  }
  if (hasCriticalMotionLoopDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's own motion repeated or restarted within the " +
      "SAME clip — a gesture, step cycle, or action played out, then happened again, as if the render looped " +
      "back to an earlier point instead of continuing forward. This must not repeat. Render this shot's action " +
      "EXACTLY ONCE, start to finish, with continuous forward progress the entire clip — the motion must never " +
      "circle back to a pose, position, or ground it has already passed through earlier in this same clip. " +
      "Once the action completes, hold its natural end state (or move on to whatever comes next) — never repeat " +
      "the cycle, and never let the render appear to restart partway through. If this shot's own motion text " +
      "contains a sentence beginning 'ALREADY COMPLETE — DO NOT RE-PERFORM', that action was already finished by " +
      "the PREVIOUS shot — this clip must open ALREADY IN that finished state and never depict the named action " +
      "happening from its own beginning at any point in this clip, even once.",
    );
  }
  if (hasCriticalReversedMotionDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render's subject moved in the WRONG direction — " +
      "described as approaching or coming closer, but shown receding or backing away instead, or the walk/run " +
      "itself read as if played in reverse. This must not repeat. If the shot describes approaching or coming " +
      "closer, the subject must visibly get closer to camera/destination across the clip, with a normal " +
      "forward gait — weight settling forward into each step, the toe leading before the heel, limbs extending " +
      "forward and swinging back naturally, never the reverse of that sequence. The direction of travel must " +
      "match the shot's own stated intent exactly.",
    );
  }
  if (hasCriticalSequenceOrderDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: this shot describes MULTIPLE separate, ordered beats (e.g. " +
      "'opens the door, then steps through, then sets the bag down'), and the previous render played them " +
      "out in the WRONG ORDER — a later-described beat happened before an earlier one, or the sequence was " +
      "shuffled. This must not repeat. Render EVERY named beat in this shot in the EXACT SAME ORDER the " +
      "motion text states them, start to finish — each beat must be visibly, fully complete before the next " +
      "one begins, in the stated sequence and no other. Do not let a later beat start early, overlap with an " +
      "earlier one, or occur first.",
    );
  }
  if (hasCriticalReflectionDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render violated the reflection/reality boundary — " +
      "either an object or person appeared to cross FROM a reflected image INTO real space (or the reverse), " +
      "as if the glass were a passage between two places, OR the reflective surface's own nature (mirror, " +
      "window, plain doorway) changed partway through the clip with nothing describing that as an intended " +
      "state change. This must not repeat. A mirror, window, monitor, or screen is a FLAT PICTURE of a second " +
      "view of the SAME real space — nothing may ever emerge from it into real space or vice versa, and the " +
      "surface itself must stay exactly the same kind of surface, unchanged, from the clip's first frame to " +
      "its last. Any object or hand belongs entirely to real space throughout; the reflection only shows a " +
      "second, flat picture of that same real action.",
    );
  }
  if (hasCriticalUnscriptedEventDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render substituted a DIFFERENT, invented sequence of " +
      "actions for what this shot's own text actually describes — not one small extra flourish, but a " +
      "wholesale replacement of the described beat. This must not repeat. Render EXACTLY the action described " +
      "in this shot's own description/motion/startFrame/endFrame text, start to finish, with no invented " +
      "events, no substituted actions, and no additional beats this shot's own text does not name. If the " +
      "text says a character picks something up and turns to leave, that is the ENTIRE action — do not add, " +
      "substitute, or extend it with anything the text does not say.",
    );
  }
  if (hasCriticalInternalCutDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render contained a HARD DISCONTINUITY partway through " +
      "the clip — a sudden jump in head/body position, camera angle, or background with no continuous motion " +
      "connecting the two, as if two separate shots had been spliced together into one clip. This must not " +
      "repeat. Render this ENTIRE clip as one single, unbroken, continuous take — no internal cut, no scene " +
      "change, no camera or subject position jumping partway through. Any change in position or angle must " +
      "happen as smooth, continuously visible motion the viewer can actually watch happen, from the first " +
      "frame to the last, never as an instantaneous jump between two different positions.",
    );
  }
  if (hasCriticalAnatomyDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render showed a structural anatomy error — an extra " +
      "or missing limb or finger, a hand with fused/webbed/melted fingers, a joint bent at an angle no real " +
      "human body can reach, a limb warped or melting into itself or another body, or a face with a " +
      "structurally wrong number or placement of features. This must not repeat. Every body must have exactly " +
      "the correct anatomy for a real human: two arms, two legs, five fingers per hand held as separate, " +
      "distinct digits, joints bending only the way a real joint can, and a face with exactly one of each " +
      "feature in its correct place. Pay particular attention to hands — render them fully formed and " +
      "anatomically correct in every frame they appear in, including when small or partially visible.",
    );
  }
  if (hasCriticalInterpenetrationDefect(qa)) {
    parts.push(
      "CRITICAL, NON-NEGOTIABLE CORRECTION: the previous render showed two people's bodies (or, during an " +
      "object handoff, their HANDS specifically) blending or passing through each other during physical " +
      "contact (an embrace, handshake, carry, or a hand-to-hand exchange of an object) — a face passing " +
      "through the other person's head, hair or skin bleeding from one body into the other, or two hands " +
      "overlapping instead of meeting cleanly at the moment an object changes hands. This must not repeat. " +
      "During any physical contact OR object handoff between two named characters, both must remain two " +
      "separate, complete bodies — one head and two arms each, two distinct hands — with a clear, visible " +
      "seam or gap at the exact point of contact and nowhere else. Nothing about one person's body may pass " +
      "through, merge with, or blend into the other's, even briefly, even in a single frame.",
    );
  }
  return parts.join("\n\n");
}