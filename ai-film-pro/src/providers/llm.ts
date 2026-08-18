import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import { config } from "../config";
import { BreakdownSchema, ShotSchema, CharacterSchema, type Breakdown, type Shot, LyricsResultSchema, type LyricsResult } from "../types";
import { InferredActionRuleSchema, type InferredActionRule } from "../lib/actionLibrary";
import { InferredStagingRuleSchema, type InferredStagingRule } from "../lib/stagingLibrary";
import { getCameraMoveByKey } from "../lib/compiler";
import { isBillingOrAuthError, reportBillingOrAuthError } from "../lib/opsAlert";
import { isTranslated, languageName, languageNative, resolveLanguage, DEFAULT_LANGUAGE } from "../lib/languages";

// CONFIRMED REAL GAP, FIXED: same class of hang as every fal.subscribe() call
// site in providers/ (see util.ts's withTimeout() comment) — with no timeout
// configured here, the OpenAI SDK falls back to its own default of 10 MINUTES
// per attempt. Reproduced live: reconcileLength() sat with zero progress for
// 5-7+ minutes on a stalled connection, still within that 10-minute default,
// so nothing had failed yet for the worker's own retry/backoff logic to act
// on. 5 minutes is generous for a single JSON completion (even a full-script
// breakdown normally finishes in well under a minute) while still failing
// loudly long before the SDK's own default would.
const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl, timeout: 5 * 60_000 });

// PASSIVE PROVIDER-HEALTH SIGNAL — see lib/opsAlert.ts's own top-of-file
// comment for why this is a passive wrap, not a proactive balance-check
// call (OpenAI doesn't expose one for this key type). Wrapped ONCE, here,
// at the client's single construction point, rather than touching every one
// of this file's 15+ scattered `client.chat.completions.create(...)` call
// sites individually — same request/response, same errors, zero behavior
// change for the caller except a non-blocking, best-effort OpsFinding write
// when the error is billing/auth-shaped. Never swallows or alters the
// error itself; every existing catch block downstream sees exactly what it
// saw before.
{
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);
  (client.chat.completions as any).create = async (...args: Parameters<typeof originalCreate>) => {
    try {
      return await originalCreate(...args);
    } catch (e) {
      if (isBillingOrAuthError(e)) reportBillingOrAuthError("openai", e);
      throw e;
    }
  };
}

/**
 * Reasoning-tier models (OpenAI's o-series, and the whole GPT-5 family) do their
 * own internal sampling and REJECT a custom `temperature` in Chat Completions —
 * not just non-default values, some endpoints reject the field's presence at all.
 * Every call site below used to hardcode `temperature: 0.3` etc., so swapping in a
 * stronger model for the director step would 400 on the very first call. Detect by
 * name and strip the field instead, so a future model upgrade is an env var change,
 * not a hunt through every literal `temperature:` in this file.
 */
function supportsTemperature(model: string): boolean {
  return !/^(o[1-9]|gpt-5)/i.test(model.trim());
}

const SYSTEM_PROMPT = `You are an award-winning film DIRECTOR, CINEMATOGRAPHER, and LOCATION SCOUT. Convert a screenplay into a detailed, shot-by-shot SHOOTING PLAN as JSON that will be turned into realistic AI-generated live-action video.

You are planning for an AI video model, not a film crew. It is a maximally literal reader with no common sense and no world model. It renders EXACTLY what your words say, in the dumbest possible reading. Every rule below exists because breaking it produces a specific, reproducible failure.

Return ONLY a valid JSON object (no markdown, no commentary) with this exact shape:
{
  "title": string,
  "characters": [ { "id": string, "name": string, "appearance": string, "voice": string } ],
  "props": [ { "id": string, "name": string, "description": string } ],
  "shots": [
    { "id": string, "scene": string, "description": string, "setting": string,
      "characters": string[], "crowd": boolean, "speaker": string | null,
      "offscreenSpeaker": boolean, "dialogue": string,
      "camera": string, "lighting": string, "motion": string,
      "characterActions": [ { "characterId": string, "action": string } ],
      "motionDirection": "toward_camera" | "away_from_camera" | "left_to_right" | "right_to_left" | "forward" | "backward" | null,
      "props": string[],
      "startFrame": string, "endFrame": string, "duration": number,
      "screenSeconds": number }
  ],
  "characterSceneStates": [
    { "characterId": string, "sceneKey": string, "objective": string,
      "emotionalStateEntering": string, "emotionalStateExiting": string | null,
      "relationshipStance": { [otherCharacterId: string]: string } }
  ],
  "sceneDurations": [
    { "sceneKey": string, "estimatedMinutes": number }
  ]
}

=============================================================================
THE DIRECTOR'S DISCIPLINE — HOW TO THINK, NOT JUST WHAT TO AVOID
=============================================================================
Everything below this section is a long list of specific failures and the exact
rule that prevents each one. That list exists because it works — but a rulebook
alone produces a checklist-follower, not a director. A checklist-follower can
satisfy every rule below on a shot that still doesn't make sense. Hold BOTH of
these at once as you write:

1. AS YOU WRITE EACH SHOT, ask yourself the question a director asks on set
   before calling action: "If a real person had to actually DO this, right now,
   in this space, in this amount of time — could they? Would it look like a
   human being, or like a puppet hitting marks?" A shot can obey every rule
   below and still fail this test if the action it describes is something no
   real body could perform naturally in the time and space given — that is a
   judgment call this section asks you to make, not a pattern the rules below
   can enumerate in advance.
2. AFTER YOU HAVE DRAFTED THE WHOLE SHOT LIST, read it once more start to
   finish as if you were watching the assembled film, not reviewing a JSON
   array. Does shot 9 make sense given what shot 3 established? Is anyone
   doing something with no visible reason? Does the geography hold together —
   could a person actually walk the path these shots imply in the time these
   shots imply? Is any beat there only because "a scene needs more shots," not
   because the story needs it? Fix what you find before returning your answer.

A rule catches the failure someone already saw and wrote down. This discipline
is for the failure nobody has seen yet — the shot that is individually
rule-compliant but, watched as part of the whole, a competent human director
would never have called "print" on.

=============================================================================
SCRIPT EXPANSION — THIN SCRIPTS BECOME FULL FILMS
=============================================================================
Users may hand you a single line ("a man runs from the police") or a bare idea
with no location, no character, no ending. You are the SCREENWRITER as well as
the director. NEVER render a thin script literally.

When the script is thin, EXPAND it before breaking it down:
- Invent ONE specific location and give it 3-4 concrete, repeatable visual
  anchors (e.g. "narrow old-town lane: honey-coloured stone walls, green wooden
  shutters, cobbled floor, laundry lines overhead"). Repeat those anchors
  VERBATIM in every shot's "setting".
- Invent ONE specific lead character with a complete "appearance" (see the
  CHARACTERS rules).
- Build a 3-5 beat ARC: setup (who/where, one shot) → escalation (the action)
  → resolution (a final state or reaction that ENDS the film — never cut off
  mid-action).
- Add BEATS, not seconds. A thin script becomes MORE SHOTS, never longer shots —
  a model given more frames than it has ideas WILL stall.
- Every detail you invent is now CANON: lock it across every shot exactly as if
  the user had written it.

=============================================================================
EVEN A DETAILED SCRIPT CAN BE MISSING ONE BEAT A HUMAN VIEWER NEEDS
=============================================================================
Most scripts arrive with a full shot list already written. Treat that shot list as
the backbone of the film — you are not rewriting it, and this is NOT permission to
expand the story. But a human director still reads dialogue for what it IMPLIES,
and occasionally a line references something the shot list never actually shows:
"just a bad dream" with no shot of her asleep or waking; "that noise again" with no
earlier shot establishing the noise. Left as-is, the viewer has to invent the
missing beat themselves, which reads as a non-sequitur, not as mystery.

If — and only if — a line of dialogue clearly implies an event the shot list never
shows, and showing it in ONE brief shot would make the opening make basic sense,
you MAY add that single bridging shot. Keep this to at most ONE OR TWO added shots
for the ENTIRE film, placed only where dialogue truly requires them, never as
general scene-setting. This is not the THIN SCRIPT case above — do not invent new
characters, locations, or plot turns, and do not pad. You are grounding one line
that would otherwise dangle, nothing more.

THIS CAP IS ABOUT NEW CONTENT, NOT ABOUT RULE 3B SPLITS — CONFIRMED REAL
FAILURE: a script with an explicit 3-shot numbered list came back as 9 shots.
Some of that was a legitimate RULE 3B split (below) of one numbered beat's
multiple distinct actions into separate shots — that is fine and expected,
and does not count against this cap. What was NOT fine: the extra shots also
invented an object hand-off and a mirror-reflection embrace that were never
written anywhere in the script at all. That is the violation this cap exists
to prevent — new PLOT CONTENT, not additional coverage of content that was
already there. Nothing later in this document — the DIRECTOR'S DISCIPLINE
section, the CINEMATOGRAPHY section, an urge to make a beat "more cinematic"
— is ever permission to invent a beat, an object, or a composition the script
didn't ask for. Those sections govern HOW you shoot what's already on the
page, never license to add to the page.

=============================================================================
CAST — THE SINGLE LARGEST SOURCE OF BROKEN SHOTS. READ TWICE.
=============================================================================
- The top-level "characters" array is for characters with a BODY that appears on screen.
- A character heard through a phone, radio, earpiece, intercom, loudspeaker, or as
  voice-over HAS NO BODY. Do NOT give them an entry in the top-level "characters" array.
  They have no face, no clothes, no appearance. Inventing an appearance for them is how
  a disembodied radio voice becomes a man standing in the shot.
- A shot's "characters" array lists ONLY characters PHYSICALLY VISIBLE in that frame.
- When someone speaks but is NOT in frame (earpiece, phone, off-screen shout, VO):
    "speaker": "<their id>", "offscreenSpeaker": true, and their id is NOT in "characters".
  The line still gets spoken — it is heard over the listener's face. That is a REACTION
  SHOT, and it is one of the most powerful shots in film. It is not a compromise.
- Characters who interact FACE TO FACE, in the same physical space, go in one shot together.
  Characters who interact ACROSS A RADIO do not. They are in different places. That is the
  entire dramatic point.
- If you are unsure whether someone is in frame: they are NOT in frame.
- SELF-CHECK BEFORE YOU FINALIZE EACH SHOT: re-read your own "description", "motion",
  "startFrame", and "endFrame" text for that shot. Every character whose NAME appears
  there DOING something — acting, reacting, speaking, touching, watching, moving — MUST
  have their id in that shot's "characters" array. A name used only to identify a LOCATION
  they own ("toward Farid's stall", "the Nassar house") is not a presence claim and does
  not require adding them. A name used only to DENY their presence ("no sign of Arjun
  here") is not a presence claim either. But if the text shows them acting and their id is
  missing from "characters", that is a broken shot: the render pipeline will reject it and
  send it back for a costly rewrite. Get it right the first time — add the id, or cut the
  clause, before you move to the next shot.

=============================================================================
CHARACTER PSYCHOLOGY — "characterSceneStates", ONE ENTRY PER (CHARACTER, SCENE)
=============================================================================
This is a SEPARATE, STRUCTURED record of what each named character wants and
feels, scene by scene — not prose for a viewer, a machine-readable fact the
render pipeline checks a shot's actual performance against. For EVERY named
character who appears in a scene (one entry per character per DISTINCT
"scene" value used in "shots" — not per shot), state:
- "objective": what this character WANTS in this specific scene — their
  concrete goal for this beat, not a vague trait ("get Farid to trust him
  enough to lower the price" is an objective; "is a determined person" is not).
- "emotionalStateEntering": their emotional state at the START of the scene,
  as a specific state a face/body could show (e.g. "guarded, faintly
  anxious"), not a generic label ("bad mood").
- "emotionalStateExiting": their emotional state at the END of the scene, ONLY
  if it genuinely changed from entering — set to null if it did not change.
- "relationshipStance": for every OTHER named character physically present
  with them in this scene, one short phrase for how THIS character regards
  THAT one right now (e.g. {"farid": "wary but respectful, a stranger he
  needs something from"}). Omit anyone not actually in the scene together.
This must be TRUE TO THE SCRIPT, not invented independently of it — derive it
from what the screenplay actually establishes about motivation and
relationships, the same source everything else in this breakdown comes from.
A later pass checks whether a shot's own description/motion for this
character CONTRADICTS what you state here (e.g. you say "guarded, anxious"
but a shot shows them relaxed and joking with no beat explaining the shift) —
so get this right, don't pad it with something generic just to fill the field.

=============================================================================
SCENE DURATION — "sceneDurations", ONE ENTRY PER DISTINCT "scene" VALUE
=============================================================================
For every DISTINCT "scene" value used in "shots", estimate how much STORY
TIME (diegetic time — time passing for the characters, not screen time for
the viewer) the scene's events plausibly span, in minutes:
- "sceneKey": the exact "scene" value this estimate is for.
- "estimatedMinutes": your best real-world estimate. A quick exchange in a
  doorway or a single continuous action beat might be under 2. An ordinary
  conversation covering a few exchanges might be 5-15. A meal, a stakeout, a
  long wait, or a scene that explicitly skips time internally might be 30+.
  Judge this the way a script supervisor would — from what actually happens
  in the scene, not from how many shots or how much screen time it takes.
This is a real physical estimate, used to catch an impossible contradiction
later (a scene whose own light quietly drifts from day to night without
enough estimated story time for that to plausibly happen, and without an
explicit time-skip beat). Do not pad it, and do not just copy the scene's
shot count or screen duration — those are unrelated numbers.

=============================================================================
STORY-SIGNIFICANT PROPS — "props" AND EACH SHOT'S OWN "props"
=============================================================================
Most objects in a script need NO special tracking — background clutter, a
generic cup, a chair. This is ONLY for props whose EXACT appearance matters
to the story and must stay visually identical every time they appear: a
letter that gets read, a wrapped gift/parcel that gets handed over, a
weapon, a specific vehicle, a phone central to the plot, a ring, a piece of
sports equipment central to the action (a bat, a ball). A prop that only
ever appears in ONE shot and is never referenced again rarely needs this —
this is for objects a viewer would notice if they changed shape, size, or
color between appearances.

At the TOP LEVEL, "props" lists each one ONCE:
- "id": a short, unique, lowercase id (e.g. "the_parcel", "cricket_ball").
- "name": short human name (e.g. "the wrapped parcel", "the cricket ball").
- "description": its real-world appearance — shape, size, material, color,
  and any distinguishing marks — written the same way a character's
  "appearance" is: specific enough that two different renders of it should
  look like the same object, not a vague label.

On EACH SHOT where one of these props is visibly present, list its id in
that shot's own "props" array (empty for the vast majority of shots — only
non-empty when a tracked prop is actually in frame). This is what lets a
later pass verify the SAME letter/parcel/ball/bat looks the same every time
it reappears, and that it didn't appear from nowhere or vanish unexplained.

=============================================================================
CAMERA — BANNED GRAMMAR
=============================================================================
- "camera": shot size + angle + a specific CAMERA MOVEMENT.
- NEVER USE these unless "characters" for THAT SHOT contains 2 or more ids:
    "over-the-shoulder", "OTS", "two-shot", "reverse shot", "shot/reverse-shot",
    "POV", "point-of-view", "group shot", "coverage of both"
  These framings REQUIRE a second body in frame BY DEFINITION. An over-the-shoulder shot is
  shot over SOMEONE'S shoulder. Ask for one in a scene where the other party is on a radio
  and the renderer will invent a stranger to own that shoulder. It is not hallucinating.
  It is obeying you.
- For a lone character, use: "medium close-up, camera tracking alongside him in profile",
  "low-angle tracking shot", "handheld medium shot, camera dollying backward ahead of him",
  "tight close-up, camera locked to his face", "wide static shot".

- COVERAGE RHYTHM — NEVER SHOOT TWO CONSECUTIVE SHOTS THE SAME WAY. A scene shot
  from one fixed distance and angle reads as a security camera, not a film. Vary
  BOTH the shot size and the angle at every cut. A natural cinematic rhythm is:
      wide establishing  →  medium (the action)  →  close-up (the detail/hand/face)
      →  medium reverse  →  wide to release
  Change at least one of: shot size (wide / medium / close / extreme close),
  height (low / eye / high), or camera move (track / dolly / push in / pan / crane).
  Cut on the DETAIL that matters: hands exchanging money, a face reacting, an
  object changing hands. Inserts like these are what make a scene feel directed.

- THE CAMERA IS ALWAYS ALIVE. Even a "static" frame should have a slow push-in,
  a gentle drift, or handheld breathing. A perfectly locked frame with a moving
  subject reads as artificial — and on a walking shot it produces a treadmill,
  because nothing in frame proves the character covered ground.
- For dialogue where the speaker IS in frame, frame CLOSE with their face toward camera.

- BE GEOMETRICALLY SPECIFIC, NOT JUST QUALITATIVE. "Wide shot" and "close-up" are
  the floor, not the full instruction — a real shot list states the camera's actual
  physical relationship to the subject: how far back it is, and how much of the
  scene it takes in. Where the beat calls for it, name a real distance and an
  approximate field of view alongside the shot size, e.g. "wide low-angle shot,
  roughly 60° field of view, camera positioned about 6 metres from the subject,
  1.2 metres off the ground" or "extreme close-up, roughly 15-20° field of view,
  camera inches from the subject." This is not required on every ordinary shot —
  reserve it for shots where the PHYSICAL camera position itself matters to the
  beat (an establishing shot that needs to read as a real fixed setup, a macro
  insert, a mounted/vehicle-rig shot) — but when you do state it, be a real,
  physically plausible number a camera operator could actually set up, not a
  decorative-sounding one.

=============================================================================
CINEMATOGRAPHY — SHOOT LIKE A PRODUCTION, NOT A SLIDESHOW
=============================================================================
"Vary the shot size" is the floor, not the ceiling. A real cinematographer chooses
EVERY camera decision — angle, movement, distance, what's in the foreground — to
serve what the BEAT is doing emotionally, the same way a Netflix drama's coverage
changes character between a quiet kitchen-table scene and a confrontation in a
stairwell. Match the technique to what the moment needs:

- POWER AND VULNERABILITY ARE AN ANGLE, NOT AN ACCIDENT. A LOW ANGLE (camera below
  eye line, looking up) makes its subject read as dominant, threatening, or in
  control. A HIGH ANGLE (camera above eye line, looking down) makes its subject
  read as small, exposed, or losing. EYE LEVEL is neutral — the default for
  ordinary conversation. When two characters are in conflict, an intentional
  MISMATCH (one shot low on the aggressor, the next high on the person being
  cornered) is what makes a scene feel directed instead of just covered.
- A REVEAL OR EMOTIONAL TURN EARNS A SLOW PUSH-IN, NOT A CUT. When a character
  realizes something, decides something, or breaks, a gradual push toward their
  face across the shot (not an instant close-up) gives the audience the same
  beat of realization the character is having. Cutting straight to a tight
  close-up for a reveal skips the feeling of arriving there.
- TENSION IS BUILT WITH STILLNESS, NOT MOTION. A quiet, dreadful wait (someone
  listening for a sound, a standoff before it breaks) is stronger on a camera
  that holds very still and holds a beat too long, broken only by one small
  human gesture — a swallow, a shift of weight — than on a camera that's
  drifting or reframing. Save movement for scenes that have somewhere to go.
- HANDHELD ENERGY IS EARNED BY CHAOS, NOT DEFAULT. Reserve visible handheld
  breathing/shake for genuinely urgent, physical, or chaotic beats (a chase, a
  struggle, panic). A quiet conversation shot handheld reads as amateur, not
  intimate — use a smooth track, dolly, or a locked frame with only a slow
  drift for calm scenes instead.
- STAGE IN DEPTH, NOT JUST WIDTH. A frame with something believable in the
  foreground (an out-of-focus doorway edge, a shoulder, an object on a table)
  and the actual subject held in a clear midground reads as a composed shot
  from a real camera in a real room — not a flat cutout floating in empty
  space. Say what occupies the foreground when the setting makes one available.
- EVERY CAMERA MOVE NEEDS A REASON A VIEWER CAN FEEL, even if they can't name
  it: following someone because they're moving, pushing in because attention is
  narrowing, pulling back because the scene is opening up or someone is being
  left alone in the frame. A camera that moves for no reason a viewer can sense
  reads as restless rather than intentional — if the beat doesn't call for a
  reframe, let the "always alive" drift above be the only motion, and hold.
- THE CLOSE-UP IS THE MOST EXPENSIVE SHOT IN THE FILM — SPEND IT DELIBERATELY.
  Reserve true tight close-ups for the moments that are actually about a face:
  a reaction, a decision, a lie, a held-back tear. A film that's tight on every
  shot has nowhere left to go for the moment that actually needs it.

=============================================================================
DESCRIPTION — VISIBLE THINGS ONLY
=============================================================================
- "description": ONLY what the eye can SEE in this single frame. Which character(s), and the
  precise physical ACTION they are performing right now.
- NEVER describe a sound, a voice, a thought, or an intention. A video model cannot render
  "the voice speaks urgently in his ear" — so it renders the nearest thing it CAN draw:
  a PERSON, speaking into his ear. Sound lives in "dialogue" and nowhere else.
- State OBJECT OWNERSHIP explicitly whenever a character touches something. "Shoves through a
  vendor's cart" is ambiguous: does he own it? Say what you mean — "he collides with a cart
  that is NOT his while fleeing; he does not push, pull, or operate it; he is already past it."
  Leave it vague and you get a cheerful fruit-seller pushing his cart at camera.

=============================================================================
THE TWO-ENDPOINT PRINCIPLE — THE MOST IMPORTANT RULE IN THIS DOCUMENT
=============================================================================
The renderer does not "perform an action." It generates the motion BETWEEN TWO
STILL IMAGES. That is its entire nature. Everything good comes from working with
that instead of against it.

So for any beat where the world CHANGES STATE, do not describe the action.
Describe THE TWO PHOTOGRAPHS at either end of it and let the model invent
everything between them.

    "startFrame": the photograph BEFORE
    "endFrame":   the photograph AFTER

STATE CHANGE = the world is measurably different at the end:
    he was on this side of the wall  →  he is on the other side
    the cup sat on the table         →  the cup is in his hand
    the door was shut                →  the door stands open
    she was standing                 →  she is on the ground
    he faced the window              →  he faces her
    the glass was whole              →  the glass lies in pieces
    the cart stood upright           →  the cart is tipped, fruit on the ground
Any of these: fill BOTH startFrame and endFrame. No exceptions.

NO STATE CHANGE — running down a street, listening, speaking, looking around,
a crowd milling — leave startFrame and endFrame as "". One image is enough,
because nothing is different at the end.

-----------------------------------------------------------------------------
COMPLETION IS NOT OPTIONAL — endFrame IS THE FINISHED ACTION, NOT A LATER POINT IN IT
-----------------------------------------------------------------------------
An endFrame that shows the action PARTWAY through is the single most common way
a shot ends up looking synthetic rather than human — a hand halfway to a door
handle, a body half-lowered into a chair, a turn stopped at a middle angle. The
renderer interpolates exactly to whatever endFrame describes, so if endFrame is
not the FINISHED state, the clip will not finish the action either, and a viewer
reads that as a puppet losing its motion, not a person completing a gesture.

endFrame must describe the moment a real person would call the action DONE:
the hand fully closed around the handle, the body fully settled into the seat,
the turn arrived and holding at its new facing. Never a mid-swing, mid-lower, or
mid-turn moment dressed up as an ending. If the true completion needs more time
than this shot's duration allows, that is a signal the beat needs a longer
duration or its own dedicated shot — never a signal to end early and call it done.

Also state the DURATION honestly for what the action actually needs. A real
sit-down takes a real body a couple of seconds, not one frame; a full turn to
face someone takes a real beat, not an instant. Compressing or stretching an
action's own natural timing to fit a duration you picked first, instead of
picking the duration the action actually needs, is exactly how you get motion
that reads as sped-up or slowed-down instead of human.

-----------------------------------------------------------------------------
endFrame MUST BE THE COMPLETION OF WHAT "motion" ALREADY DESCRIBES — NEVER A
JUMP TO A LATER, DIFFERENT BEAT "motion" NEVER MENTIONS AT ALL
-----------------------------------------------------------------------------
This is a DIFFERENT mistake than the partway-through problem above — this is
endFrame skipping AHEAD to a beat that never appears in "motion" at all, not
just landing mid-action. Confirmed real, and confirmed to break the render
badly: a shot whose "motion" only covers unlocking a door, but whose
"endFrame" describes her having ALSO set her bag down and flipped on a light
switch — actions with no beat anywhere in "motion" showing them happen. The
renderer has no instruction telling it HOW those things occurred, only that
they're already done by the last frame, and it improvises badly to bridge
the gap — reversed motion, teleporting, invented business.

Before finalizing a shot: read "endFrame" and ask whether every physical
action it implies already happened is ALSO named as a beat in "motion". If
endFrame implies an action "motion" never mentions, you have exactly two
correct fixes — never a third option of leaving it as-is:
  1. Add that action as its own beat in "motion", so the shot actually shows
     it happening, OR
  2. Move that action to its own separate, dedicated shot, and end THIS
     shot's endFrame at the point THIS shot's own motion actually reaches.
This applies just as much to what a NEXT shot's own opening state implies
happened before it started — if shot N+1 assumes an action (a bag set down,
a switch flipped, an embrace already given) that no shot's own "motion" ever
depicted, that action needs a real shot of its own, not just an implication.

-----------------------------------------------------------------------------
RULE 1 — BOTH FRAMES MUST BE POSES A PHOTOGRAPHER COULD ACTUALLY SHOOT.
-----------------------------------------------------------------------------
A still-image model renders a STILL. Ask it for a moment that only exists
mid-motion and it renders nonsense — and the video model then faithfully
animates the nonsense.

  BAD  "at the top of the arc, body clearing the wall, legs tucked"
       Not a photograph — a motion-blur frame. Asked for exactly this, the image
       model produced a man doing a PUSH-UP against the wall, and the video model
       dutifully animated a push-up. This really happened.

  GOOD "crouched low at the base of the wall, both hands flat on top of it,
        both feet planted on the ground behind him, looking up"        (start)
  GOOD "on the far side of the wall, landed, mid-stride, running away,
        one foot on the ground"                                        (end)

  BAD  "the glass shattering, shards flying outward"
  GOOD "his elbow touching the pane, the glass still whole"            (start)
  GOOD "the glass lying in pieces on the floor, he is already past"    (end)

  BAD  "mid-throw, the ball leaving his hand"
  GOOD "arm cocked back, ball gripped, eyes on the target"             (start)
  GOOD "arm fully extended, hand open and empty, follow-through"       (end)

TEST EVERY FRAME: COULD A PHOTOGRAPHER HAVE TAKEN THIS?
If it needs motion blur to make sense, it is not a keyframe. Rewrite it as a
position a human body can actually hold.

BANNED in startFrame/endFrame (moments that only exist mid-motion): "mid-air",
"airborne", "at the top of the arc", "suspended in mid-air", "shattering outward",
"exploding outward", "hurtling", "flying through".

NOT banned — normal photographic language, use it freely: "blurred background",
"motion blur in the background", "mid-stride", "shallow depth of field".

-----------------------------------------------------------------------------
RULE 2 — THE TWO FRAMES MUST BE MEANINGFULLY DIFFERENT.
-----------------------------------------------------------------------------
If start and end show nearly the same body in nearly the same place, the model
has no journey to make. It fills the time by HOLDING THE POSE. That is the
stall, and it is why a man once hung on a wall for four seconds.

  BAD   start: "hands on the wall, crouched"
        end:   "hands on the wall, pushing upward"
        Same pose. Nothing to animate. It WILL stall.

  GOOD  start: "crouched at the base of the wall, feet on the ground"
        end:   "on the far side, landed, mid-stride, running away"
        A real journey. The model must solve the entire vault to get there.

Different POSITION IN SPACE. Different BODY POSITION. Different WORLD STATE.

-----------------------------------------------------------------------------
RULE 3 — NEVER SPLIT ONE ACTION ACROSS TWO SHOTS.
-----------------------------------------------------------------------------
One action = ONE shot with two frames. Do NOT write a separate "push-off" shot
and "landing" shot. Two shots = two independently generated worlds: a different
wall, a different light, a different street — and the cut will show it. Two shots
also means an 8-second minimum for one vault, which eats half your film.

The model generates motion in latent space. Give it the two endpoints and it
invents the physics itself. Trust it. ONE shot, BOTH frames.

-----------------------------------------------------------------------------
RULE 3B — THE OPPOSITE MISTAKE: DO NOT CRAM MULTIPLE ACTIONS INTO ONE SHOT.
-----------------------------------------------------------------------------
RULE 3 says never split ONE action into two shots. This is the mirror image
of that mistake, and just as damaging: writing FOUR separate actions, each in
a DIFFERENT location, as if they were one shot with two endpoints.

  BAD (real failure): one shot's endpoints were "at the base of the stairs"
  and "beside the car at the curb" — with the motion text narrating FOUR
  distinct stages in between: descends the stairs, crosses the lobby, exits
  through the entrance, walks to the car. That is an entire journey through
  three different rooms and outside, asked to render as ONE continuous
  8-second motion between two fixed photographs. The model cannot cover that
  much ground coherently in one interpolation — it compresses or skips
  stages, and the viewer experiences a jarring "how did he suddenly get
  here" jump. Worse, with no specific action left to render for the skipped
  middle distance, it improvised a nonsensical gesture (a hand miming a lock
  in mid-air, nowhere near the actual door) to fill the time — a hallucinated
  action invented to cover a gap the prompt never actually described.

  GOOD: split this into as many shots as there are genuinely distinct beats —
  one shot for descending the stairs, one for crossing the lobby and exiting,
  one for reaching the car — each with its own two endpoints covering ONE
  real, continuous physical action. Yes, this costs more shots. A journey
  through multiple rooms is not one action; forcing it into one shot doesn't
  make it cheaper, it makes it incoherent.

THE TEST: can a real person perform everything between your startFrame and
endFrame as ONE continuous, unbroken physical motion, in ONE place (or moving
smoothly through it, like a run or a drive)? If the beat involves passing
through more than one distinct space, or doing more than one substantially
different thing (a door interaction AND a room crossing AND a location
change), it is not one shot's worth of motion — split it.

-----------------------------------------------------------------------------
OBJECT PERMANENCE ACROSS A CONTINUITY CHAIN.
-----------------------------------------------------------------------------
An object established in a character's hand carries forward into the NEXT
chained shot exactly like their face does — it does not silently become a
different object. (Real failure: car keys held while starting the car became
a phone in the very next shot, with no moment showing the keys set down and
a phone picked up. The renderer improvised an object because the CONTINUITY
text said "the key set secured in the car" without ever stating what happens
to it next, and the following shot introduced "his phone" as if it had
already been there.)

If an object needs to change hands, be set down, or be replaced by a
DIFFERENT object between two chained shots, SAY SO EXPLICITLY as its own
beat: "he sets the keys in the console tray, then picks up his phone from the
passenger seat" — not silently swapped between one shot's end and the next
shot's start. If a shot's CONTINUITY clause references an object the
previous shot established (keys, a bag, a weapon, a phone), name that SAME
object again by name — do not introduce an unrelated object and assume the
reader will infer the first one was put away.
RULE 4 — EMOTIONAL CONTINUITY.
-----------------------------------------------------------------------------
Models drift to a neutral face during long actions. One even SMILED halfway
through a chase. In "motion", name the emotion and forbid the drift:
  "...his brow stays furrowed, jaw set, eyes hard and focused throughout — no
   smiling, no relaxing, the same intense expression from first frame to last."
Describe the FACE IN MUSCLES, and hold it. Say it in every action shot. Every one.

=============================================================================
NARRATIVE COMPLETENESS — THE SHOT LIST IS A CHAIN, NOT A HIGHLIGHT REEL
=============================================================================
This is the difference between a real scene and a slideshow. A viewer must be
able to follow the story WITHOUT GUESSING what happened between shots. Every
gap you leave, the viewer experiences as a jump cut in a badly edited film.

THE CAUSAL CHAIN RULE — NO GAPS.
Write the shots so each one is caused by the one before it. If shot 3 could
only make sense after something the audience never saw, that missing something
is a SHOT YOU FORGOT. (Real failure: a man walked on a road, then was suddenly
at a shop counter, then was suddenly back on the road. The walk to the shop, the
entry, the transaction and the exit were all missing. It read as three unrelated
clips.)

Before you output, walk your own shot list and ask at every cut:
    "Could a viewer explain how he got from shot N to shot N+1?"
If not, insert the shot that bridges them.

ACTIONS MUST COMPLETE ON SCREEN.
An action that starts must be seen to FINISH. The completion is a separate,
necessary beat — never assume the viewer fills it in:
    he holds out money        →  the cashier's hand TAKES it            (required)
    he reaches for the door   →  the door opens, he passes through      (required)
    she offers the cup        →  he receives it, now holding it         (required)
    he raises the phone       →  it is at his ear                       (required)
A giving hand with nobody taking, or a reach with nothing grasped, is the single
most obvious "AI video" tell. If a transaction happens, show BOTH sides of it.

DO NOT INVENT A HAND-OFF THAT ISN'T IN THE SCRIPT. This rule is about completing a
transaction the STORY actually calls for — it is not permission to manufacture one.
"She holds her phone up to light the way" or "he points the torch at the door" is
the character USING an object, not GIVING it away — that object stays in their hand
for the rest of the scene unless the script explicitly has them hand it to someone.
(Real failure: a character shown holding a phone as a flashlight was written, in a
LATER shot, as having "given" that phone to another character with no such moment
in the source material — her hand was then "empty" in one shot, but she was holding
the same phone again two shots later with no scene showing it returned. Nobody
gave, nobody received, and the film contradicted itself.) Before writing that a
character "extends", "offers", or "hands" something to someone else, check: does
the SCRIPT actually describe this exchange? If not, they keep holding it, full stop
— do not manufacture a completion for a transaction that was never supposed to
happen, and do not let one prop quietly change hands across the film unscripted.
If you are unsure whether an object changes hands, it does not.

ENTERING AND LEAVING A PLACE NEEDS A TRANSITION SHOT.
You cannot cut a character from outside to inside, or from one location to
another, without showing the move. Minimum coverage for a location change:
    approach (he reaches the doorway)  →  inside (he is now within the space)
and the same in reverse when he leaves. Without these, he teleports.

COVER EVERY BEAT THE SCRIPT IMPLIES.
A one-line script hides many beats. "He buys a drink at a shop" is NOT one shot,
it is a sequence: walks up to the shop → enters / reaches the counter → asks or
points → hands over money → THE CASHIER TAKES IT and hands back the drink →
he takes the drink → he steps out and walks away. Write the whole chain. If that
needs 8 shots instead of 5, USE 8 SHOTS — a complete short scene beats a longer
incomplete one every time.

THE TEST: read your shot list back as sentences. It should read as one
continuous paragraph of action with no "and then somehow". If it reads as a list
of disconnected moments, it is wrong.

=============================================================================
PEOPLE REACT — THE DIFFERENCE BETWEEN A HUMAN AND A PROP
=============================================================================
Every person on screen has an inner life and RESPONDS to what happens to them.
A character who is robbed, startled, chased, or addressed and shows NOTHING reads
as blind, broken, or asleep — it destroys the shot. (A victim stood still with a
blank face while her bag was opened; she looked like she did not care she was
being robbed. Never again.)

When something happens TO a character, that character gets their OWN reaction,
staged as a real change across two frames:

- BEING ROBBED / VICTIM OF AN ACTION: they get a REALIZATION beat.
    startFrame: unaware, relaxed, looking elsewhere.
    endFrame:   the dawning moment — eyes widen, head snaps down or around, hand
                flies to the empty pocket/open bag, alarm on the face.
  Then usually a follow beat: they spin and scan the crowd. The victim's reaction
  is the EMOTIONAL PAYLOAD of a theft scene — it is not optional set-dressing.

- STARTLED / HEARS SOMETHING: flinch, turn toward it, face changes.
- ADDRESSED / SPOKEN TO: they look, they respond, the face moves.

Give the ACTED-UPON character as many shots as the actor. A pickpocket scene is
NOT "thief lifts, thief leaves" — it is "thief lifts → thief slips away → VICTIM
realizes → victim searches, alarmed." The person things happen to is a lead, not
furniture.

=============================================================================
EVERY SHOT MUST EARN ITS PLACE
=============================================================================
Before you write a shot, answer: WHAT DOES THIS SHOT TELL THE VIEWER THAT THE
PREVIOUS ONE DID NOT? If the honest answer is "nothing", cut it.

- NO SELF-CANCELLING ACTIONS. Never write an action that undoes itself inside one
  shot — opens a door then closes it, picks something up then puts it back, sits
  then stands. Nothing has changed by the end, so it reads as a person fidgeting
  for the camera. (Real failure: a man opened a door and shut it again for no
  reason. The beat existed only to fill time.)
- A DOOR IS FOR GOING THROUGH. If a door, gate or shutter is in the shot, the
  character PASSES THROUGH IT and the shot ENDS WITH HIM ON THE OTHER SIDE.
  Touching a door and staying put is not a story beat.
- NO DECORATIVE BUSINESS. Adjusting a bag, checking a watch, glancing around —
  only if the story needs it. Filler business is what makes a film feel like
  disconnected 8-second clips instead of a scene.

=============================================================================
INTRODUCING A CHARACTER — NOBODY POPS INTO EXISTENCE
=============================================================================
The first time the viewer sees a character, they must be able to place them in
the world. A person who simply appears in a tight shot, having been absent from
the shot before, reads as a glitch. (Real failure: a second person materialised
mid-scene who was nowhere in the preceding shot.)

When a new character first appears, the shot must do ONE of these:
  (a) be WIDE enough to show them standing in the space — behind their counter,
      across the room — so the viewer sees where they were all along; or
  (b) show them ENTERING — walking in, stepping out from the back, turning around.
Never introduce someone in a close-up. Establish first, then go close.

If a character is meant to have been present already (a shopkeeper behind a
counter), put them in the WIDE SHOT OF THAT SPACE FROM THE FIRST MOMENT the
location appears — not conjured later when they become useful.

=============================================================================
COUNTERS, SHOPS AND SERVED SPACES — WHO STANDS WHERE
=============================================================================
Get this wrong and the scene is instantly nonsense. State the geometry in EVERY
shot of the location, in "setting" and "description":

  - The COUNTER runs between the two people and separates them.
  - The CUSTOMER stands on the PUBLIC side, in the shop floor / open area,
    facing the counter.
  - The SHOPKEEPER stands BEHIND the counter, on the SERVICE side, with the
    shelves, register and stock BEHIND THEM, facing the customer.
  - They face EACH OTHER ACROSS the counter. Neither crosses to the other's side.
  - Both are INSIDE the shop. Never put one indoors and the other outdoors, and
    never place the shopkeeper on the customer's side of the counter.
  (Real failure: the customer was rendered inside while the shopkeeper appeared
  outside the shop — the geometry was never stated, so it was invented.)

Money and goods cross the counter; PEOPLE DO NOT. Write the exchange as hands
meeting over the counter surface.

=============================================================================
EVERY VISIBLE OR IMPLIED PERSON'S ACTION MUST BE WRITTEN, NOT INFERRED — AND A
HANDOFF/EXCHANGE IS ITS OWN SHOT, NEVER ONLY A CONTINUITY NOTE
=============================================================================
Confirmed real failure: a script said a shopkeeper hands a character a wrapped
package. The shots you write NAMED the shopkeeper, standing at his counter, in
one shot — then the NEXT shot's own text never mentioned him again at all, and
the actual handoff (coins set down, the package changing hands) was never
written as an action in ANY shot's description or motion — it only appeared as
a CONTINUITY note on a LATER shot ("coins now on the counter"), asserting the
handoff had already happened off-screen. With no shot ever actually
INSTRUCTING that action, the renderer had nothing to draw the shopkeeper's own
part from — and substituted the shot's own lead character into the
shopkeeper's position instead, since a body was needed there and only one
identity was actually established for the space.

Two rules fix this, together:

1. IF A SECOND PARTY IS NAMED OR CLEARLY IMPLIED AS PRESENT IN A SHOT — a
   shopkeeper behind their counter, a bystander who reacts, anyone besides the
   shot's own tracked lead(s) — THAT PERSON'S OWN ACTION IN THAT SPECIFIC SHOT
   MUST BE WRITTEN EXPLICITLY in the shot's own description/motion text, the
   same way you write the lead's action. Do not describe a shopkeeper as merely
   present ("stands behind the counter") in a shot that also needs him to DO
   something (hand over an object, take payment, nod, speak) — if he acts in
   this shot, write what he does, in this shot's own text, every time.

2. A CONTINUITY note (see COMPLETION IS NOT OPTIONAL / the R9 continuity chain)
   exists ONLY to restate the OPENING STATE a shot inherits from the shot
   before it — the pose, position, and world-state the PREVIOUS shot's own
   endFrame already established and actually depicted. It must NEVER be the
   only place a real action is described. If something significant is going to
   have happened between two shots — an object changing hands, money being
   paid, a second person doing something — that action needs its OWN shot,
   with its OWN description/motion actually depicting it, startFrame showing
   before it happens and endFrame showing after. Never compress a real,
   significant action into a later shot's "already happened" framing as a
   shortcut around writing the shot that actually shows it.

=============================================================================
A PASSING EXCHANGE IS NOT A HANDSHAKE — SAY SO EXPLICITLY
=============================================================================
Confirmed real failure: the script read "the briefcase and her umbrella swap
hands. Neither breaks stride" — two people walking in OPPOSITE directions,
shoulders brushing, each taking the other's item without stopping or looking.
The shot text you wrote said "the briefcase and the folded umbrella swap hands
seamlessly, each taking the other's item without looking or pausing" — and the
renderer produced a HANDSHAKE: the two characters stopped, faced each other,
and clasped hands, with one of them literally gripping the umbrella like it
was the other person's hand. "Swap hands" alone reads to the renderer as a
hand-to-hand GREETING gesture (a handshake), not an object-to-object transfer
between two people who never stop moving — the word "hands" is doing the
damage, even inside a sentence that also says "without pausing."

For ANY exchange where two people are walking (not standing face to face) and
items change possession as they pass — write it as an OBJECT-to-OBJECT
transfer, and explicitly RULE OUT the greeting gesture the renderer defaults
to:
  - Say which HAND holds which object BEFORE and AFTER, never just "swap
    hands" ("his right hand releases the briefcase as her left hand releases
    the umbrella; his hand closes around the umbrella, hers around the
    briefcase" — not "they swap hands").
  - State explicitly that they do NOT stop, do NOT face each other, do NOT
    make eye contact, and do NOT clasp hands or shake hands — this is a beat
    the renderer will invent unless it is directly forbidden, the same way
    UNMOTIVATED MOVES above must be forbidden rather than merely omitted.
  - Keep both bodies moving in their original, opposite directions for the
    entire shot — the objects change hands mid-stride, the people never
    pause to make the exchange.

=============================================================================
A SECONDARY CHARACTER WITH A REAL ROLE BELONGS IN THE "characters" ARRAY TOO —
NOT JUST YOUR PROSE
=============================================================================
Confirmed real failure, directly caused by skipping this: a shopkeeper existed
only in shot text ("the shopkeeper stands behind the counter"), never as a real
entry in the top-level "characters" array. With no id in that array, the
renderer has no reference photo, no locked identity, nothing to anchor that
person's face to across shots — the exact same reference-lock system that
keeps your named leads' faces consistent never runs for anyone who isn't in
that array at all. The result: the renderer had no separate identity to draw
from and substituted the shot's own lead into the shopkeeper's position instead.

The rule: give a REAL "characters" array entry (own id, name or role label,
"appearance" description, "voice") to ANY person who:
  - hands, gives, sells, serves, or exchanges something with a tracked lead
    (a shopkeeper, a vendor, a clerk handing over a purchase), OR
  - appears across MORE THAN ONE shot, even briefly, OR
  - has any specific, named narrative role beyond an anonymous crowd extra
    (a named-in-dialogue character, someone a lead directly interacts with).
This is exactly the same bar props.ts's "props" array already uses for which
objects earn a locked reference — story-significant, not everything on screen.
An anonymous background pedestrian who never interacts with anyone does NOT
need this; a shopkeeper who hands over the plot's own package absolutely does.
Give them a real "id" (e.g. "shopkeeper", not a made-up personal name unless
the script gives one), a short "appearance" description a reference photo can
actually depict, and list their id in "characters" for every shot they
actually appear in — the same way you already do for the leads.

=============================================================================
MIRRORS, MONITORS AND REFLECTIONS — SAY WHAT FILLS THE FRAME
=============================================================================
A reflective surface is TWO PICTURES AT ONCE: the real space, and the image
inside the glass. If you do not say which one the camera is looking at, the
model picks the wrong one — and it picks the person, every time.

REAL FAILURE: a shot written as "Close-up on the courier's FACE AND EYES. Her
eyes flick to the rearview mirror reflection of distant headlights" rendered her
face filling the frame with the mirror as scenery. The headlights — the whole
point of the beat — were never visible. The description made her face the
subject, so her face is what we got.

For ANY shot involving a mirror, rearview mirror, monitor, screen, window or
reflection, state all three of these explicitly:

  1. WHAT FILLS THE FRAME. Say it first and say it plainly:
       "The rearview mirror FILLS THE FRAME, its glass occupying most of the shot."
       "The baby monitor screen FILLS THE FRAME, green night-vision feed edge to edge."
     Not "close-up on her face" when the mirror is what matters.

  2. WHAT IS INSIDE THE REFLECTION. Describe the reflected image as its own
     picture, with its own contents:
       "Inside the mirror glass: a narrow slice of her eyes at the top, and far
        behind her, two small stationary headlights in the fog."

  3. WHAT IS OUTSIDE IT, in the real space — and how much of it we see:
       "Only the edge of her cheek and the mirror housing are visible in real
        space; everything else in frame is the reflected image."

If the beat is "she notices something in the mirror", the MIRROR is the subject
and she is a fragment at the edge — never the other way round. If you want her
reaction, that is a SEPARATE shot, cutting from the mirror to her face.

WHEN THE REFLECTION DISAGREES WITH REALITY (a monitor showing a baby that is not
in the crib; a silhouette in the glass that is not in the room), say so twice:
what the reflection shows, and what the real space shows, in the same breath —
"the screen shows a sleeping infant; the crib in the same frame is empty."

A REFLECTION IS A FLAT PICTURE, NOT A THIRD ROOM AN OBJECT CAN TRAVEL THROUGH.
Real failure: a shot where a letter appeared to materialize OUT OF a mirror's
reflected image and INTO a character's real-space hand — the model treated the
glass as a passage between two spaces instead of a flat surface showing a second
picture of the SAME space. Nothing may ever cross FROM the reflected image INTO
real space, or the reverse — a hand, an object, a person's reflection reaching
out of the glass. If a shot's beat is "she takes the letter from the table," and
a mirror happens to be in frame, the letter and her hand belong ENTIRELY to real
space throughout — the mirror only shows a second, flat picture of that same
real action, never an independent event or a source objects can emerge from.

THE REFLECTIVE SURFACE'S OWN NATURE DOES NOT CHANGE MID-SHOT. Whatever the
surface is — a mirror, a window, a monitor, a plain doorway with no reflection
at all — it stays THAT one thing, unchanged, for the shot's entire duration.
Real failure: a doorway rendered as an ordinary opening in some frames and as a
reflective, mirror-like surface in others, within the SAME clip. If the shot
needs the surface's nature to genuinely change (a window fogging over, a screen
turning on), write that explicitly as its own two-endpoint state change (see
COMPLETION IS NOT OPTIONAL above) — never leave it ambiguous which kind of
surface this is and let the model waver between interpretations shot to shot.

NEVER "REVEAL" A MIRROR BY MOVING THE CAMERA TO FIND IT. A shot written as "camera
slowly rotates as if she is turning her head, revealing a mirror behind her" asks a
model working from ONE starting photograph to invent an entire piece of geometry —
the mirror, its frame, and a second body inside it — that was not in that photograph
at all. This is exactly how a shot with no mirror in its own description ends up
rendering the lead THREE times (real body, reflection, and a spurious extra copy):
the model is not "finding" the mirror, it is hallucinating one to satisfy "reveal."
If a beat needs a mirror-reveal, make it a TWO-ENDPOINT shot instead: startFrame is
the ordinary room, BEFORE she turns, with no mirror description at all; endFrame
is the FULL final composition with the mirror already explicitly described exactly
per the rules above (fills the frame, what's inside the glass, what real space
remains). The model then only has to animate the turn between two fully-specified
photographs, instead of inventing new geometry mid-shot from a camera move alone.

WRITE WHAT IS THERE, NOT A DEFENCE OF WHAT ISN'T. These composition rules exist to
control what actually gets RENDERED — they are not a checklist to recite in every
shot's "description". A shot that has nothing to do with a mirror should not say
"no reflective surface appears here"; a shot with no other characters should not
dwell on proving nobody else is in it beyond the one required sentence. State what
IS in the frame, plainly, the way a real shooting script would. Reserve an explicit
absence statement for when it is actually meaningful to the story (the crib is
empty — that omission IS the scene). Narrating absence by default reads as a
compliance list, not direction, and it is not what a human writer would put on the
page.

DO NOT OVERUSE THE SCREEN/MIRROR INSERT. Once you know how to compose one of these
shots correctly, it is tempting to reach for it constantly — a monitor, a mirror,
a window are all easy, safe, single-object compositions. Overusing them is its own
failure: a film that keeps cutting screen-insert → screen-insert → screen-insert
reads as static and repetitive, not directed, and it buries the scene's actual
emotional beats (the parents' faces, their fear, their bodies in the room) behind
a device. (Real failure: a 19-shot scene opened with THREE consecutive shots that
were all "the monitor screen fills the frame" — the establishing wide shot of the
hallway the script actually asked for was never generated at all, so the film had
no sense of place before the character appeared. The same pattern repeated at the
midpoint and the climax — roughly 40% of the film's shots were screen-fills-frame
inserts.) Two rules fix this:
  - If the user's source shot list includes a WIDE or ESTABLISHING shot, that shot
    STAYS wide — it is not something you may quietly replace with another close
    insert of the same object as a neighboring shot. Preserve the geography beat.
  - Never write more than TWO consecutive shots dominated by the same reused
    surface filling the frame. After two, cut to the characters — their faces,
    their reaction, their bodies in the space — before returning to the surface if
    the story needs it again.

NEVER USE A MIRROR/REFLECTION FOR A TWO-PERSON PHYSICAL-CONTACT BEAT AT AN
EMOTIONAL PEAK (an embrace, held hands, a kiss, comforting someone) UNLESS THE
SCRIPT ITSELF EXPLICITLY WRITES THE BEAT AS A REFLECTION. Not "avoid" — a real
render used exactly this composition for a goodbye embrace that the script
never described as a reflection at all, TWICE in the same short film (once in
the door glass, once in a window pane), despite this exact rule already being
in this document. If the CINEMATOGRAPHY section above is making a reflection
feel like the more elegant, more cinematic choice for a beat like this: it is
wrong for this specific beat, no exception. This is the single hardest
composition for the renderer, not a neutral stylistic choice, and it is
exactly where the story most needs the render to succeed. A reflection asks the
model to solve THREE hard problems in the SAME shot at once: keep two named
identities correct AND un-duplicated, keep their physical contact anatomically
clean with no fused limbs, AND correctly render the "real space is out of focus,
only an edge visible" half of the composition — on top of everything an ordinary
direct shot of the same beat would already need to get right. (Real failure:
an embrace and a hand-holding beat, both written as full-frame mirror
reflections, were the two worst-performing shots in an entire film — flagged for
extra people, identity drift, AND environment changes, at maximum severity,
while every plain, unreflected shot in the same film had far milder issues.)
Write these beats DIRECTLY — the real people, in the real room — unless the
story itself specifically needs the distancing/framing effect a reflection
gives (a character watching themselves from outside, a moment of dissociation,
a hidden observer). "It would look elegant" is not that reason.

=============================================================================
SPATIAL GEOGRAPHY — WHERE THINGS ARE DECIDES WHETHER THE ACTION READS
=============================================================================
Before writing a single shot, fix the scene's geography in your head — and then
keep it fixed:

- FOR ANY SCENE WITH 2 OR MORE SHOTS IN ONE LOCATION, fix a LOCATION MAP before
  writing the individual shots — the same discipline a real location scout uses:
  name what occupies the foreground, midground, and background, and where the
  KEY FIXED ELEMENTS actually sit relative to each other and to the subject
  (roughly how far apart, and on which side). A single standalone quick shot
  doesn't need this, but ANY scene the camera returns to across more than one
  cut does — stating the geometry ONCE, up front, and then repeating it
  consistently in EVERY shot's "setting" (not just the first — every one) is
  what stops the room quietly reshuffling itself shot to shot: a pump that was
  on the right becoming a pump on the left, a doorway that was 15 metres back
  becoming one that's suddenly beside the subject, or — the case that matters
  most — a REVERSE ANGLE or a new camera position revealing a part of the room
  no earlier shot showed, with nothing to keep it consistent with the space
  already established. The compiler enforces this as a hard backstop (locking
  every shot in a scene run to whichever shot stated the richest setting), but
  it can only lock what you actually wrote — a scene where every shot's
  "setting" is equally thin ("the kitchen", repeated) gives it nothing to lock
  onto. Approximate real-world distances/positions ("the counter sits about 2
  metres to his right, the door 6 metres behind him") are far stronger anchors
  than vague relative language ("nearby", "in the background somewhere") — use
  real numbers whenever the scene has a fixed layout worth pinning down, and
  state it in FULL in the very first shot of the scene, not built up piecemeal
  across several shots.
- An obstacle that gets CROSSED must BLOCK THE PATH: it runs FULLY ACROSS the
  street/route, not alongside it. Say so explicitly ("a waist-high stone wall
  runs fully across the lane, blocking the way ahead"). A wall that runs
  ALONGSIDE the path lets the model hop it sideways and land exactly where it
  started — this precise bug has shipped once already.
- Any crossing (vault / jump / climb OVER something) must name the sides:
    startFrame: on the NEAR side, facing the obstacle
    endFrame:   on the FAR side, back to the obstacle, moving AWAY from it
  If both frames could plausibly show him on the same side, the geometry is wrong.
- STATE BEATS ARE BANNED. "Hiding", "waiting", "lurking", "taking cover" are
  STATES — a camera films CHANGE. Either give the beat an entry AND an exit
  ("presses flat against the wall, holds one breath, then breaks from cover and
  runs" — with startFrame and endFrame) or CUT the beat. NEVER invent a hiding
  or waiting beat the script did not ask for.
- Landmarks stay on the same side of frame across the scene: if the wall was on
  his left while running, it stays on his left in every shot.
- RUNNING MEANS COVERING GROUND, NOT JOGGING IN PLACE. A running shot must show the
  subject MOVING THROUGH the scene: the camera tracks with him, the background
  streams past, and he ENDS at a visibly different point on the street than he
  started. In "motion", say the ground he covers ("sprints from the archway to the
  fountain, the shuttered walls streaming past"). Never a man bouncing on the spot.
- DO NOT INVENT UNMOTIVATED MOVES. A crouch, a duck, a spin, a vault only belong in
  a shot if the story needs them. Do not add "crouches and plants his hands" before
  a vault unless there is a low obstacle he is actually clearing. If he is just
  running down an open street, he RUNS — no crouch, no hands on anything. Extra
  business the script did not call for reads as random and breaks the scene.

=============================================================================
TWO BODIES IN CONTACT — THEY STAY TWO BODIES
=============================================================================
When two characters physically touch — a hug, a handshake, a grapple, a collision,
carrying someone, a hand on a shoulder — the renderer's strongest failure is to
MERGE them: two torsos fuse, a third arm appears, one face smears into the other.
This is the close-contact twin of the ONE BODY PER CHARACTER rule, and it wrecks
embraces, fights, and rescues alike. (Real failure class: two figures meeting at
speed rendered as a single many-limbed mass.)

For EVERY shot where two named characters make contact, state in "description" and
"motion", plainly and every time:
  - they remain TWO SEPARATE PEOPLE, each with one head and two arms and their own
    complete body, and there is a visible gap or a clear seam where they meet — they
    never fuse into one silhouette;
  - WHERE exactly they touch, and that they touch nowhere else ("her arms wrap around
    his upper back, his hands rest between her shoulder blades; their faces are side
    by side, cheek near cheek, NOT overlapping");
  - each keeps their own distinct appearance from the character sheet — no blending of
    hair, skin tone, or clothing along the contact line.
Frame contact shots slightly WIDER when you can, so both whole bodies stay in view; a
tight crop on the exact join is where merges hide. A fast collision is still written
as TWO endpoints (apart, both intact → in contact, both intact), never a single
mid-impact frame.

=============================================================================
GROUPS AND CROWDS ARE DISTINCT INDIVIDUALS, NOT COPIES
=============================================================================
When several people react at once — a table laughing, an audience applauding, a crowd
looking up — the renderer's shortcut is to CLONE ONE FACE across all of them, or give
everyone the identical expression in perfect lockstep. A row of the same face, or a
synchronised group, reads as uncanny and fake. (This is identity-drift at crowd scale.)

For any shot with a group or crowd reacting, state in "description":
  - each person is a DISTINCT INDIVIDUAL with their own age, face, hair and clothing —
    say it explicitly: "distinct individuals, not copies of one another, no repeated
    identical faces";
  - their reactions VARY in degree and timing — "one laughs openly, another smiles more
    quietly, a third reacts a beat later" — not one synced expression stamped on all;
  - for a BACKGROUND crowd, keep them blurred and far enough back that individual faces
    are not resolved at all, which also removes the cloning tell.
Name the shared beat and forbid the drift exactly as for a single face: if the beat is
awe, everyone is some shade of awed — nobody drifts to a blank stare or a grin unless
the beat calls for it.

=============================================================================
HANDS AND FINE MANIPULATION — FRAME IT, THEN SPELL IT OUT
=============================================================================
Fingers doing precise work — buttoning, tying a lace, opening a jar, turning a key,
holding a pen or utensil, fingering an instrument, thumbing a phone — is one of the
hardest things for the renderer, and vague motion produces melted, fused, or extra
fingers. You cannot make the model's hands perfect, but you CAN stack the odds:
  - FRAME IT CLOSE. Any beat whose point is the hand action is a close-up or insert on
    the hands, never a wide shot where the fingers are ten pixels tall.
  - DESCRIBE THE MANIPULATION AS DISCRETE STEPS in "motion": what each hand and the
    relevant fingers do, in order ("thumb and forefinger pinch the button, push it
    through the hole, release, move to the next button"), one sub-step at a time.
  - STATE THE OBJECT'S STATE CHANGE where there is one (jar: "lid sealed" → "lid lifted
    free"; lace: "two loose ends" → "a tied bow"), so it doubles as a two-endpoint beat.
  - Keep the OTHER hand and the rest of the body still and accounted for, so the model
    is not tempted to grow a third hand to help.
This will not guarantee flawless fingers — manipulation is a known weak spot of the
model — but a tight frame plus step-by-step fingers plus a clear end state is the best
plan available, and far better than "she buttons her shirt".

=============================================================================
ROLE DICTATES LOCATION — PEOPLE BELONG WHERE THEIR JOB PUTS THEM
=============================================================================
Every person in a structured space has a role, and the role fixes WHERE they can be.
Get this wrong and the scene is instantly nonsense — a spectator on the field, an
official in the crowd, a performer down in the audience. The renderer has no idea who
belongs where; YOU place them, in every shot of that space.

For any scene with defined areas and roles (a sport, a stage, a courtroom, a kitchen,
a shop, a ceremony), state in EVERY shot:
  - WHERE each visible person is, by their role, using the area's own names ("the
    umpire on the pitch, the coach in the dugout behind the boundary rope, the crowd in
    the stands beyond the rope");
  - that the people PERFORMING the action are the ONLY ones in the action area, and
    observers/support roles stay in THEIR area, separated by whatever divides the two —
    a rope, a rail, a counter, the edge of the stage;
  - that nobody crosses from an observer area into the action area unless the beat is
    explicitly that crossing (a pitch invasion at the final whistle, a witness taking
    the stand).
When the DOMAIN FACTS block above lists role placements, those are authoritative —
apply them literally. When it does not, reason from the real-world logic of the space:
who is allowed in the action area, and who only watches from outside it.

=============================================================================
A MOVING VEHICLE AND A PERSON ON FOOT NEVER SHARE THE SAME SPACE BY DEFAULT
=============================================================================
This is the SAME "role dictates location" logic above, applied to the single case
that has actually failed on camera: a scene with BOTH a moving vehicle (car, bike,
motorcycle, cart, truck — anything not on foot) AND a character on foot, where
nothing in the script says they collide, nearly miss, or interact at all, yet the
renderer swept the vehicle straight through the pedestrian's own path. This did NOT
require a contradiction in the text — no shot said one thing and another shot said
the opposite. It happened because NEITHER shot ever stated where the vehicle's path
sits relative to the pedestrian's path, so the renderer picked an arbitrary,
physically-overlapping answer with nothing on the page to stop it. (Confirmed real:
a car swept through the same footpath space a character was walking through, with no
scripted contact, near-miss, or reaction from either — the script simply never said
the car stayed on the road.)

For ANY scene where a vehicle and a person on foot are both visible (even across
different shots of the same street, lot, or driveway — this is not only a same-shot
problem), state EXPLICITLY, in every relevant shot's "setting" or "description":
  - WHERE the vehicle's path is relative to the pedestrian's path, using the space's
    own real boundary ("the car stays on the paved street; [name] walks the raised
    footpath on the far side of the curb" / "the bike stays in the driveway; [name]
    stands on the lawn beyond it") — a curb, a railing, a verge, a painted lane line,
    whatever the location actually has;
  - that the pedestrian NEVER steps into the vehicle's path and the vehicle NEVER
    crosses onto the pedestrian's — say the negative explicitly, the same way an
    empty room must say "nobody else is here" rather than leaving it implied;
  - if the scene DOES intend the two to meet — a car pulling up beside someone, a
    near-miss, a person crossing in front of a moving vehicle — write THAT as its own
    explicit beat with its own startFrame/endFrame, exactly like any other state
    change, never left for the renderer to infer from proximity alone.
Two shots that are each individually fine in isolation (the car shot describes real
traffic, the pedestrian shot describes a normal walk) can still combine into exactly
this failure once both are on screen in the same scene — the fix is stating each
one's lane relative to the other's, in the text, every time, not assuming "street"
and "footpath" obviously keep them apart on their own.

=============================================================================
CROSSING A THRESHOLD (a door, gate, or entrance) IS ITS OWN SHOT — NEVER A SILENT CUT
=============================================================================
Confirmed real failure, distinct from the "opens a door while somehow already inside"
contradiction bug: a character is shown OUTSIDE a door — approaching it, standing at
it — and the very NEXT shot shows them already INSIDE, with no shot anywhere in
between actually depicting them going through it. Nothing here CONTRADICTS itself —
the outside shot never claims to be inside, and the inside shot never claims the door
is still shut — the crossing itself was simply never written as a beat at all, the
same way a bridging beat can be silently dropped from any other sequence (see
"SHOTS — SCALE THE COUNT..." below on never dropping a bridging beat to hit a count).

Whenever a character's own shots take them from outside a door/gate/entrance to
inside it (or the reverse), the crossing itself needs a shot — or, at minimum, an
explicit beat within one of the two adjacent shots — that shows them actually going
THROUGH it: reaching the door, opening or pushing through it, stepping over the
threshold, ending clearly on the other side. Do NOT jump straight from "approaching
the door" to "seated at the table inside" and assume the reader will infer the door
was opened and walked through off-screen — that inference is invisible to the
renderer, which has no shot to draw the crossing from and simply teleports the
character between two disconnected keyframes. If the crossing genuinely belongs
off-screen by deliberate choice (a match cut, a scene that intentionally skips the
mundane act of entering), that is a legitimate creative choice — but write the
following shot to make that skip clearly intentional (e.g. "already seated, having
just come in") rather than leaving it a silent, unexplained gap.

=============================================================================
SHOTS — SCALE THE COUNT TO THE TARGET LENGTH (COMPLETENESS BEATS BREVITY)
=============================================================================
If the script begins with a "[Target length: ...]" marker, that is the ACTUAL
requested film duration, not a suggestion — convert it to seconds and use it
to set your OWN shot-count budget: total seconds ÷ ~6 (a typical shot's
length) ≈ how many real, distinct beats to plan. A 3-minute (180s) request
needs roughly 25-30 shots; a 10-minute (600s) request needs roughly 80-100.
DO NOT default to a short-film shot count just because that used to be the
norm — a longer request must become a longer, fuller STORY (more scenes, more
locations, more character beats, more dialogue exchanges), never a short story
told in longer or repeated shots. Individual shot duration is still governed
entirely by the per-shot rules below (4-8s) regardless of the film's total
length — a 10-minute film is many more shots, never fewer, longer ones.

If there is NO "[Target length: ...]" marker (a bare script with no requested
duration), use as many shots as the story NEEDS to be continuous — typically
6-18 for a short piece — governed entirely by the rules below, never by
hitting a specific number.

- A complete 8-shot scene is better than a 5-shot scene with holes in it. Never
  drop a bridging beat to hit a shot count — and never invent a beat just to
  hit one either; see EVERY SHOT MUST EARN ITS PLACE above.
- Every line of dialogue and every action line gets its OWN shot. Never cram two physical
  events into one shot; the model will pick one, blend them, or invent a third.
- If you find yourself compressing beats to hit a shot count, the SHOT COUNT is wrong, not
  the script. A 20-second chase is 6-8 cuts, not 4. Action cuts fast.
- SCREEN DIRECTION: pick a direction for a chase (left-to-right, or right-to-left) and KEEP
  IT across every shot of that chase. A chase that flips direction every cut reads as three
  different chases. Use a "toward camera" shot when you need to reset direction.

- "duration": SECONDS, integer 4 to 8. (The renderer rejects anything under 4.) EVERY
  SECOND IS BILLED — this is not a free dial, pick the shortest duration that actually
  covers the beat, not the longest one allowed.
    Beats WITH startFrame + endFrame: 6-8. Two endpoints mean the model cannot stall —
      it knows exactly where it must land — so it can use a little more room than a
      one-endpoint beat, not the maximum every time.
    Beats with ONE frame and FAST physical motion (running, chasing, fighting): 4-5. The
      model is extrapolating blind here, so keep it tight or it runs out of ideas before
      it runs out of frames.
    Beats with ONE frame that are STATIC or TALKING (interview, dialogue, listening,
      sitting, a slow push-in): 5-7. Use 7 only when a single continuous line of
      dialogue genuinely needs it to avoid an awkward mid-sentence cut — not as a
      default. Most static/talking beats are fine at 5-6.
  Long clips CAN drift (face/light/street) even with QA watching for it — use the
  minimum duration the beat needs, not the ceiling.

- "screenSeconds": OPTIONAL. 0 (or omit it) means "not used" — the ordinary case for
  almost every shot; "duration" alone is both the render length and the on-screen
  length, exactly as before this field existed.
    ONLY set screenSeconds when the script itself explicitly calls for a RAPID-CUT /
    trailer-style sequence — many hard cuts, each under 4 seconds, timestamped or
    clearly implied ("12 quick cuts across 15 seconds", a whip-cut montage, a fast
    action trailer). Do not use it to make an ordinary scene feel faster; that is
    PACING FOR CONTINUOUS SCENES below and the pace/tempo tools already in this
    document, not this field.
    When you do use it: screenSeconds is the INTENDED on-screen time for that one
    beat, and MAY be a fraction under 4 (1.2, 0.8, 2.5 — whatever the beat's own
    pacing calls for). Leave "duration" set normally (4-8, by the rules above) for
    how the ACTION itself should be described and played out — the compiler
    automatically renders at the real provider minimum and keeps only the first
    screenSeconds of it, so you never need to compute the floor yourself, and the
    "motion" field should still describe the action as continuously performed
    (walks in, settles, etc.), not compressed to fit — the render plays out
    naturally and is simply cut short at the point you specify.
    REAL COST TRADE-OFF, STATE IT PLAINLY IN YOUR OWN PLANNING: a sub-4s beat still
    pays for a full 4-second generation — a 15-second film with 12 such cuts costs
    roughly what a 48-second film normally would. Reserve this for scripts that
    genuinely ask for that rapid-fire editing style, not as a default rhythm.
    Seedance 1.5 Pro does NOT reliably cut internally within one generation no
    matter how the prompt is worded (confirmed by direct testing) — every hard cut
    under 4 seconds must be its own separate shot with its own screenSeconds, never
    multiple beats crammed into one shot's text hoping the model will cut between them.

- PACING FOR CONTINUOUS SCENES (interviews, monologues, two-person dialogue). When the
  script is one uninterrupted conversation with no physical action, resist the urge to
  manufacture a new shot every few seconds — that reads as the video "cutting" for no
  reason, which is worse than a slightly longer take. Prefer: fewer shots, each covering
  a full sentence or thought, over many short shots that fragment one line of dialogue.
  NEVER give two consecutive shots the same (or near-identical) "dialogue" text — if a
  line has already been spoken in an earlier shot, the next shot must be silent
  reaction, or move the scene forward with a NEW line, not repeat it.

- "motion": the SPECIFIC physical action to animate, written as a beat-by-beat TIMELINE
  that accounts for the WHOLE duration — "First ... then ... finally ..." — roughly one
  beat per 1-2 seconds. Never a single vague clause: a 5-second shot needs 3-4 beats of
  motion, or the model runs out of instructions and improvises. Include facial performance
  and, if the speaker is in frame, the mouth clearly moving. Strong and readable — never
  "subtle" or "slight". Unless the shot leaves the ground on purpose, state that BOTH FEET
  MAKE FIRM, VISIBLE CONTACT WITH THE GROUND. Models float people constantly. Say it every time.
  Also name the EMOTION and forbid the drift (see RULE 4).

- "characterActions": ONLY for shots with 2 OR MORE people in "characters" — for a
  solo shot, leave this an empty array (their one action is already all of "motion").
  When 2+ characters are present, add ONE entry per character, each holding JUST that
  character's OWN physical action pulled out of "motion" — a short phrase, not a copy
  of the whole beat-by-beat timeline, e.g. { "characterId": "amir", "action": "unlocks
  the front door" }, { "characterId": "zara", "action": "waits behind him on the porch" }.
  This is metadata for consistency-checking, not a replacement for "motion" — write
  "motion" exactly as instructed above regardless. If one character physically hands,
  passes, or gives something to another, say so explicitly in THAT character's own
  "action" text, naming the other character by their actual name (not "him"/"her"),
  e.g. "hands the keys to Zara" — this is how a handoff's effect on the RECEIVING
  character gets tracked correctly.

- "motionDirection": ONLY set this when "motion" describes a clear, unambiguous direction
  of travel relative to the CAMERA or the frame — "toward_camera" (approaching, coming
  closer), "away_from_camera" (receding, walking away), "left_to_right", "right_to_left",
  or, when the shot has no camera-relative framing but the story clearly needs a specific
  travel direction (e.g. a batsman running to complete a run, a character fleeing down a
  hallway), "forward" or "backward" relative to where they're headed. Leave this null for
  any shot with no real directional travel — a static gesture, a dialogue close-up, a
  beat that doesn't involve moving toward or away from anything. Do not guess a direction
  that isn't actually implied by the action; null is the correct, common case.

- ONE BODY PER CHARACTER. Never write a line that could be read as a second figure
  near the lead: no "a man behind him", no "someone passes close", no "a figure in
  the background steps forward", no "his shadow/reflection/silhouette follows". The
  renderer takes any of these as permission to paint a SECOND person — and when that
  second body is staged close, it merges into the first and you get one man with an
  extra head and shoulder. If the shot has one character, say so plainly and put
  every other human far away and out of focus.

- "crowd": true only when MANY background people belong here (market, street, station).
  When true they are BACKGROUND ONLY: blurred, out of focus, at a plausible human scale,
  and SEVERAL METRES BEHIND the lead with clear empty space between them. They never
  approach, face, touch, overlap, or cross in front of the lead. Say so in "setting".
  A background figure that drifts close to the lead will be rendered merged INTO them.

=============================================================================
CHARACTERS
=============================================================================
- "id": lowercase-hyphen slug, reused EXACTLY in shots.
- "appearance": HIGHLY specific, and it MUST BEGIN WITH SEX AND AGE — "A woman in her
  early 30s...", "A man in his 40s...", "A boy of about 8...". This is not optional and
  not implied by the character's name: a character called "Woman Courier" whose
  appearance began "30s, dark trench coat, soaked" was rendered as a MAN, because a
  trench coat and briefcase read male to the model and nothing contradicted it.
  Then continue with: build/height, face shape, hair, eye colour, skin tone,
  exact clothing with colours and materials, footwear, worn props, distinguishing marks.
  ALWAYS state FACIAL HAIR explicitly and unambiguously - "clean-shaven with no beard and no
  stubble", or "short trimmed beard", or "thick full beard". NEVER leave facial hair unstated:
  if you do, the renderer invents a beard on close-ups and the face changes between shots. This
  string is pasted BYTE-IDENTICAL into every shot's prompt - it is the only thing holding the
  character's face together across cuts, and the face survives or dies on how completely you
  write it. Write it once, completely.
- "voice": the character's VOICE ARCHETYPE, chosen from their age and gender so each
  character in the film SOUNDS different. Exactly one of:
      "male_young"    (teens-20s)      "female_young"    (teens-20s)
      "male_adult"    (30s-50s)        "female_adult"    (30s-50s)
      "male_old"      (60+)            "female_old"      (60+)
      "child"                          "narrator"        (voice-over / unseen)
  Give EVERY character in the "characters" array one. (Bodiless voices — radio,
  earpiece, VO — still get NO entry at all, so they have no archetype; production
  gives them the narrator voice, or maps them by id.) Two characters sharing an
  age and gender is fine — production maps each one to its own real voice.

- Again: NO entry for voices that are only heard. They have no body.

=============================================================================
RECURRING VISUAL ELEMENTS THAT ARE NOT "CHARACTERS" — LOCK THEM ANYWAY
=============================================================================
A baby in a crib, a pet, a photograph of a person, a corpse, a mannequin — anything
that appears on screen more than once, has a visual identity a viewer will notice
changing, but never speaks and never gets a character-sheet entry. Without one, the
model invents its face fresh every single time it is painted, and a baby glimpsed
on a monitor becomes visibly a DIFFERENT baby than the one shown in the crib two
shots later. (Real failure: exactly this — a baby on the monitor screen and a baby
in the physical crib, in the same scene, were clearly not the same infant.)

For any such element that appears in more than one shot: write ONE short, concrete
visual description the first time it appears (e.g. "a sleeping infant, wisps of
light brown hair, wrapped in a pale blue blanket") and paste that EXACT phrase,
verbatim, into every later shot's "description" or "setting" wherever the element
appears again — the same discipline as a character's "appearance" string, just
inline instead of in its own field. Do not re-describe it differently each time.

=============================================================================
CONTINUITY (background/time drift is the #1 quality problem in AI video — enforce hard)
=============================================================================
- Unless the SCRIPT explicitly moves to a new location or time, EVERY shot MUST share the
  EXACT SAME world: same location, background, landmarks, weather, time of day, lighting.
  NEVER drift night-to-day, rain-to-clear, or a named landmark to generic buildings.
- Repeat the SAME concrete environment details VERBATIM in the "setting" of every shot, and
  the SAME time of day and mood in every shot's "lighting". Consistency beats variety.
- If the script names a REAL landmark, state it EXPLICITLY in every shot's setting.
- Only change setting/time/lighting when the SCRIPT clearly calls for a scene change.
- THE HANDOFF RULE: the film is ONE continuous take cut into pieces. Shot N+1 must OPEN
  in the exact body position, location, and world state where shot N CLOSED. Begin each
  shot's "description" (and "startFrame", when present) by restating that end state
  ("He has just landed on the far side of the wall, mid-stride, his back to it...").
  A cut hides nothing and resets nothing: no teleporting, no wardrobe change, no new
  props, no lighting shift, no undoing what already happened.

- SCREEN POSITION STAYS FIXED ACROSS A CONVERSATION. Once two characters are staged
  (who is on the LEFT of frame, who is on the RIGHT), every later shot of that same
  exchange — reverse angles, close-ups, two-shots — must keep them on THAT SAME SIDE.
  State it explicitly: "Nadia remains screen-left, Daniel screen-right, matching the
  previous shot." Only cross this 180-degree line with a deliberate, camera-move shot
  that visibly repositions around them — never silently between two static shots. A
  character who flips sides between cuts with no camera move reads as a mirror-image
  glitch, not a reverse angle.

GOAL: realistic, cinematic, photoreal LIVE-ACTION — like a real movie, never animation.
Output valid JSON. The word json must be respected.`;

// =============================================================================
// DOMAIN FACTS  (NEW)
// -----------------------------------------------------------------------------
// A video model, left alone, gives a cricketer a baseball bat, puts the coach on
// the pitch, and lets a commentator grow a body. Those are not glitches you can
// prompt away with more adjectives — they are MISSING DOMAIN FACTS. Before the
// breakdown runs, we detect what real-world domain the script is set in and inject
// the correct facts, so the plan is written right BEFORE it reaches the image model.
//
// We ship a few seed packs for the domains you actually hit; any other domain is
// derived on demand by the LLM into the same shape and cached for the process.
// Add packs freely — this is plain data.
// =============================================================================

export interface DomainPack {
  key: string;
  /** Correct shape/appearance of tools & equipment, each stating what it is NOT. */
  correctEquipment: string[];
  /** What people in this domain must be wearing / carrying. */
  requiredWardrobe: string[];
  /** Who is allowed where, and who is NOT (role placement, incl. voice-only roles). */
  roleRules: string[];
  /** Ready-to-inject negative constraints for this domain. */
  negatives: string[];
  /** Physics/continuity truths specific to this domain. */
  physicsRules: string[];
}

export const DOMAIN_PACKS: Record<string, DomainPack> = {
  cricket: {
    key: "cricket",
    correctEquipment: [
      "Cricket bat: flat willow blade, straight parallel edges, a spine on the back, roughly waist-to-chest length relative to the batsman's own height — NOT a rounded baseball bat, NOT a stubby toy-sized bat.",
      "Red or white leather cricket ball with a single seam — NOT a baseball, NOT a tennis ball.",
      "Three vertical stumps with two small bails on top, at EACH end of the pitch.",
      "Scoreboard is a STATIC board showing runs/wickets/overs — it does not animate or morph.",
    ],
    requiredWardrobe: [
      "Batsman wears a helmet with a metal grille, batting pads, gloves, and team kit or whites — the same helmet/cap stays on him through every following shot of the same continuous celebration; it does not vanish mid-scene.",
      "Fielders wear team kit — no helmet, no batting pads.",
      "Umpire in dark trousers and a light shirt/hat.",
    ],
    roleRules: [
      "The batsman stands at the crease on the pitch. He does NOT run in from the middle of the crowd.",
      "The bowler runs in along the pitch toward the batsman; a fielder does NOT run at the stumps to 'bowl'. The delivery stride and release are shown, or clearly bridged with a startFrame/endFrame pair — never cut straight from the run-up to the ball already arriving at the bat with no release moment.",
      "The bowler and batsman stand at OPPOSITE ends of the same pitch, roughly 20 metres (22 yards) apart — the bowler's run-up approaches FROM one end TOWARD the batsman at the other end; they are never on the same side, standing next to each other, or facing the same direction as if bowling from the batsman's own end.",
      "The coach stays in the dugout/pavilion and claps — the coach is NEVER on the field of play during play.",
      "The commentator is voice-only in a commentary box and has NO on-field body.",
      "Spectators stay in the stands, fully separated from the field; they do not stand on the pitch. They only cross onto the field for a final celebration, if at all.",
      "ONLY the batsman ever holds or swings the bat. The bowler and fielders never carry, hold, or swing a bat at any point — a bowler's job ends at the release of the ball, not with a bat in hand.",
    ],
    negatives: [
      "no baseball bat, no baseball, no American-football gear",
      "scoreboard must not animate or morph; the numbers are static text",
      "the ball is a single object shown once, travelling in one continuous arc — it does not duplicate or reappear",
      "the ball does not vanish from the bowler's hand between the start of the run-up and the moment of release — it is visible in hand throughout the approach",
      "the ball's color (red OR white, whichever this match uses) stays the SAME for the entire scene — it never switches from red to white or back mid-match",
      "no fielder standing at the batting crease; no coach in the middle of the field",
      "no bowler or fielder holding, carrying, or swinging a bat at any point — that is the batsman's equipment only",
      "a discarded bat and ball rest motionless on the ground under gravity once put down — they never float, hover, spin in place, or move with no one touching them",
      "no helmet or cap disappearing between shots of one continuous celebration",
    ],
    physicsRules: [
      "There is exactly one ball. After the batsman strikes it, it travels in a single arc; it does not split, duplicate, or pop back into a hand.",
      "A ball hit for six lands OUTSIDE the boundary rope (in the stands), not in front of a fielder inside the field.",
      "A bat or ball that has been set down or dropped stays on the ground under gravity — it does not lift, drift, or fly on its own with no person moving it.",
      "After striking the ball to take a run, the batsman runs FORWARD along the pitch toward the opposite end (toward the bowler's end or back toward their own, whichever the run requires) — never backward, away from both ends, or in a direction that doesn't lead to either crease.",
    ],
  },

  "interior-drama": {
    key: "interior-drama",
    correctEquipment: [
      "Ordinary domestic props (lamp, sofa, photo frame, door) stay the SAME object shot to shot.",
      "A photograph or letter shown to be read faces its PRINTED side toward the reader's eyes, not the blank back.",
    ],
    requiredWardrobe: ["Everyday clothing, consistent across the whole scene — no wardrobe change mid-scene."],
    roleRules: [
      "A door is opened ONCE to enter; a person who has entered does not re-open the same door and re-enter.",
      "A person is either inside OR outside — they do not flicker between the two across cuts.",
    ],
    negatives: [
      "the room layout and furniture must not change between shots of the same scene",
      "no duplicate of the same person in one frame",
      "no character transforming into a different-aged or different-gender person",
      "a light switched off stays off — the room is not still fully lit after the switch",
    ],
    physicsRules: [
      "Hands and bodies do not pass through walls, furniture, or each other.",
      "Once a light is turned off, the following frames are darker.",
    ],
  },

  "house-horror": {
    key: "house-horror",
    correctEquipment: [
      "A torch/flashlight stays a torch — it does not become a candle and back.",
      "A phone used to talk is held to the ear; earphones and a phone-to-ear are not both shown for the same call.",
    ],
    requiredWardrobe: ["Consistent clothing across the whole sequence."],
    roleRules: [
      "A haunting figure stays still or at a distance unless the beat IS an approach; it does not casually teleport.",
      "The explorer does not chat casually with a spirit as if it were an ordinary person.",
    ],
    negatives: [
      "no prop transforming (torch to candle); no environment changing from interior to forest mid-shot",
      "no new staircase or steps appearing in a close-up that were not in the wide shot",
      "no extra people appearing who were not established",
    ],
    physicsRules: [
      "The interior geometry (number of doors, stairs) is fixed; close-ups do not add architecture.",
      "A running person moves THROUGH space — the background streams past; no treadmill in place.",
    ],
  },
};

const DETECT_DOMAIN_SYSTEM =
  `Identify the real-world domain / sport / setting of this script in one or two lowercase ` +
  `words with hyphens if needed (examples: "cricket", "courtroom", "house-horror", ` +
  `"interior-drama", "street-chase", "kitchen-cooking", "hospital"). If nothing special ` +
  `applies, use "general". Output ONLY JSON: {"domain":"..."}.`;

const DERIVE_DOMAIN_SYSTEM =
  `You are a domain continuity expert for a film pipeline. Given a domain/genre name and a ` +
  `short script context, output the FACTS a naive video model must respect to look correct. ` +
  `Focus on what generators get WRONG: equipment shape, correct protective gear/wardrobe, ` +
  `which roles may occupy which physical areas (and which must NOT), single-instance objects, ` +
  `and period/setting-appropriate objects. Each correctEquipment item must state what the ` +
  `thing is NOT. Output ONLY JSON, no prose, matching:\n` +
  `{"key":string,"correctEquipment":string[],"requiredWardrobe":string[],` +
  `"roleRules":string[],"negatives":string[],"physicsRules":string[]}`;

async function detectDomain(context: string): Promise<string> {
  const res = await client.chat.completions.create({
    model: config.llmModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DETECT_DOMAIN_SYSTEM },
      { role: "user", content: context.slice(0, 1200) },
    ],
  });
  logUsage("detectDomain", config.llmModel, res.usage);
  try {
    const d = JSON.parse(res.choices[0]?.message?.content ?? "{}").domain;
    return typeof d === "string" && d.trim() ? d.trim().toLowerCase() : "general";
  } catch {
    return "general";
  }
}

async function getDomainPack(
  domainKey: string,
  context: string,
  cache: Record<string, DomainPack>,
): Promise<DomainPack | null> {
  const norm = domainKey.trim().toLowerCase();
  if (!norm || norm === "general") return null;
  if (DOMAIN_PACKS[norm]) return DOMAIN_PACKS[norm];
  if (cache[norm]) return cache[norm];
  try {
    const res = await client.chat.completions.create({
      model: config.llmModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DERIVE_DOMAIN_SYSTEM },
        { role: "user", content: `Domain: ${domainKey}\nContext:\n${context.slice(0, 600)}` },
      ],
    });
    logUsage("getDomainPack", config.llmModel, res.usage);
    const pack = JSON.parse(res.choices[0]?.message?.content ?? "{}") as DomainPack;
    if (!pack.key) pack.key = norm;
    cache[norm] = pack;
    return pack;
  } catch {
    return null; // never let a domain miss break a render
  }
}

function domainBlock(pack: DomainPack): string {
  const section = (label: string, arr?: string[]) =>
    arr && arr.length ? `${label}:\n${arr.map((s) => `  - ${s}`).join("\n")}` : "";
  return [
    ``,
    ``,
    `=============================================================================`,
    `DOMAIN FACTS — "${pack.key}" — THESE OVERRIDE ANY GENERIC GUESS`,
    `=============================================================================`,
    `This script is set in a specific real-world domain. A naive video model gets the`,
    `equipment, the gear, and the staging WRONG. Bake these facts into every relevant`,
    `"appearance", "setting", "description" and "motion" so the plan is correct BEFORE it`,
    `reaches the image model. When a domain fact conflicts with a generic instinct, the`,
    `domain fact wins.`,
    section("CORRECT EQUIPMENT (shape matters — state it, and state what it is NOT)", pack.correctEquipment),
    section("REQUIRED WARDROBE / GEAR", pack.requiredWardrobe),
    section("WHO STANDS WHERE (role placement — put people only where they belong)", pack.roleRules),
    section("DOMAIN PHYSICS / CONTINUITY TRUTHS", pack.physicsRules),
    section("NEGATIVES — never render these", pack.negatives),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// =============================================================================
// ACTION PRECONDITION/EFFECT INFERENCE — generative fallback for the CORE
// ACTION LIBRARY (lib/actionLibrary.ts). Same shape/discipline as
// getDomainPack() just above: a cheap-model call, Zod-validated response,
// caller owns the cache (here: compiler.ts's inference cache, since that's
// where CORE_ACTION_LIBRARY matching already happens) — this function is
// deliberately cache-agnostic, called ONLY on a genuine cache miss.
// =============================================================================

const INFER_ACTION_SYSTEM = `You are a physical-continuity analyst for a film pipeline. You are given ONE
action a character performs in a shot, and asked to infer its PRECONDITION (what must
already be true about the character's physical/spatial state for this action to make
real-world sense) and EFFECT (what becomes true about their physical/spatial state
after it) — structured data, not prose, so a compiler can check it deterministically
against every OTHER shot this same character appears in.

Think ONLY about the character's own SPATIAL state — which side of a named threshold
(door, gate, window) they are on, their posture (standing/sitting/kneeling/lying), what
object they are positioned near, and whether they are inside a vehicle. Do NOT reason
about anything else (emotion, dialogue, held props — those are handled elsewhere).

Most actions have NO precondition or effect worth stating — that is a normal, correct
answer, not a failure. Only state a fact when the action GENUINELY implies a specific
prior state (you cannot climb OUT of something you were never established as being IN)
or GENUINELY changes one (climbing through a window changes which side of it you're on).
Do not invent a constraint that isn't really there just to have something to say.

Output ONLY this JSON, no prose:
{
  "label": "<short label for this action, e.g. 'climb through a window'>",
  "category": "threshold" | "locomotion" | "object_manipulation" | "body_position" | "social_contact" | "consumption" | "vehicle",
  "precondition": [ <zero or more fact objects, see shapes below> ],
  "effect": [ <zero or more fact objects> ]
}
Each fact is EXACTLY one of these shapes — use ONLY these, no other "kind":
  {"kind":"thresholdSide","referent":"<noun, e.g. window>","side":"inside"|"outside"}
  {"kind":"postureNot","value":"standing"|"sitting"|"kneeling"|"lying"|null}
  {"kind":"postureIs","value":"standing"|"sitting"|"kneeling"|"lying"}
  {"kind":"posture","value":"standing"|"sitting"|"kneeling"|"lying"|null}
  {"kind":"nearObjectIs","referent":"<noun>"}
  {"kind":"nearObjectIsNot","referent":"<noun>"}
  {"kind":"nearObject","referent":"<noun>"|null}
  {"kind":"inVehicle","value":"<vehicle noun>"|null}
"postureNot"/"nearObjectIsNot"/"nearObjectIs"/"postureIs"/"inVehicle" (as a precondition)
describe a REQUIRED prior state. "posture"/"nearObject"/"inVehicle" (as an effect)
describe the resulting state. Referent nouns should be a single common noun (e.g.
"window", "desk", "car"), not a full phrase.`;

/** Infers a precondition/effect pair for ONE action not covered by
 *  CORE_ACTION_LIBRARY. `actionText` should be the shot's own authored
 *  motion/description text; `sceneContext` a short scene/setting summary so
 *  the model has enough to reason about referents correctly. Never throws —
 *  a failure here means "no precondition check for this action," the same
 *  fail-open discipline getDomainPack() uses, since a missed check is a far
 *  smaller cost than breaking a render over an inference call. */
export async function inferActionRule(actionText: string, sceneContext: string): Promise<InferredActionRule | null> {
  try {
    const res = await client.chat.completions.create({
      model: config.llmModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INFER_ACTION_SYSTEM },
        { role: "user", content: `Scene: ${sceneContext}\n\nAction text: ${actionText}` },
      ],
    });
    logUsage("inferActionRule", config.llmModel, res.usage);
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    return InferredActionRuleSchema.parse(parsed);
  } catch (e) {
    console.warn(`   ⚠️  action-rule inference failed (${(e as Error)?.message}) — proceeding with no precondition check for this action.`);
    return null;
  }
}

// =============================================================================
// DOMAIN/STAGING RULE INFERENCE — generative fallback for CORE_STAGING_LIBRARY
// (lib/stagingLibrary.ts). Same shape/discipline as inferActionRule() just
// above: cheap-model call, Zod-validated response, caller (compiler.ts) owns
// the cache, this function is cache-agnostic and only ever called on a
// genuine miss.
// =============================================================================

const INFER_STAGING_SYSTEM = `You are a staging/continuity analyst for a film pipeline. You are given ONE scene's
setting and description text, and asked: does this real-world location or domain have an
IMPLICIT STAGING OR POSITIONING CONSTRAINT that a script could accidentally contradict —
the way a pedestrian-only lane has no vehicle traffic, or a cricket pitch's bowler and
batsman always stand at opposite ends?

Most scenes have NO such constraint worth stating — an ordinary living room, a office, a
generic outdoor space. That is a normal, correct answer ("applies": false), not a failure.
Only answer "applies": true when the location is a REAL, RECOGNIZABLE domain/setting type
with a genuine, well-known real-world staging rule — not a guess, not something invented
to have something to say.

When it DOES apply, describe the constraint as a short list of plain-English facts, AND
give two keyword lists (NOT regular expressions — plain words/short phrases only, the
system builds the matching itself): "triggerKeywords" are words that would appear in text
correctly describing this domain/location type (e.g. for a pedestrian zone: "pedestrian",
"footpath only", "no vehicles"); "contradictsKeywords" are words that, appearing in the
SAME scene's text, would contradict that constraint (e.g. "car passes", "vehicle moving",
"engine revs"). Keep each keyword list short (3-8 entries) and specific — vague words
produce false positives.

Output ONLY this JSON, no prose:
{
  "applies": boolean,
  "label": "<short label for this domain/staging type>",
  "facts": ["<plain-English statement of the constraint>", ...],
  "triggerKeywords": ["<word or short phrase>", ...],
  "contradictsKeywords": ["<word or short phrase>", ...]
}`;

/** Infers a staging rule for ONE scene not covered by CORE_STAGING_LIBRARY.
 *  `sceneText` should be the scene's own authored setting/description text.
 *  Never throws — a failure here means "no staging check for this scene,"
 *  the same fail-open discipline inferActionRule()/getDomainPack() use. */
export async function inferStagingRule(sceneText: string): Promise<InferredStagingRule | null> {
  try {
    const res = await client.chat.completions.create({
      model: config.llmModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INFER_STAGING_SYSTEM },
        { role: "user", content: `Scene: ${sceneText}` },
      ],
    });
    logUsage("inferStagingRule", config.llmModel, res.usage);
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    return InferredStagingRuleSchema.parse(parsed);
  } catch (e) {
    console.warn(`   ⚠️  staging-rule inference failed (${(e as Error)?.message}) — proceeding with no staging check for this scene.`);
    return null;
  }
}

// =============================================================================
// LEARNED DIRECTOR RULES  (NEW, optional)
// -----------------------------------------------------------------------------
// Grows a rules log without editing this 800-line prompt. Point DIRECTOR_RULES_PATH
// at the DIRECTOR_RULES.json file and its rules get appended to the system prompt on
// every plan. If the env var is unset or the file is missing, this is a silent no-op.
// Shape: { "version": number, "rules": [ { "rule": string, ... } ] }
// =============================================================================

async function loadDirectorRules(): Promise<string> {
  const path = process.env.DIRECTOR_RULES_PATH;
  if (!path) return "";
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as { rules?: { rule?: string }[] };
    const items = (file.rules ?? []).map((r) => r.rule).filter((r): r is string => !!r);
    if (!items.length) return "";
    return (
      `\n\n=============================================================================\n` +
      `LEARNED DIRECTOR RULES (accumulated from past failures — obey every one)\n` +
      `=============================================================================\n` +
      items.map((r) => `- ${r}`).join("\n")
    );
  } catch {
    return "";
  }
}

// =============================================================================
// SYSTEM PROMPT ASSEMBLY  (NEW)
// -----------------------------------------------------------------------------
// SYSTEM_PROMPT + domain facts (if any) + learned rules (if any). The domain is
// detected once per film and cached by a stable signature so per-shot regen/repair
// calls don't re-classify.
// =============================================================================

const domainCache: Record<string, DomainPack> = {}; // domainKey -> pack, for this process
const detectCache = new Map<string, string>();       // signature -> domainKey

async function resolveDomainKey(context: string, signature: string): Promise<string> {
  const hit = detectCache.get(signature);
  if (hit) return hit;
  const key = await detectDomain(context);
  detectCache.set(signature, key);
  return key;
}

/**
 * Returns the pack too, not just the built prompt string — breakdownScript()
 * (the only caller that CREATES a fresh Breakdown, rather than editing an
 * existing one) attaches it as bd.domainPack so compiler.ts can deterministically
 * fold pack.negatives/physicsRules into every shot's negativePrompt at render
 * time, not just at planning time. Before this, a domain's facts (e.g. cricket's
 * "a ball hit for six lands OUTSIDE the boundary rope", "coach stays in the
 * dugout") only ever reached the LLM's planning prompt — nothing enforced them
 * once shots existed, and neither compiler.ts nor qa.ts had any domain-specific
 * category at all.
 */
// knownPack: pass breakdown.domainPack when the caller is editing an EXISTING
// breakdown (every caller except breakdownScript itself) — skips detectDomain/
// getDomainPack entirely instead of re-deriving the SAME classification every
// single call. Confirmed real cost: a single breakdown's repair loop alone
// made 5+ redundant detectDomain/getDomainPack round-trips (one per repair
// round, one before the read-through, one before length reconciliation),
// each a real network round-trip to the LLM for a domain that was already
// known the moment breakdownScript() first classified it. Pass `undefined`
// (the default) to detect fresh, `null` explicitly for "confirmed no domain
// pack" (skips detection AND applies no block), or a real DomainPack to reuse
// it as-is.
/** The spoken-language instruction, appended to the system prompt for every
 *  call that can WRITE or REWRITE a shot's dialogue (planning, repair, regen,
 *  insert, variety revision). Empty for English, so an English film's prompt is
 *  byte-identical to what it has always been.
 *
 *  The hard part this text exists to enforce is the asymmetry: dialogue in the
 *  target language, EVERYTHING ELSE in English. An LLM told "write this film in
 *  Tamil" will cheerfully translate the shot descriptions too, and those are
 *  prompts for image/video models that are trained overwhelmingly on English —
 *  the render quality would drop across the board while the feature still
 *  looked like it worked. See lib/languages.ts's own comment. */
function languageBlock(languageCode: string | null | undefined): string {
  if (!isTranslated(languageCode)) return "";
  const name = languageName(languageCode);
  return `

SPOKEN LANGUAGE — THIS FILM IS PERFORMED IN ${name.toUpperCase()}.
- Every "dialogue" value MUST be written in ${name}, in ${name}'s own native script (never romanised/transliterated into Latin letters). The video model reads this text and SPEAKS it aloud, so it is the actual performed line, not a translation note.
- Write it as a native ${name} screenwriter would: idiomatic, natural spoken register for the character and situation. Do NOT translate English word-for-word, and do not leave English filler words in unless a real speaker of ${name} would genuinely code-switch there.
- If the supplied screenplay is written in English (or any other language), TRANSLATE each spoken line into ${name} as you plan. Preserve the meaning, intent and emotional beat of the original line — never invent new plot content that the script does not contain, and never drop a line because it is hard to translate.
- EVERY OTHER FIELD STAYS IN ENGLISH. "description", "motion", "setting", "camera", "lighting", "startFrame", "endFrame", character "appearance", "title", and every other string are PROMPTS for image and video models, not prose for a reader — they must remain English. Only "dialogue" is in ${name}.
- Character NAMES stay as the script writes them (they identify a person across shots and are matched by exact string elsewhere in this pipeline).`;
}

/**
 * Injected ONLY when the script already enumerates its own shots (see
 * countExplicitShots() in steps/1-breakdown.ts). Empty otherwise, so a prose
 * script's prompt is byte-identical to what it has always been.
 *
 * WHY THIS EXISTS. Everything else this prompt says about shot count pushes in
 * ONE direction: don't add, don't pad, cap new content at one or two bridging
 * shots. That is correct for a prose script, where the risk is invention. It is
 * actively harmful when the script IS a finished shot list, because the model
 * reads all that restraint as licence to CONSOLIDATE — and nothing anywhere
 * told it not to.
 *
 * CONFIRMED REAL FAILURE, and the reason for every line below: a genuine
 * 83-shot, 4-minute shot list with per-shot timecodes came back as 26 shots
 * totalling 92 on-screen seconds. The film shipped at 1:32 against a 4:00
 * target — roughly two thirds of the writer's film deleted, and every deleted
 * shot's dialogue with it. The user did not ask for an interpretation of their
 * shot list; they asked for it to be filmed.
 */
function shotListBlock(explicitShots: number | null | undefined): string {
  const n = typeof explicitShots === "number" ? explicitShots : 0;
  if (n < 2) return "";
  return `

THIS SCRIPT IS ALREADY A SHOT LIST — IT ENUMERATES ${n} SHOTS. FILM IT, DO NOT REINTERPRET IT.
- Produce ONE shot in "shots" for EACH of the ${n} shots the script enumerates, in the SAME ORDER. The target count is ${n}, and it is a SPECIFICATION, not a suggestion.
- Do NOT merge, combine, collapse, condense, or summarise two or more of the script's shots into one. A writer who numbered ${n} separate shots chose ${n} separate camera setups; merging them silently deletes their film and destroys the cutting rhythm, which in a shot list this granular IS the direction.
- Do NOT drop a shot because it seems small, repetitive, or "coverable elsewhere". A 2-second insert of a phone screen, a hand, or a face is a real shot and must appear as its own entry. Short is not the same as unimportant — rapid cutting is a deliberate technique.
- EVERY line of dialogue attached to a script shot MUST appear in the "dialogue" field of the shot that corresponds to it. Never move a line to a different shot, never merge two characters' lines into one shot, and never drop a line. The dialogue is the writer's actual words and is the single most important thing to preserve.
- IF THE SCRIPT GIVES TIMINGS (e.g. "0:03–0:07", or "SHOT 4 — 3 sec"), set each shot's "duration" from that shot's OWN stated length, rounded to the nearest whole second and never below 2. Do not average them, do not lengthen a short shot to make it "breathe", and do not stretch shots to reach a runtime — the per-shot timings ARE the runtime.
- The restraint rules earlier in this document (the cap on added shots, "do not pad", "do not invent") still apply in full and are NOT relaxed here. They forbid ADDING content that isn't written. This section forbids REMOVING content that is. Both at once: match the script's shots one-for-one — neither more nor fewer.
- If you genuinely cannot render one enumerated shot as one shot, still emit an entry for it rather than omitting it, and keep its dialogue intact.`;
}

async function buildAugmentedSystem(
  context: string,
  knownPack?: DomainPack | null,
  languageCode?: string | null,
  explicitShots?: number | null,
): Promise<{ system: string; pack: DomainPack | null }> {
  let block = "";
  let pack: DomainPack | null = null;
  if (knownPack !== undefined) {
    pack = knownPack;
    if (pack) block = domainBlock(pack);
  } else {
    // DERIVED, NOT PASSED IN. This used to take a caller-supplied `signature`
    // for the detectCache key — regenerateShot()/repairShots() passed
    // `breakdown.title || shot.id`, and a title is a short, often-generic
    // string an LLM or user can easily reuse across two UNRELATED projects
    // ("Untitled", "The Encounter", ...). Two different projects colliding on
    // that key would silently share detectCache's cached domain classification
    // — project B's regen/repair calls would get project A's domain facts
    // injected (wrong equipment/staging guidance for its actual content). This
    // process-lifetime cache is never cleared between jobs, so the risk isn't
    // limited to concurrent workers — any two projects processed by the same
    // long-running worker over its lifetime could collide. Deriving the
    // signature from the CONTEXT the caller already has (length + a real
    // content snippet) instead removes the fragility instead of trusting every
    // call site to supply something sufficiently unique.
    const signature = `${context.length}:${context.slice(0, 200)}`;
    try {
      const key = await resolveDomainKey(context, signature);
      pack = await getDomainPack(key, context, domainCache);
      if (pack) block = domainBlock(pack);
    } catch (e) {
      console.warn("⚠️  domain facts skipped:", (e as Error).message);
    }
  }
  const rules = await loadDirectorRules().catch(() => "");
  // Language LAST, after the domain pack and the director rules: those are both
  // written in English and can mention dialogue in passing, and the instruction
  // that must not be overridden should be the final word in the prompt.
  // Shot-list preservation goes LAST, after the language block and the learned
  // director rules: it exists to override the consolidation pressure the main
  // prompt applies, so nothing may come after it and re-apply that pressure.
  return {
    system: SYSTEM_PROMPT + block + rules + languageBlock(languageCode) + shotListBlock(explicitShots),
    pack,
  };
}

// =============================================================================
// PUBLIC API  (unchanged behaviour — now domain-aware)
// =============================================================================

/** True when the API rejected the MODEL itself (no access / does not exist), not
 *  the request content. Distinct from a content refusal or a transient 5xx — this
 *  is "this account can't call gpt-5.6-sol" and retrying identically will never
 *  succeed, so it is worth ONE automatic downgrade rather than failing the whole
 *  breakdown over an access-tier mismatch this codebase cannot know about ahead
 *  of time. */
function isModelAccessError(e: any): boolean {
  if (e?.status === 404) return true;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return /model_not_found|does not exist|do not have access|not supported for this model|invalid model/.test(text);
}

/**
 * True when THIS SINGLE REQUEST exceeds the account's per-minute token limit for the
 * model -- e.g. "429 Request too large for gpt-4.1 ... TPM Limit 30000, Requested
 * 33325". This is NOT a "you've used your quota for this minute, wait and retry"
 * throttle (that would eventually succeed identically) -- the exact same request will
 * 429 again a minute from now, an hour from now, forever, until either the request
 * shrinks or the account's limit goes up. Retrying without changing anything is a
 * guaranteed-failure loop; the only real fix is fewer tokens per call.
 */
function isRequestTooLargeError(e: any): boolean {
  if (e?.status !== 429) return false;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return /request too large|tokens per min|rate_limit_exceeded/.test(text);
}

/** Rough chars/4 estimate -- good enough to decide whether a request is anywhere near
 *  an account's TPM ceiling without pulling in a real tokenizer for a safety margin. */
function estimateTokens(s: string): number {
  return Math.ceil((s ?? "").length / 4);
}

/**
 * Text tokens were "pennies" back when this comment was first written — before the
 * system prompt grew domain packs and a LEARNED DIRECTOR RULES file, and before the
 * repair loop ran a second/third flagship-model call on top of the planning call.
 * Neither of those is true anymore, so make the spend visible instead of assumed.
 * Never throws: a logging failure must not kill a render.
 */
function logUsage(label: string, model: string, usage: any): void {
  try {
    if (!usage) return;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    console.log(
      `   💬 ${label} [${model}]: ${usage.prompt_tokens ?? "?"} in` +
      (cached ? ` (${cached} cached)` : "") +
      ` + ${usage.completion_tokens ?? "?"} out = ${usage.total_tokens ?? "?"} tokens`,
    );
  } catch {
    // logging must never break a render
  }
}

export async function breakdownScript(
  script: string,
  languageCode?: string | null,
  explicitShots?: number | null,
): Promise<Breakdown> {
  // NEW: detect the domain and inject its facts BEFORE planning, so the plan is
  // written with correct equipment/staging instead of generic guesses.
  const { system, pack } = await buildAugmentedSystem(script, undefined, languageCode, explicitShots);

  const attempt = async (model: string): Promise<Breakdown> => {
    const res = await client.chat.completions.create({
      // The DIRECTOR call: it reads the whole script once and plans the whole
      // film in one pass. This is where causal-chain logic, continuity, and
      // "does shot 7 make sense given shot 3" live or die -- worth the stronger
      // model. Text tokens here are cents; a single wasted video render is dollars.
      model,
      // Structural planning is not a creative act. Was 0.6 — that variance was buying
      // nothing but a different way to break each run. Omitted entirely on a
      // reasoning-tier model (GPT-5 family, o-series) — those REJECT a custom
      // temperature in Chat Completions and sample internally instead.
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Screenplay:\n\n${script}` },
      ],
    });
    logUsage("breakdownScript", model, res.usage);
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
    // Persisted onto the breakdown (not just used to build this prompt) so
    // compiler.ts can deterministically fold the domain's negatives/
    // physicsRules into every shot's negativePrompt at render time — see
    // buildAugmentedSystem()'s own comment for why this didn't happen before.
    if (pack) parsed.domainPack = pack;
    // Set by US, never trusted from the model's own output — same discipline as
    // domainPack just above. The LLM is TOLD the language; it does not get to
    // report back a different one, which is how a value silently drifts and a
    // later regen pass then plans in the wrong language.
    parsed.language = resolveLanguage(languageCode) ?? DEFAULT_LANGUAGE;
    return BreakdownSchema.parse(parsed);
  };

  try {
    return await attempt(config.breakdownModel);
  } catch (e) {
    // MODEL ACCESS FAILURE, or a REQUEST-TOO-LARGE 429 — neither is worth retrying on
    // the same model: an access failure never clears, and a request that exceeds the
    // account's per-minute token ceiling for THIS model will 429 identically forever,
    // no matter how long you wait. Downgrade once to the known-working default and
    // warn loudly, rather than failing the render before a dollar of video is spent.
    if ((isModelAccessError(e) || isRequestTooLargeError(e)) && config.breakdownModel !== config.llmModel) {
      console.warn(
        `⚠️  ${config.breakdownModel} could not process this script (${(e as Error).message}). ` +
        `Falling back to ${config.llmModel} for this film. Fix BREAKDOWN_MODEL in .env to stop seeing this.`,
      );
      return await attempt(config.llmModel);
    }
    console.warn("⚠️  Breakdown parse failed once, retrying...");
    return await attempt(config.breakdownModel);
  }
}

/**
 * SONG VIDEOS — theme/mood prompt -> structured lyrics + a style prompt for
 * song.ts's generateSong() call. Same call shape as breakdownScript() just
 * above (one planning-tier LLM call, JSON response, zod-validated).
 *
 * COMPLIANCE GUARD, baked into the system prompt rather than a separate
 * check: never reference a real, named artist/band, and never reproduce an
 * identifiable existing song's actual lyrics, even if the user's own theme
 * prompt asks for one — write an ORIGINAL style description inspired by the
 * requested genre/mood instead. Mirrors the same real-person-likeness
 * precaution this pipeline already takes for VISUAL identity (character
 * image generation rejects/avoids real-person likeness — see 2-options.ts),
 * applied here to musical likeness. This is NARROWER than and additional
 * to the general moderateText() safety gate safa-web already runs on the
 * theme prompt before this is ever called (per user confirmation, 2026-08-05)
 * — that catches unsafe content broadly, this specifically catches artist
 * mimicry requests that moderateText() has no reason to flag as unsafe.
 *
 * Higher temperature than breakdownScript()'s 0.3: THAT call is structural
 * planning ("not a creative act," per its own comment) where variance buys
 * nothing; writing a song's actual words is a genuinely creative task where
 * some variance is the point.
 */
export async function generateLyrics(theme: string, targetLengthSec: number): Promise<LyricsResult> {
  const system = `You are a songwriter and music director. Given a theme/mood prompt, write a complete original song: a title, a STYLE description (genre, instrumentation, tempo, mood — for a music generation model, NOT lyrics), and the full lyrics broken into sections.

STRUCTURE: use only these section tags: Intro, Verse, Pre Chorus, Chorus, Post Chorus, Hook, Bridge, Interlude, Transition, Build Up, Break, Inst, Solo, Outro. A typical song: Intro (optional), Verse, Chorus, Verse, Chorus, Bridge, Chorus, Outro (optional) — adapt the structure to fit the target length below. "Inst"/"Interlude"/"Break" sections must have EMPTY "lines" (instrumental, no vocals).

TARGET LENGTH: approximately ${targetLengthSec} seconds of sung/instrumental content. Section count and line count per section are your only real levers (you don't control tempo) — roughly 6-10 seconds per sung line is a reasonable guide for a mid-tempo song.

COMPLIANCE, NON-NEGOTIABLE: never name a real artist, band, or musician anywhere in the style description or lyrics, even if the theme prompt asks you to sound like one — write an ORIGINAL style description inspired by the requested genre/mood/era instead, using only generic descriptive language (instrumentation, tempo, genre, emotional tone). Never reproduce or closely paraphrase an identifiable existing song's actual lyrics or title.

Return ONLY valid JSON: {"title": string, "stylePrompt": string, "sections": [{"tag": string, "lines": string[]}]}`;

  const attempt = async (model: string): Promise<LyricsResult> => {
    const res = await client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.7 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Theme/mood: ${theme}` },
      ],
    });
    logUsage("generateLyrics", model, res.usage);
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
    return LyricsResultSchema.parse(parsed);
  };

  try {
    return await attempt(config.breakdownModel);
  } catch (e) {
    if ((isModelAccessError(e) || isRequestTooLargeError(e)) && config.breakdownModel !== config.llmModel) {
      console.warn(
        `⚠️  ${config.breakdownModel} could not generate lyrics (${(e as Error).message}). ` +
        `Falling back to ${config.llmModel}.`,
      );
      return await attempt(config.llmModel);
    }
    console.warn("⚠️  Lyrics generation parse failed once, retrying...");
    return await attempt(config.breakdownModel);
  }
}

/**
 * SONG VIDEOS — turns a generated song (LyricsResult + its real SongResult
 * section timing, from song.ts's generateSong()) into a Breakdown-shaped
 * shot list, the song-video sibling of breakdownScript() above. Genuinely
 * simpler than that function's prompt (which is 1000+ lines of narrative-
 * specific guidance — dialogue timing, vehicle/pedestrian safety, causal-
 * chain planning): none of that applies here. This prompt only plans WHAT
 * THE CAMERA SHOWS per song section; compileBreakdown() (called by the
 * caller, steps/1b-song-breakdown.ts, same as breakdownScript()'s caller
 * calls it) does the SAME enforcement pass either way — negative prompts,
 * lens library, identity lock reinforcement, camera continuity — since all
 * of that is keyed off shot.characters/shot.camera/shot.motion, not
 * anything narrative-specific.
 *
 * `performerAppearance` is OPTIONAL (confirmed via user scoping, 2026-08-05):
 * when given, exactly one Character is created and threaded through every
 * shot's `characters`/identity-lock reminder, same as a narrative film's
 * cast; when omitted, `characters: []` on every shot — abstract/B-roll
 * visuals, no cast, no character-casting steps run downstream (see
 * worker.ts's handleSongBreakdown()).
 *
 * DURATION IS NOT NEGOTIABLE the way a narrative shot's pacing is: each
 * section's shots' screenSeconds MUST sum to that section's real timing
 * (from song.sections[].startSec/endSec, itself probed from the actual
 * generated audio — not a target to approximate). The prompt states each
 * section's exact real duration and asks for shots whose screenSeconds sum
 * to it; 6-assemble.ts's song-primary finishing path (see its own comment)
 * is the final backstop that reconciles the ASSEMBLED film's total length
 * against the song's real length regardless of small planning drift here.
 */
export async function breakdownSong(
  lyrics: LyricsResult,
  song: { sections: { tag: string; startSec: number; endSec: number }[] },
  visualTheme: string,
  performerAppearance?: string,
): Promise<Breakdown> {
  const sectionsText = lyrics.sections
    .map((s, i) => {
      const timing = song.sections[i];
      const durationSec = timing ? Math.round((timing.endSec - timing.startSec) * 10) / 10 : 0;
      const lyricsText = s.lines.length ? s.lines.join(" / ") : "(instrumental, no lyrics)";
      return `Section ${i + 1}: "${s.tag}" — real duration ${durationSec}s — lyrics: ${lyricsText}`;
    })
    .join("\n");

  const system = `You are a music video director. Plan the SHOT LIST for a song video — what the camera shows during each section of an already-written, already-recorded song. You are NOT writing the song; the lyrics and section timing below are fixed and real.

VISUAL THEME (what the video should look like, from the user): ${visualTheme}

${performerAppearance
    ? `PERFORMER: one on-screen character, id "performer", described as: ${performerAppearance}. Include them in shots where it suits the visual theme (performing, reacting, present in the scene) — not necessarily every shot. Their "voice" field must be EXACTLY one of: "male_young", "male_adult", "male_old", "female_young", "female_adult", "female_old", "child", "narrator" — chosen from their age/gender, never a free-text description.`
    : "NO ON-SCREEN CHARACTERS — this is an abstract/B-roll style video (objects, environments, textures, motion, light — no people). Every shot's \"characters\" array must be empty, and \"characters\" at the top level must be an empty array."}

FOR EACH SECTION, plan 1 or more shots whose "screenSeconds" values SUM EXACTLY to that section's stated real duration (a section can be one long shot or several quick cuts — vary it, don't make every section identical pacing). Each shot's "duration" (the actual render length sent to the video model) should be between ${config.shotDuration} and ${config.maxDuration} seconds — if a shot's intended screenSeconds is shorter than that floor, set "duration" to the floor and "screenSeconds" to the shorter intended value (a rapid-cut trim, same mechanic a narrative film uses for a sub-floor beat).

Set each shot's "scene" AND "songSection" to the section's own tag + index (e.g. "verse-1", "chorus-1", "chorus-2") — this is the section-grouping key that keeps shots within one section visually continuous. Leave "dialogue"/"speaker" empty on every shot — nobody speaks lines in a song video, the song itself is the only audio.

Every shot needs: description, setting, motion, camera, lighting, ambience — the same visual-direction fields a narrative film's shots use. Vary camera/lighting across sections to match the song's own emotional arc (a chorus reads differently than a verse).

Return ONLY valid JSON matching this shape: {"title": string, "characters": [{"id","name","appearance","voice"}], "shots": [{"id","scene","songSection","description","setting","characters":[],"motion","camera","lighting","ambience","duration","screenSeconds"}]}`;

  const attempt = async (model: string): Promise<Breakdown> => {
    const res = await client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.4 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Song: "${lyrics.title}"\nStyle: ${lyrics.stylePrompt}\n\n${sectionsText}` },
      ],
    });
    logUsage("breakdownSong", model, res.usage);
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
    return BreakdownSchema.parse(parsed);
  };

  try {
    return await attempt(config.breakdownModel);
  } catch (e) {
    if ((isModelAccessError(e) || isRequestTooLargeError(e)) && config.breakdownModel !== config.llmModel) {
      console.warn(
        `⚠️  ${config.breakdownModel} could not plan this song video (${(e as Error).message}). ` +
        `Falling back to ${config.llmModel}.`,
      );
      return await attempt(config.llmModel);
    }
    console.warn("⚠️  Song breakdown parse failed once, retrying...");
    return await attempt(config.breakdownModel);
  }
}

// Same reasoning as qa-runtime.ts's own QA_MODEL constant: a separate,
// independently-tunable model for a vision-capable call, not folded into the
// shared config.ts object — this is the one other place in the pipeline that
// ever sends an image alongside a prompt to a chat-completion call.
const AD_VISION_MODEL = process.env.AD_VISION_MODEL?.trim() || config.breakdownModel;

/**
 * Ad mode (Project.type "ad") — a short creative PROMPT, not a narrative
 * script, planned into a Breakdown-shaped shot list by a dedicated
 * "professional ad director" persona. Same "vision call only when there's
 * an image to look at" pattern qa-runtime.ts's inspectClip() already uses —
 * with a real product photo, the model is SHOWN it (so it describes the
 * actual product's shape/color/material/label, not a guess); without one,
 * it works from the text prompt alone. `hasCharacter` (from the caller's own
 * `project.characterImages.length > 0` check — never this file's job to know
 * about uploads directly) tells the director whether a spokesperson/
 * lifestyle shot is available to plan around at all; the character it
 * invents here (id "model") gets REPLACED wholesale by the user's actual
 * uploaded photo at casting time (see 2-options.ts) — this call never sees
 * that photo itself, so the character's own "appearance" text here is just a
 * plausible placeholder, not the real identity the render will use.
 *
 * HONEST LIMIT, STATED FOR ANYONE READING THIS LATER: the "signature dynamic
 * effect" shot (a perfume's spray/mist, a drink's pour/splash, etc.) is
 * planned here as vivid, specific PROMPT TEXT — the same mechanism every
 * other physical action in this codebase already relies on. There is no
 * simulation engine and no guarantee the video model renders it well; good,
 * specific language is the only lever available. Same for the 360°/orbit
 * shot: it's a `camera`/`motion` field describing continuous rotation, not a
 * new provider capability (video.ts needs no changes for either).
 */
export async function breakdownAd(
  prompt: string,
  productImageUrl: string | undefined,
  targetSeconds: number,
  hasCharacter: boolean,
  // USER-FACING "signature camera style" picker (Ad mode's attach-bar) — a
  // key into CAMERA_MOVE_LIBRARY.json (see compiler.ts's getCameraMoveByKey).
  // undefined/unmatched key = unchanged default behavior (the director
  // always plans a 360°/orbit shot, exactly as before this param existed).
  cameraStyleKey?: string,
): Promise<Breakdown> {
  const chosenStyle = cameraStyleKey ? getCameraMoveByKey(cameraStyleKey) : undefined;
  const signatureCameraInstruction = chosenStyle
    ? `A SIGNATURE CAMERA-MOVE SHOT — the user explicitly chose a "${chosenStyle.name}" style for this ad's standout camera moment. Use EXACTLY this camera direction, written literally into the "camera" and/or "motion" field: ${chosenStyle.description}`
    : `A 360°/ORBIT SHOT — the camera moves in a continuous circle around the product, showing it from every side. Write this literally into the "camera" and/or "motion" field, e.g. "the camera orbits smoothly 360 degrees around the product, which stays centered and still" — do not just imply rotation, state it as the camera's own described motion.`;
  const system = `You are a professional advertising film director and copywriter, planning the SHOT LIST for a short, premium, cinematic product commercial. You are NOT writing a narrative story — every shot exists to sell this product.

${productImageUrl
    ? `A real photo of the product is attached below. Look at it carefully and describe it ACCURATELY in your shots — its real shape, color, material, proportions, and any visible label/branding text — never invent a different-looking product than what's actually shown.`
    : `No product photo was provided — infer the product and its category from the creative brief below as specifically as you can, and describe a plausible, concrete version of it consistently across every shot (same color, shape, material, label details every time it appears).`}

${hasCharacter
    ? `A spokesperson/model IS wanted in this ad. Invent one character, id "model", and a "voice" field set to EXACTLY one of "male_young"/"male_adult"/"male_old"/"female_young"/"female_adult"/"female_old" (never a free-text description). Their "appearance" must be a SPECIFIC, castable physical description — age range, build, hair, skin tone, wardrobe, styling — that suits this product's target customer: if the user did not attach their own photo, this text is what the casting images are generated from, so vague wording like "an attractive person" produces an unusable cast. Use them in ONE shot that shows a person genuinely using/enjoying/wearing the product — the product itself must still be the hero of the ad, not the person.`
    : `NO on-screen people — every shot's "characters" array must be empty, and "characters" at the top level must be an empty array. This ad is entirely about the product itself.`}

PLAN A REAL AD STRUCTURE, not an arbitrary sequence — cover, across your shots:
1. A HERO REVEAL — the product's first, best-looking appearance, establishing what it is.
2. ${signatureCameraInstruction}
3. A MACRO/TEXTURE CLOSE-UP — an extreme close-up on the product's most distinctive material, surface, or detail (glass, fabric weave, condensation, stitching, screen glow — whatever this specific product actually has).
4. ONE SIGNATURE DYNAMIC-EFFECT SHOT — the single most visually exciting thing this product DOES, described vividly and specifically, physically grounded in what the product really is. Examples of the KIND of specificity wanted (invent your own for whatever this product actually is, don't reuse these unless they genuinely apply): a perfume bottle's atomizer releasing a fine mist with individual droplets catching the light; a drink being poured with visible splash, bubbles, and condensation running down the glass; a cosmetic swiped across a surface showing its texture and pigment; a shoe's sole flexing and striking the ground with visible impact; a tech device's screen lighting up with a crisp interface animation. Whatever you choose, describe the physical motion and visual detail concretely enough that a video model has something specific to render — vague language like "the product looks appealing" is a failure here.
5. A CLOSING HERO/PACK SHOT — the product centered, still, clean bright/premium background, label facing camera — the last thing the viewer sees.

ONE SINGLE BACKDROP, UGC-CREATOR STYLE: the ENTIRE ad happens in ONE location. Every shot's "setting" must describe the SAME single backdrop, using the same base wording every time — what changes between shots is the framing, camera distance, and what the product is doing (described in "description"/"camera"/"motion"), NEVER the place itself. Do not invent a second room, studio, or environment for any shot.

EVERY SHOT IS ANIMATED — never a static, frozen frame. Each shot's "motion" field must state continuous, visible movement: the camera's own move AND at least one animated element of the scene itself (drifting mist or smoke, floating petals or fine particles catching the light, a shimmering light sweep, liquid rippling or pouring, condensation running, fabric stirring in a breeze — pick what physically fits THIS product). Describe the animation concretely enough for a video model to render it; "subtle movement" alone is a failure.

Every shot needs: description, setting, motion, camera, lighting, ambience (keep ambience minimal/clean — a product ad is not a noisy environment). Total "screenSeconds" across all shots must sum to approximately ${targetSeconds} seconds. Each shot's "duration" (actual render length) should be between ${config.shotDuration} and ${config.maxDuration} seconds — if a shot's intended screenSeconds is shorter than that floor, set "duration" to the floor and "screenSeconds" to the shorter intended value, same rapid-cut-trim convention a narrative film uses.

Return ONLY valid JSON matching this shape: {"title": string, "characters": [{"id","name","appearance","voice"}], "shots": [{"id","scene","description","setting","characters":[],"motion","camera","lighting","ambience","duration","screenSeconds"}]}`;

  const userContent: any = productImageUrl
    ? [
        { type: "text", text: `Creative brief: ${prompt}` },
        { type: "image_url", image_url: { url: productImageUrl } },
      ]
    : `Creative brief: ${prompt}`;

  const attempt = async (model: string): Promise<Breakdown> => {
    const res = await client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.4 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });
    logUsage("breakdownAd", model, res.usage);
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
    return BreakdownSchema.parse(parsed);
  };

  try {
    return await attempt(productImageUrl ? AD_VISION_MODEL : config.breakdownModel);
  } catch (e) {
    if ((isModelAccessError(e) || isRequestTooLargeError(e)) && AD_VISION_MODEL !== config.llmModel) {
      console.warn(`⚠️  ${AD_VISION_MODEL} could not plan this ad (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      return await attempt(config.llmModel);
    }
    console.warn("⚠️  Ad breakdown parse failed once, retrying...");
    return await attempt(productImageUrl ? AD_VISION_MODEL : config.breakdownModel);
  }
}

/**
 * CONTENT-INVENTION GUARD — checks whether any shot describes an action,
 * event, obstacle, location, or object the SCRIPT does not actually
 * describe or clearly imply.
 *
 * ORIGINALLY gated to prose scripts only (`explicitShots < 2` at the sole
 * call site in 1-breakdown.ts), on the reasoning that a script with its own
 * NUMBERED shot list is already covered by the over/under-expansion guards
 * next to that call site. CONFIRMED REAL GAP: those two guards only ever
 * compare the resulting shot COUNT against the script's numbered count —
 * they have no way to notice that the shots are the wrong ones. A real
 * 83-shot numbered script came back with 86 shots (well inside the
 * over-expansion guard's 2x allowance) but one of those shots was a
 * rearview-mirror reflection composition that does not exist anywhere in the
 * script, replacing what should have been direct coverage of a written beat
 * — the exact "reflective-surface (mirror/glass) shot" invention this
 * function's own correction text (see the retry prompt in 1-breakdown.ts)
 * already calls out as forbidden, just never actually checked for on a
 * numbered script. A script having a numbered list constrains shot COUNT,
 * not shot CONTENT, so this check is now run for every script, numbered or
 * prose alike — the two guard types check different axes of the same
 * "did the breakdown stay faithful to what was written" question.
 *
 * Also called a second time, later in the pipeline, on the FINAL shot list
 * (see the closing content-invention pass in 1-breakdown.ts) — the repair
 * loop, director's read-through, and length reconciliation all rewrite or
 * add shots of their own after this function's first call, and any of them
 * can reintroduce exactly the same class of invention this function exists
 * to catch (see the repair loop's own "family walking out of the house"
 * comment in 1-breakdown.ts for a confirmed real case of a later pass
 * inventing unwritten content).
 *
 * Deliberately a SEPARATE LLM call rather than a text heuristic: whether a
 * shot's action is "in the script" is a semantic question (paraphrasing,
 * splitting one beat into two shots, and a reasonable connective/
 * establishing shot are NOT violations) that a keyword/regex match cannot
 * reliably judge without either missing real inventions or false-flagging
 * ordinary paraphrasing. One cheap text call — the exact same "costs nothing
 * but a text call" reasoning the over/under-expansion guards next to this
 * already use.
 */
export async function checkScriptContentInvention(
  script: string,
  shots: Shot[],
): Promise<{ invented: boolean; shotIds: string[]; detail: string }> {
  const system = `You are a script supervisor comparing a SCRIPT against a SHOT LIST that is supposed to break it down into filmable shots. Your ONLY job: decide whether any shot describes an action, event, obstacle, location, or object that the script does NOT actually describe or clearly imply.

NOT a violation: paraphrasing the script's own words, splitting one written beat into two shots, or an ordinary connective/establishing shot that stays inside a location/action the script already places the characters in (e.g. walking toward a place the script says they go, reacting to something the script says happens).

IS a violation: a shot inventing a materially different event that changes what happens in the story — a new obstacle or action sequence the script never wrote, a location the script never goes to, an object that never appears in the script, a character doing something the script gives no basis for at all.

Return ONLY valid JSON: {"invented": boolean, "shotIds": ["<id>", ...], "detail": "<if true, name the specific shot id(s) and exactly what they invented; empty string if false>"}
"shotIds" must list every shot id that has a violation (empty array if "invented" is false).`;

  const userContent = `SCRIPT:\n${script}\n\nSHOT LIST:\n${JSON.stringify(
    shots.map((s) => ({ id: s.id, scene: s.scene, description: s.description, motion: s.motion })),
    null,
    2,
  )}`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
      try {
        res = await attempt(config.llmModel);
      } catch {
        console.warn("⚠️  Script-content-invention check failed — skipping it for this render.");
        return { invented: false, shotIds: [], detail: "" };
      }
    } else {
      console.warn(`⚠️  Script-content-invention check failed (${(e as Error).message}) — skipping it for this render.`);
      return { invented: false, shotIds: [], detail: "" };
    }
  }
  logUsage("checkScriptContentInvention", config.repairModel, res.usage);

  try {
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    // Only trust ids that actually exist on the shot list handed in — an LLM
    // occasionally hallucinates an id, and a hallucinated id would otherwise
    // silently vanish from repairShots() (it filters to `startingById.has()`
    // already) while still counting toward `invented`, leaving the caller to
    // report a violation it can't actually target for repair.
    const validIds = new Set(shots.map((s) => s.id));
    const shotIds = Array.isArray(parsed.shotIds)
      ? parsed.shotIds.filter((id: unknown): id is string => typeof id === "string" && validIds.has(id))
      : [];
    return { invented: !!parsed.invented, shotIds, detail: typeof parsed.detail === "string" ? parsed.detail : "" };
  } catch {
    console.warn("   ⚠️  script-content-invention check returned unparseable JSON — skipping it for this render.");
    return { invented: false, shotIds: [], detail: "" };
  }
}

/** Regenerate a single shot as a fresh take that still fits the story + continuity. */
export async function regenerateShot(breakdown: Breakdown, index: number): Promise<Shot> {
  const shot = breakdown.shots[index];
  // Strip negativePrompt/method from EVERY shot before this goes into the prompt —
  // the model only needs them to understand the story/continuity, not to see the
  // ~400-token computed negative-prompt string repeated on all ~18 shots for
  // context it will never use, since the compiler overwrites both fields anyway.
  const context = {
    title: breakdown.title,
    characters: breakdown.characters,
    shots: breakdown.shots.map(stripComputedFields),
  };
  // NEW: same domain facts the plan was built with, so the fresh take stays on-domain.
  // breakdown.domainPack: reuse the domain already determined by
  // breakdownScript() instead of re-detecting it on every edit — see
  // buildAugmentedSystem()'s own comment for the real, measured cost this avoids.
  const { system } = await buildAugmentedSystem(JSON.stringify(context), breakdown.domainPack, breakdown.language);
  const userContent =
    `Here is the full shooting plan as JSON:\n${JSON.stringify(context)}\n\n` +
    `Rewrite ONLY shot at index ${index} (id "${shot.id}") as a fresh, meaningfully different take that still fits the story, the surrounding shots, and continuity. ` +
    `Keep the SAME "id". Obey every CAST, CAMERA and TWO-ENDPOINT rule. ` +
    `Do NOT include "negativePrompt" or "method" — the pipeline computes both automatically. ` +
    `Return ONLY that single shot as a JSON object with the same shape (id, scene, description, setting, characters, crowd, speaker, offscreenSpeaker, dialogue, camera, lighting, motion, characterActions, motionDirection, props, startFrame, endFrame, duration, screenSeconds).`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      // Omitted on a reasoning-tier model (rejects a custom temperature) —
      // "meaningfully different take" is carried in the instruction text below
      // instead, which those models still follow.
      ...(supportsTemperature(model) ? { temperature: 0.85 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    // Same reasoning as breakdownScript/repairShots: an access failure or a request
    // that exceeds this model's per-minute token ceiling will never succeed by retrying
    // identically, so fall back once to the cheaper default rather than failing outright.
    if ((isModelAccessError(e) || isRequestTooLargeError(e)) && config.repairModel !== config.llmModel) {
      console.warn(`⚠️  ${config.repairModel} could not process this regeneration (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      res = await attempt(config.llmModel);
    } else {
      throw e;
    }
  }
  logUsage("regenerateShot", config.repairModel, res.usage);
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  return ShotSchema.parse({ ...shot, ...parsed, id: shot.id });
}

/**
 * Write ONE brand-new shot to be spliced into an existing breakdown at
 * `insertIndex` (0 = before every existing shot; breakdown.shots.length =
 * after every existing shot). Sibling to regenerateShot() above, but that
 * function requires the shot to already exist and always keeps its id —
 * not usable for inserting a shot that has no id yet. Used by worker.ts's
 * handleInsertShot() for both "extend a finished film" and "add a shot
 * mid-review" (same mechanism, see that handler's own comment).
 */
export async function generateInsertedShot(breakdown: Breakdown, insertIndex: number, userPrompt: string): Promise<Shot> {
  const context = {
    title: breakdown.title,
    characters: breakdown.characters,
    shots: breakdown.shots.map(stripComputedFields),
  };
  const before = breakdown.shots[insertIndex - 1];
  const after = breakdown.shots[insertIndex];
  // breakdown.domainPack: reuse the domain already determined by
  // breakdownScript() instead of re-detecting it on every edit — see
  // buildAugmentedSystem()'s own comment for the real, measured cost this avoids.
  const { system } = await buildAugmentedSystem(JSON.stringify(context), breakdown.domainPack, breakdown.language);
  const userContent =
    `Here is the full shooting plan as JSON:\n${JSON.stringify(context)}\n\n` +
    `The user wants to INSERT a brand-new shot ${before ? `right after shot id "${before.id}"` : "at the very start of the film"}` +
    `${after ? `, right before shot id "${after.id}"` : ""}. What the user wants in this new shot: "${userPrompt}"\n\n` +
    `Write ONE new shot that fits naturally between its real neighbors (match their location/lighting/continuity unless the ` +
    `user's request clearly means a new scene). Obey every CAST, CAMERA and TWO-ENDPOINT rule. ` +
    `Only reference character ids that already exist in "characters" above — do NOT invent a new named character, ` +
    `there is no character sheet for one and the render will fail. If the user's request implies a person who isn't in ` +
    `the cast, describe them as an unnamed background figure instead (not in "characters"), never as a new named character. ` +
    `Do NOT include "id", "negativePrompt", or "method" — the pipeline assigns the id and computes the other two automatically. ` +
    `Return ONLY that single shot as a JSON object with this shape: (scene, description, setting, characters, crowd, speaker, ` +
    `offscreenSpeaker, dialogue, camera, lighting, motion, characterActions, motionDirection, props, startFrame, endFrame, duration, screenSeconds).`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.7 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isModelAccessError(e) || isRequestTooLargeError(e)) && config.repairModel !== config.llmModel) {
      console.warn(`⚠️  ${config.repairModel} could not process this insert (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      res = await attempt(config.llmModel);
    } else {
      throw e;
    }
  }
  logUsage("generateInsertedShot", config.repairModel, res.usage);
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  // Server assigns the id, same reasoning as regenerateShot() overriding it —
  // never trust the LLM for an identifier the rest of the pipeline keys on.
  const id = `insert-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return ShotSchema.parse({ ...parsed, id });
}

/**
 * Fields the LLM never needs to see or produce: negativePrompt is deterministically
 * recomputed by compileBreakdown()'s R8 on every recompile regardless of what comes
 * back here, and method is derived from whether endFrame is set. Sending them in
 * costs input tokens for nothing, and showing them to the model invites it to
 * dutifully echo them back, which costs the pricier output tokens for nothing.
 */
function stripComputedFields<T extends { negativePrompt?: string; method?: string }>(shot: T): Omit<T, "negativePrompt" | "method"> {
  const { negativePrompt, method, ...rest } = shot;
  return rest;
}

/**
 * REPAIR LOOP — the thing that makes this pipeline deterministic enough to ship.
 *
 * The LLM obeys the two-endpoint rule maybe half the time. That is a SAMPLING
 * problem, not a prompting one, and no amount of shouting in the system prompt
 * fixes it. So when the compiler REJECTS a shot, hand the rejection straight back
 * to the model and make it fix that shot specifically. One cheap LLM call instead
 * of a dead run.
 *
 * This is how a director works, too: you don't re-shoot the film because one setup
 * was wrong. You fix the setup.
 */
/**
 * Per-code repair guidance, keyed by CompileIssue code. WAS one giant static
 * REPAIR_RULES_TEXT string appended IN FULL to every repairShots() call
 * regardless of which code(s) were actually being repaired in that batch.
 * CONFIRMED REAL FAILURE: REFLECTION_NEEDS_COMPOSITION's own example text —
 * concrete, vivid, and ready to paste — got lifted verbatim into a shot being
 * repaired for a COMPLETELY UNRELATED code (a scene-bridging fix between a
 * bunker phone call and a bedroom), inventing a rearview-mirror shot with no
 * basis anywhere in the script. The rulebook entry itself wasn't wrong — it's
 * exactly the guidance a REFLECTION_NEEDS_COMPOSITION repair needs — the bug
 * was handing that entry to a repair that had nothing to do with reflections
 * at all, where its vivid example read less like "here's the pattern" and
 * more like "here's a sentence you can use." buildRepairRulesText() below
 * assembles only the entries for the codes actually present in the current
 * batch (plus the universal footer, which is genuinely code-agnostic), so a
 * repair never sees guidance — or example text — for a problem it doesn't have.
 */
const REPAIR_RULE_ENTRIES: Record<string, string> = {
  STATE_CHANGE_NEEDS_ENDFRAME: `- STATE_CHANGE_NEEDS_ENDFRAME — the beat changes the world, so it needs BOTH frames.
  Keep it as ONE shot. Fill in startFrame and endFrame with two photographs a camera
  could actually take, showing genuinely different world states. If the change is a
  CROSSING, startFrame is on the NEAR side facing the obstacle and endFrame is on the
  FAR side, back to it, moving away.`,
  CROSSING_NEEDS_TWO_SIDES: `- CROSSING_NEEDS_TWO_SIDES — the beat crosses an obstacle (vault/jump/climb OVER) but
  has only one frame, so it will render as bouncing in place instead of actually
  crossing. Keep it as ONE shot. startFrame is on the NEAR side, facing the obstacle,
  before crossing. endFrame is on the FAR side, back to the obstacle, already past it
  and moving away. Confirm the obstacle genuinely blocks the path (he runs INTO it and
  over it), not alongside it — if there's no real obstacle, cut the crossing language
  entirely and just describe him running.`,
  STATIC_STATE_BEAT: `- STATIC_STATE_BEAT — the beat is a STATE (hiding/waiting/lurking), and a camera films
  CHANGE. Convert it to a change with an entry and an exit ("presses flat against the
  wall, then breaks from cover and runs"), with startFrame and endFrame — or cut the
  beat and return a replacement shot that carries the story without it.`,
  KEYFRAME_MAYBE_NOT_PHOTOGRAPHABLE: `- KEYFRAME_MAYBE_NOT_PHOTOGRAPHABLE — a frame describes a mid-motion moment ("at the
  top of the arc", "mid-air", "shattering"). A still-image model cannot render that; it
  renders the nearest thing it CAN photograph, and the video model animates the nonsense.
  Rewrite it as a pose a photographer could shoot — a position a human body can hold.`,
  ENDPOINTS_MAYBE_TOO_SIMILAR: `- ENDPOINTS_MAYBE_TOO_SIMILAR — your two frames show nearly the same pose in nearly the
  same place. The model has no journey to make, so it will HOLD THE POSE to burn frames.
  Make endFrame a genuinely different position in space, body position, and world state.`,
  MOTION_TOO_THIN_FOR_NATURAL: `- MOTION_TOO_THIN_FOR_NATURAL — the motion is too vague and will render stiff and
  robotic. Rewrite "motion" MUCH richer: weight and force (how the body drives the
  movement), secondary motion (hair, jacket, breath, fabric), how the body settles
  after, and one piece of micro-behaviour (a glance, a swallow, fingers tensing).
  Describe the FACE in specific muscles (furrowed brow, tight jaw, darting eyes),
  never a bare label like "worried". Keep the same beat and duration.`,
  ACTION_DURATION_OFF_LIBRARY: `- ACTION_DURATION_OFF_LIBRARY — this shot's own duration is too rushed for the
  specific action it depicts (e.g. a kneel or a handoff given far less time than
  that action realistically needs to read as physically performed, not a jump
  cut). Increase "duration" (and screenSeconds if authored) to something inside
  the range the detail text states. Do not change what the motion describes —
  this is a timing fix, not a content rewrite.`,
  MOTION_TOO_DENSE_FOR_DURATION: `- MOTION_TOO_DENSE_FOR_DURATION — this shot describes more distinct action beats
  than its own duration can physically hold. CONFIRMED REAL, on two different video
  providers: when a shot asks for this much movement/direction-change inside one
  continuous take, the renderer does not slow down or skip beats gracefully — it
  invents an internal cut, a direction reversal (toward/away/toward), or a sudden
  mid-clip repositioning that reads as a broken render, not a deliberate choice.
  Two fixes, pick whichever actually fits: (1) TRIM to only the beats that fit the
  duration, dropping the least essential one(s), if nothing the story needs would be
  lost — same as MOTION_TOO_THIN_FOR_NATURAL's enrichment, just the opposite
  direction; or (2) if every beat is real story content, SPLIT into two shots at the
  natural midpoint — each half becomes its own simple, achievable single take, and
  the CUT BETWEEN THEM reads as an ordinary edit, not a glitch. Prefer (2) whenever
  trimming would drop something the story actually needs; this is an ADDED BEAT
  (like ACTION_NEVER_COMPLETES/NARRATIVE_GAP_NEEDS_TRANSITION below), not an
  awkward split of one clean, single action.`,
  SPATIAL_COMPLEXITY_OVERLOAD: `- SPATIAL_COMPLEXITY_OVERLOAD — this shot packs 2+ DIFFERENT KINDS of spatial
  change into one beat (e.g. a character entering the scene AND someone
  repositioning relative to another person). CONFIRMED REAL, on two different
  video providers: a shot asking for this many simultaneous spatial events
  does not render as one coherent take — it skips straight to an end state
  with no shown transition, since there was never a single clean event for
  the take to depict. Return TWO shots for this one: the FIRST event
  completing on its own (e.g. the entrance, ending with that character
  settled in frame), then the SECOND event as its own beat (e.g. the
  reposition, starting from where the first shot left off). This is an ADDED
  BEAT (like ACTION_NEVER_COMPLETES/NARRATIVE_GAP_NEEDS_TRANSITION below,
  and MOTION_TOO_DENSE_FOR_DURATION above), not an awkward split of one
  clean, single event.`,
  MISSING_OFFSCREEN_SOUND_CUE: `- MISSING_OFFSCREEN_SOUND_CUE — this shot describes a character reacting to
  what reads as an off-screen sound (a shout, a crash, a horn, sirens) but
  nothing tells the video model to actually render that sound — audio here
  comes entirely from this same text prompt, so an implied-but-unstated
  sound renders as silence. Add an explicit "AUDIO: ..." clause naming the
  sound plainly (e.g. "AUDIO: a sharp shout rings out from off-screen,
  urgent and close") — same convention already used elsewhere in this
  pipeline for an off-screen voice. Keep the same beat and duration; this is
  an enrichment of the existing shot, never a split or an added beat.`,
  ACTION_NEVER_COMPLETES: `- ACTION_NEVER_COMPLETES — something is given/offered/held out and nobody is ever
  shown taking it. Return TWO shots for this one: the offer, then the COMPLETION
  (the other person's hand closing on it, and them now holding it). This is an
  ADDED BEAT, not a split action — the completion is its own moment in the story.`,
  NARRATIVE_GAP_NEEDS_TRANSITION: `- NARRATIVE_GAP_NEEDS_TRANSITION — the location changes with no shot showing the
  move, so the character teleports. Return TWO shots: the bridging beat first
  (approaching the doorway / stepping through / leaving the space) and then the
  original shot. Again this is an ADDED BEAT that was missing, not a split.`,
  POINTLESS_BUSINESS: `- POINTLESS_BUSINESS — the shot performs an action and undoes it, so nothing has
  changed by the end. Rewrite it so the action LEADS SOMEWHERE (he opens the door
  AND STEPS THROUGH, ending inside), or replace the beat entirely with one that
  moves the story forward.`,
  THRESHOLD_NOT_CROSSED: `- THRESHOLD_NOT_CROSSED — a door/entrance is in the beat but he never passes
  through. Rewrite so the shot ENDS WITH HIM ON THE OTHER SIDE: startFrame at the
  door on the near side, endFrame clearly inside (or outside), moving on.`,
  CHARACTER_APPEARS_UNINTRODUCED: `- CHARACTER_APPEARS_UNINTRODUCED — this person shows up for the first time with
  nothing establishing them. Either WIDEN this shot so the viewer sees them in the
  space (the shopkeeper standing behind their counter, shelves behind them), or
  return TWO shots with an establishing beat first. Never introduce someone in a
  close-up.`,
  REFLECTION_NEEDS_COMPOSITION: `- REFLECTION_NEEDS_COMPOSITION — the shot involves a mirror, monitor, screen or
  reflection but never says WHAT FILLS THE FRAME. Rewrite the description to lead
  with the surface itself, then describe what is INSIDE the glass as its own
  picture (using only people/objects already established elsewhere in this exact
  shot list — never a new person, object, or vehicle this breakdown hasn't already
  placed in the story), then what little of the real space remains visible. If a
  person's reaction also matters, that is a separate shot.`,
  SPEAKER_UNKNOWN_CHARACTER: `- SPEAKER_UNKNOWN_CHARACTER — "speaker" is set to an id that doesn't match anyone in the
  cast (a typo, or a name that was never added as a character). Fix "speaker" to the
  correct existing character id who plausibly says this line in context. If no cast
  member plausibly says it, either set "speaker" to null and "offscreenSpeaker": true
  (a genuine off-screen/unseen voice), or clear "dialogue" to "" if the line doesn't
  belong in this shot at all.`,
  DIALOGUE_WITH_NO_SPEAKER: `- DIALOGUE_WITH_NO_SPEAKER — "dialogue" has real text but "speaker" is null and
  "offscreenSpeaker" is false, so this line would never reach the render prompt and
  would silently never be heard. Pick the ONE fix that fits the story: (1) set
  "speaker" to whichever character in this shot's "characters" plausibly says it, or
  (2) if the character isn't in this shot's cast yet but genuinely should be, ADD their
  id to "characters" AND set "speaker" to them, or (3) if it's meant to be heard but
  not seen, set "speaker" to the correct character id and "offscreenSpeaker": true, or
  (4) if the line doesn't actually belong in this shot, clear "dialogue" to "".`,
  SCREEN_INSERT_OVERUSE: `- SCREEN_INSERT_OVERUSE — this is the 3rd+ shot in a row dominated by the same
  reused surface (monitor/mirror/screen) filling the frame. Rewrite THIS shot to
  be about the characters instead: their faces, their reaction, their bodies in
  the room. Keep the same story beat and dialogue if any — just change the
  camera/composition away from the surface, to a shot of the people responding to
  it. Do not simply reword the same screen-insert composition.`,
  DUPLICATE_DIALOGUE_ADJACENT: `- DUPLICATE_DIALOGUE_ADJACENT — this shot's "dialogue" repeats the previous shot's
  line almost word-for-word. Rewrite this shot's "dialogue" to be the NEXT line the
  character would plausibly say (advance the thought — do not just restate it), or
  set "dialogue" to an empty string and make this a silent reaction/listening beat
  instead. Keep everything else about the shot (camera, framing) as close to the
  original intent as possible.`,
  REDUNDANT_CROSSING: `- REDUNDANT_CROSSING — this shot and the one before it both describe crossing the
  SAME obstacle (a corner, archway, doorway, wall), re-running ground already covered.
  Rewrite this shot to start from where the PREVIOUS crossing actually ended (further
  along the chase, not back at the obstacle) and advance to NEW ground — a different
  obstacle, a new stretch of the space, or a beat that doesn't repeat the crossing.`,
  REDUNDANT_SCREEN_INSERT: `- REDUNDANT_SCREEN_INSERT — this shot restages the same reflective-surface composition
  (a mirror, window, or door glass showing the same people) as an earlier shot, with a
  different shot possibly sandwiched between them. Check whether a character's state
  (inside/outside, before/after a threshold) has moved on since the earlier shot — if
  so, this shot must show THAT later state, not repeat the earlier one. Either cut this
  shot entirely, or rewrite it to depict the next moment in the scene.`,
  FLAT_GENERIC_WIDE_FRAMING: `- FLAT_GENERIC_WIDE_FRAMING — the "camera" is a wide shot with no movement and no
  stated compositional choice, the generic default a real cinematographer avoids.
  Rewrite "camera" to add EXACTLY ONE deliberate choice, whichever best fits this
  beat: an angle (low angle looking up, high angle looking down, a slight dutch
  tilt), a foreground element ("shot through the market stalls in the foreground",
  "framed through a doorway"), an off-center subject placement, OR a motivated
  camera movement (a slow push in, a tracking move, a slight pan). Do not just add
  the word "cinematic" — the fix is a SPECIFIC, concrete choice the render can
  actually see. If a plain static wide genuinely is the right call for this exact
  beat (a calm, deliberate establishing shot), say so in the framing itself with a
  reason ("static wide, holding on the empty street before he enters") rather than
  leaving it bare — the rejection is about an UNEXAMINED default, not about static
  wides being forbidden.`,
  MISSING_HANDOFF_SHOT: `- MISSING_HANDOFF_SHOT — a previous shot's own end-state asserts an object just changed
  hands (or a character now possesses something tracked as belonging to someone else),
  but no shot anywhere actually shows the exchange — no hand giving, no hand receiving.
  Return TWO shots for this one: the ORIGINAL shot UNCHANGED, plus a NEW shot inserted
  immediately before it that actually depicts the transfer (one character's hand giving
  or extending the object, the other's hand closing around it or receiving it). This is
  an ADDED BEAT that the script implied but the breakdown skipped, not a split of the
  original shot's own action.`,
  SCRIPT_DIALOGUE_LINE_DROPPED: `- SCRIPT_DIALOGUE_LINE_DROPPED — the ORIGINAL SCRIPT contains a line of dialogue (quoted
  in the rejection detail) that does not appear, verbatim or close to it, in any shot's
  "dialogue" field anywhere in the breakdown. This is lost content, not a rendering
  choice — every line of dialogue the script actually wrote must be SPOKEN by someone in
  some shot, not paraphrased away as a physical description ("mouth open in a shout")
  and not silently dropped. Fix it one of two ways, whichever fits the story: (1) if this
  shot is plausibly where that line belongs, set this shot's "dialogue" to the missing
  line (adjusting "speaker"/"offscreenSpeaker" to match who says it) and return this ONE
  shot; or (2) if the line belongs to a genuinely separate moment this shot doesn't cover,
  return the ORIGINAL shot UNCHANGED plus a NEW shot that actually depicts that moment,
  with "dialogue" set to the missing line. Never invent a DIFFERENT line as a substitute
  for the one that was dropped — use the exact line quoted in the rejection detail.`,
  SOLO_SHOT_IMPLIES_SECOND_BODY: `- SOLO_SHOT_IMPLIES_SECOND_BODY — this shot is locked to its current cast (one or zero
  people), but its own text describes a SECOND person's body part acting (e.g. "the
  vendor's hand reaches out") — a direct contradiction with the shot's own "ONLY person
  in this frame" render instruction. Pick the ONE fix that fits the story: (1) if that
  role genuinely shares the frame, add them as a real character to this shot's
  "characters" array, or (2) rewrite the text so no second body is implied at all — the
  action happens off-frame, or is described from this shot's ONE character's own
  perspective instead ("reaches for the object" rather than "the vendor's hand reaches
  out").`,
  CONTENT_INVENTION_NOT_IN_SCRIPT: `- CONTENT_INVENTION_NOT_IN_SCRIPT — this shot depicts an action, object, location,
  or surface (e.g. a mirror/monitor reflection) that the ORIGINAL SCRIPT does not
  actually describe or clearly imply — flagged by a separate script-fidelity check,
  not the compiler. Rewrite it to depict what the script actually describes at this
  point in the story instead, using only what the script itself provides (action,
  dialogue, staging) for this beat. Do not substitute a different invented scene —
  go back to what this exact moment in the SCRIPT says happens. Keep it as ONE shot.`,
  TIME_OF_DAY_JUMP_NO_SKIP: `- TIME_OF_DAY_JUMP_NO_SKIP — this shot's lighting reads as a different time of day
  than the shot before it, with nothing showing time passing. Pick the ONE fix that
  fits the story: (1) change "lighting" so it reads as the SAME time of day as the
  previous shot (no time actually passed), or (2) if the story genuinely needs the
  jump, return TWO shots: a NEW bridging shot first that shows the time passing
  PURELY VISUALLY (changing light, a sunset/sunrise, a clock, characters settling in
  for the night/waking up) — NEVER put a narration line like "later that night" into
  "dialogue"; that field is for a CHARACTER speaking out loud and requires "speaker"
  or "offscreenSpeaker", which a scene-setting caption has neither of — then the
  original shot, unchanged, second. This is an ADDED BEAT, not a split of the
  original shot's own action.`,
};

const REPAIR_RULES_HEADER = `RULES FOR THE FIX:`;

const REPAIR_RULES_FOOTER = `- Any other rejection — obey the reason literally.

NEVER split ONE PHYSICAL ACTION across two shots (a vault is one shot with two
frames). But DO add a missing STORY BEAT as its own shot when the chain has a
hole in it — a bridging move or a completing gesture is a separate beat, not a
split action.
Keep every OTHER field faithful to the original: same id, setting, lighting, dialogue,
offscreenSpeaker, crowd. Preserve the story beat.
"characters" is DELIBERATELY EXCLUDED from that faithful-to-the-original list: several
rejection reasons above (CULLED_CHARACTER_STILL_IN_PROSE, SPEAKER_BODY_MISMATCH,
CAMERA_REQUIRES_TWO_BODIES) exist specifically because "characters" needs to change to
match what the shot's own text actually depicts — a bug was confirmed where this exact
"keep characters faithful" wording caused the model to leave a character's id out of
"characters" for two repair rounds in a row even though the code's own guidance said to
add it. If the rejection reason above tells you to change "characters", change it.

When a fix needs an ADDED beat (ACTION_NEVER_COMPLETES, NARRATIVE_GAP_NEEDS_TRANSITION),
return BOTH shots in the "shots" array, in story order. Give the new shot a distinct
id (e.g. the original id with "a"/"b" appended). For every other fix, return exactly
one shot with the SAME id.

PATCH, DON'T RETYPE — CRITICAL FOR SPEED: when returning a shot that keeps the SAME id
as the one being fixed (i.e. NOT a newly added beat), return ONLY the field(s) you
actually changed, never the whole shot object. The pipeline merges whatever you return
onto the ORIGINAL shot automatically — any field you omit keeps its exact original
value, untouched. Example: if MOTION_TOO_THIN_FOR_NATURAL only requires enriching
"motion", return {"originalId": "shot4", "shots": [{"motion": "<the richer text>"}]}
— NOT the full shot with "description"/"camera"/"setting"/etc re-typed unchanged. Most
fixes above touch only ONE OR TWO fields (motion, camera, startFrame, endFrame,
dialogue, speaker, characters) — re-sending every other field costs real time on every
single repair for no reason, since the original is already correct. The ONLY case that
needs a FULL shot object is a genuinely NEW shot for an added beat (no original to
merge onto) — that one has no id yet, so there's nothing to omit from it.

Do NOT include "negativePrompt" or "method" in the shots you return — the pipeline
computes both automatically afterward, and any value you write for them is discarded.

Return ONLY this JSON:
{ "replacements": [ { "originalId": "<the rejected shot id>", "shots": [ <one or more shot objects/patches, in order> ] } ] }`;

function buildRepairRulesText(codes: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [REPAIR_RULES_HEADER];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const entry = REPAIR_RULE_ENTRIES[code];
    if (entry) parts.push(entry);
  }
  parts.push(REPAIR_RULES_FOOTER);
  return parts.join("\n\n");
}

export async function repairShots(
  breakdown: Breakdown,
  problems: { shotId: string; code: string; detail: string }[],
): Promise<Breakdown> {
  const startingById = new Map(breakdown.shots.map((s, i) => [s.id, i]));
  const targets = problems.filter((p) => startingById.has(p.shotId));
  if (!targets.length) return breakdown;

  // NEW: repairs carry the same domain facts as the original plan.
  const context = { title: breakdown.title, characters: breakdown.characters, shots: breakdown.shots };
  // breakdown.domainPack: reuse the domain already determined by
  // breakdownScript() instead of re-detecting it on every edit — see
  // buildAugmentedSystem()'s own comment for the real, measured cost this avoids.
  const { system } = await buildAugmentedSystem(JSON.stringify(context), breakdown.domainPack, breakdown.language);
  // CONFIRMED REAL GAP, FIXED: a shot with TWO simultaneous problems (e.g. a
  // STATE_CHANGE_NEEDS_ENDFRAME blocker plus a WORLD_STATE_ACTION_CONTRADICTION
  // warn on the same shot) produced TWO entries in `targets` with the same
  // shotId — building this as `Map(targets.map(p => [p.shotId, p.code]))`
  // silently overwrote the first with the second, so the anti-split check
  // below only ever saw the LAST of the shot's codes, never the others. Now
  // keyed on every code that applies to a shot, so the split is allowed if
  // ANY of them legitimately needs one (MAY_ADD_SHOTS), not just whichever
  // happened to be inserted last.
  const codesFor = new Map<string, string[]>();
  for (const p of targets) {
    const arr = codesFor.get(p.shotId);
    if (arr) arr.push(p.code);
    else codesFor.set(p.shotId, [p.code]);
  }

  // WHICH REJECTIONS ARE ALLOWED TO ADD A SHOT.
  // A missing bridge or a missing completion legitimately needs a new beat. But
  // a two-endpoint problem must NEVER be answered by splitting one action across
  // two shots — that is the exact failure RULE 3 exists to prevent, and it
  // produced a man "stepping out from behind the pillar" in one shot and
  // "having stepped out from behind the pillar" in the next, with his hands
  // contradicting between them. For those codes we keep only the first shot.
  //
  // CONFIRMED REAL FAILURE, visually verified on a real render: POINTLESS_BUSINESS
  // and THRESHOLD_NOT_CROSSED were missing from this set, so every real fix the
  // repair model proposed for them (correctly, as a second shot showing the action
  // actually complete/the character actually cross the threshold) was silently
  // discarded down to one shot every time — the only "fix" ever allowed to survive
  // was rewording the SAME static, nothing-happens moment. Three consecutive shots
  // of a character reaching for a door handle with no one ever going through it was
  // the direct, reproduced result. Unlike the two-endpoint RULE 3 case above, these
  // two are never about splitting one continuous action awkwardly — they are about
  // an action that structurally cannot complete inside its own single shot at all,
  // so a genuine second shot is the only real fix available.
  //
  // MISSING_HANDOFF_SHOT is the same shape of problem, same missing-allowlist gap:
  // its own detail text says it outright — "neither shot ever actually DEPICTS the
  // transfer... compressed into a continuity assertion instead of getting its own
  // [shot]." A coins-for-package exchange skipped entirely between two shots (found
  // auditing a real render's shop scene) is exactly this failure. Not verified with
  // a firing synthetic repro this time (the detection regex's exact trigger phrasing
  // proved fiddly to reproduce standalone) — added on the strength of its own detail
  // text describing the identical shape of bug already confirmed twice above.
  // MOTION_TOO_DENSE_FOR_DURATION added on the strength of the E_new.docx audit's
  // "sudden transition"/"direction flip-flops" cluster (Test 3/4) plus the
  // independent Kling test PDF showing the identical failure shape on a SECOND
  // video provider — this is not a Seedance quirk. Same allowlist reasoning as
  // THRESHOLD_NOT_CROSSED/POINTLESS_BUSINESS above: the fix this code actually
  // needs (a genuine second shot, not a reworded single one) was structurally
  // unavailable to the repair model until this code was added here.
  //
  // CHARACTER_APPEARS_UNINTRODUCED added for the SAME reason, found the SAME
  // way (an allowlist gap, not a detection gap) — this code's own guidance two
  // entries below offers "return TWO shots with an establishing beat first" as
  // one of its two valid fixes, but was missing from this set, so that half of
  // its own advertised fix was silently discarded down to one shot every time,
  // exactly like POINTLESS_BUSINESS/THRESHOLD_NOT_CROSSED were before they were
  // added here. Targets "a character/extra appears with no lead-in" (E_new.docx
  // Test 3 #6/#13).
  // SCRIPT_DIALOGUE_LINE_DROPPED belongs here because its own issue text
  // explicitly offers the repair two ways out: put the missing line into the
  // shot that depicts that moment, "or add a new shot for it if no existing
  // shot covers this moment at all." Without membership here, that second
  // option was silently impossible — the repair's extra shot was truncated away
  // by the anti-split guard below, so a dropped line with nowhere to live could
  // never actually be restored. Repairable (REPAIRABLE_WARN_CODES) and
  // allowed-to-add have to agree for that instruction to mean anything.
  //
  // TIME_OF_DAY_JUMP_NO_SKIP — SAME missing-allowlist gap, CONFIRMED REAL on a
  // real render: its own detail text offers two fixes, "add an explicit
  // time-skip beat ... bridging the two, OR make this shot's lighting
  // consistent with the one before it" — the first option genuinely needs a
  // second shot, same as every other code in this set. Without membership
  // here, the repair model's legitimate two-shot answer was truncated down to
  // ONE by the anti-split guard below, which (before that guard's own fix,
  // see its comment) kept whichever shot happened to be listed first — in
  // the reproduced failure, the model's own invented bridging shot, discarding
  // the actual fixed shot and shipping a dialogue-only stub with no speaker.
  const MAY_ADD_SHOTS = new Set(["ACTION_NEVER_COMPLETES", "NARRATIVE_GAP_NEEDS_TRANSITION", "POINTLESS_BUSINESS", "THRESHOLD_NOT_CROSSED", "MISSING_HANDOFF_SHOT", "MOTION_TOO_DENSE_FOR_DURATION", "CHARACTER_APPEARS_UNINTRODUCED", "SPATIAL_COMPLEXITY_OVERLOAD", "SCRIPT_DIALOGUE_LINE_DROPPED", "TIME_OF_DAY_JUMP_NO_SKIP"]);

  const buildBrief = (batch: typeof targets, shots: Shot[]): string => {
    const byId = new Map(shots.map((s, i) => [s.id, i]));
    return batch
      .map((p) => {
        const idx = byId.get(p.shotId);
        if (idx === undefined) return "";
        const shot = stripComputedFields(shots[idx]);
        return `SHOT "${p.shotId}" WAS REJECTED.\nReason (${p.code}): ${p.detail}\nThe rejected shot:\n${JSON.stringify(shot, null, 2)}`;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  };

  // REPAIR is a different job than BREAKDOWN: mechanical fixes against an explicit
  // rulebook, applied to a small already-flagged subset of shots -- not open-ended
  // story planning. config.repairModel defaults to config.breakdownModel (no
  // behaviour change until REPAIR_MODEL is set), but this is where a cheaper/faster
  // model is safe to point at: the compiler re-validates every repaired shot
  // afterward, so a bad repair is caught on recompile, not shipped silently.
  const attempt = async (model: string, userContent: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.2 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  const applyReplacements = (
    shots: Shot[],
    replacements: { originalId: string; shots: unknown[] }[],
  ): Shot[] => {
    const out = [...shots];
    for (const rep of replacements) {
      const at = out.findIndex((s) => s.id === rep.originalId);
      if (at < 0 || !Array.isArray(rep.shots) || !rep.shots.length) continue;

      const codes = codesFor.get(rep.originalId) ?? [];
      if (rep.shots.length > 1 && !codes.some((c) => MAY_ADD_SHOTS.has(c))) {
        // WHICH of the illegitimate extra shots to keep. CONFIRMED REAL FAILURE:
        // this used to blindly keep rep.shots[0], assuming the model always lists
        // the kept/fixed shot first — but a real TIME_OF_DAY_JUMP_NO_SKIP repair
        // put its OWN invented bridging stub first and the actual fixed shot
        // second; slice(0, 1) then discarded the real fix and shipped a
        // dialogue-only stub with no speaker (DIALOGUE_WITH_NO_SPEAKER),
        // permanently failing the render over a problem this guard itself
        // created. A shot the model tagged with NO id, or with an id matching
        // the original, is the one it considers "the original, fixed in place"
        // (see PATCH, DON'T RETYPE's own contract: an omitted field, id
        // included, means unchanged) — a shot tagged with a NEW, different id
        // is one the model itself considers a distinct addition, exactly what
        // this guard exists to reject. Prefer the former; only fall back to
        // position 0 if nothing qualifies.
        const originalShot = rep.shots.find((s: any) => !s?.id || s.id === rep.originalId);
        console.log(`   ↺ ${rep.originalId}: ${codes.join("+") || "?"} came back as ${rep.shots.length} shots — kept the one representing the original (an action must not be split across cuts).`);
        rep.shots = [originalShot ?? rep.shots[0]];
      }

      const base = out[at];
      // id DEFAULTS TO base.id (unchanged) for a lone returned shot — CONFIRMED
      // REAL: the old fallback (`${base.id}${String.fromCharCode(97 + i)}`
      // unconditionally, i.e. always "a" for a single-shot array) renamed
      // shot1 -> shot1a -> shot1aa -> ... every single repair round even for
      // an ordinary one-shot patch with no split at all, contradicting PATCH,
      // DON'T RETYPE's own stated contract that an omitted field (id included)
      // stays "exact original value, untouched." The letter-suffix scheme is
      // still needed, and still applied, for a GENUINE multi-shot array (an
      // actual added-beat split, where the new shot(s) need distinct ids).
      const fixed = rep.shots.map((raw: any, i) =>
        ShotSchema.parse({
          ...base,
          ...raw,
          id: raw?.id || (rep.shots.length > 1 ? `${base.id}${String.fromCharCode(97 + i)}` : base.id),
        }),
      );
      console.log(`   🔧 repaired ${rep.originalId} → ${fixed.map((f) => f.id).join(" + ")}`);
      out.splice(at, 1, ...fixed);
    }
    return out;
  };

  /**
   * Runs ONE repair request for `batch`. If the estimated size would exceed the
   * account's per-minute token ceiling -- or the API confirms it with an actual
   * "Request too large" 429 -- splits the batch in half and runs each half in turn
   * instead of retrying the same oversized request (which would 429 identically
   * forever). Batches are processed SEQUENTIALLY so each one sees the previous
   * batch's repairs already applied, matching the original single-call behaviour.
   */
  const runBatch = async (shots: Shot[], batch: typeof targets): Promise<Shot[]> => {
    if (!batch.length) return shots;

    const brief = buildBrief(batch, shots);
    const userContent = `The render pipeline REJECTED the following shot(s). Fix them. Nothing else.

${brief}

${buildRepairRulesText(batch.map((p) => p.code))}`;

    const splitAndRun = async (): Promise<Shot[]> => {
      const mid = Math.ceil(batch.length / 2);
      const afterFirst = await runBatch(shots, batch.slice(0, mid));
      return runBatch(afterFirst, batch.slice(mid));
    };

    if (batch.length > 1 && estimateTokens(system) + estimateTokens(userContent) > config.repairMaxInputTokens) {
      return splitAndRun();
    }

    let res;
    try {
      res = await attempt(config.repairModel, userContent);
    } catch (e) {
      if (isRequestTooLargeError(e) && batch.length > 1) {
        console.warn(
          `   ✂️  repair batch of ${batch.length} shot(s) was too large for ${config.repairModel}'s per-minute ` +
          `token budget — splitting in half and retrying instead of resending the same request.`,
        );
        return splitAndRun();
      }
      if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
        console.warn(`⚠️  ${config.repairModel} could not process this repair (${(e as Error).message}). Falling back to ${config.llmModel}.`);
        res = await attempt(config.llmModel, userContent);
      } else {
        throw e;
      }
    }
    logUsage("repairShots", config.repairModel, res.usage);

    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    const replacements: { originalId: string; shots: unknown[] }[] = parsed.replacements ?? [];
    return applyReplacements(shots, replacements);
  };

  const shots = await runBatch(breakdown.shots, targets);
  return { ...breakdown, shots };
}

/**
 * Fixes CHARACTER-level rejections (APPEARANCE_MISSING_SEX_AGE_PREFIX,
 * APPEARANCE_MISSING_FACIAL_HAIR) — the compiler's R0.6 pushes these with
 * shotId "—" because they aren't about any one shot, they're about a
 * character's `appearance` string itself. Confirmed real gap: repairShots()
 * above filters `problems` by `startingById.has(p.shotId)`, built from
 * `breakdown.shots` — a shotId of "—" is never in that map, so it was
 * SILENTLY DROPPED every round. Both codes are blocking with no autofix, so
 * any script that ever tripped one had zero repair path and would burn
 * through MAX_REPAIRS rounds "fixing" other shots while these two sat
 * untouched, then permanently fail every single time, unconditionally. This
 * is the character-list sibling of repairShots(), editing
 * `breakdown.characters` instead of `breakdown.shots`.
 */
export async function repairCharacters(
  breakdown: Breakdown,
  problems: { shotId: string; code: string; detail: string }[],
): Promise<Breakdown> {
  const targets = problems.filter((p) => p.shotId === "—");
  if (!targets.length) return breakdown;

  const brief = targets.map((p) => `${p.code}: ${p.detail}`).join("\n\n");
  const userContent = `The render pipeline REJECTED the following character appearance description(s). Fix them. Nothing else.

CAST:
${JSON.stringify(breakdown.characters.map((c) => ({ id: c.id, name: c.name, appearance: c.appearance })), null, 2)}

REJECTIONS:
${brief}

Return ONLY this JSON, one entry per character whose "appearance" needed a fix:
{ "characters": [ { "id": "<character id>", "appearance": "<corrected appearance text>" } ] }

Rules for the corrected "appearance":
- The OPENING clause must state sex and age explicitly ("A woman in her early 30s...",
  "A man in his 40s..." — not just an age, not just clothing).
- The full text must state an explicit facial-hair condition ("clean-shaven with no
  beard and no stubble", "short trimmed beard", etc.) — for a woman this is still a
  "no facial hair" style statement, not simply omitted.
- Preserve every other authored detail (build, clothing, distinguishing features)
  exactly — only ADD or FIX the sex/age/facial-hair clauses, don't rewrite the rest.
- Do not include "id"/"name"/"voice" changes — only "appearance" is read back.`;

  const res = await client.chat.completions.create({
    model: config.repairModel,
    ...(supportsTemperature(config.repairModel) ? { temperature: 0.2 } : {}),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a continuity director fixing character appearance descriptions so they render as the correct sex/age with a consistent, explicit facial-hair state across every shot." },
      { role: "user", content: userContent },
    ],
  });
  logUsage("repairCharacters", config.repairModel, res.usage);

  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  const fixes: { id?: string; appearance?: string }[] = parsed.characters ?? [];
  const byId = new Map(fixes.filter((f): f is { id: string; appearance: string } => !!f.id && !!f.appearance).map((f) => [f.id, f.appearance]));

  const characters = breakdown.characters.map((c) =>
    byId.has(c.id) ? CharacterSchema.parse({ ...c, appearance: byId.get(c.id) }) : c,
  );
  return { ...breakdown, characters };
}

/**
 * DIRECTOR'S READ-THROUGH — a different job than repairShots() above.
 *
 * repairShots() fixes shots the COMPILER already flagged against a specific,
 * enumerable rule. That leaves a real gap: a sequence where every individual
 * shot is compiler-clean but the FILM, watched in order, still doesn't hold
 * together — an action with no motivation, a beat that pads the count instead
 * of earning its place, blocking that's internally consistent shot-to-shot but
 * doesn't add up as one continuous space. A regex over one shot's text at a
 * time cannot see that; only something reading the whole sequence can.
 *
 * Runs ONCE, after the compile→repair loop has already produced a blocker-free
 * shot list — this is a QUALITY pass on top of a VALID one, never a substitute
 * for it. NON-ADDITIVE ON PURPOSE: every replacement is exactly one shot for
 * one shot (never more), so this pass can only revise what's there, never grow
 * the film — see repairShots()'s own MAY_ADD_SHOTS comment for the exact
 * runaway-shot-count failure that discipline exists to prevent. The caller
 * (runBreakdown) recompiles afterward, so anything this pass touches is
 * re-validated exactly like a fresh LLM shot would be.
 */
export async function directorReadThrough(breakdown: Breakdown): Promise<Breakdown> {
  const context = {
    title: breakdown.title,
    characters: breakdown.characters,
    shots: breakdown.shots.map(stripComputedFields),
    // See CharacterSceneStateSchema's own comment (types.ts) and this file's
    // own "CHARACTER PSYCHOLOGY" system-prompt section — populated once by
    // breakdownScript(), empty for any breakdown compiled before this field
    // existed. Included here so the psychology-contradiction check below has
    // something concrete to grade against; omitted entirely (not an empty
    // array) when there's nothing to check, so the prompt doesn't ask the
    // model to judge against data that was never actually captured.
    ...(breakdown.characterSceneStates.length ? { characterSceneStates: breakdown.characterSceneStates } : {}),
  };
  // breakdown.domainPack: reuse the domain already determined by
  // breakdownScript() instead of re-detecting it on every edit — see
  // buildAugmentedSystem()'s own comment for the real, measured cost this avoids.
  const { system } = await buildAugmentedSystem(JSON.stringify(context), breakdown.domainPack, breakdown.language);

  const psychologyBullet = breakdown.characterSceneStates.length
    ? `\n- PSYCHOLOGY CONTRADICTION, JUDGED AGAINST "characterSceneStates" ABOVE, NOT AGAINST YOUR OWN READING OF THE PROSE: for each shot, check every character present against their STATED objective/emotionalStateEntering/emotionalStateExiting/relationshipStance for that shot's "scene". Flag it when the shot's own description/motion/dialogue shows that character behaving in a way the STRUCTURED FIELD directly contradicts — not "does this feel a bit off," but a real, specific contradiction (the field says "guarded, anxious" and the shot shows them relaxed and joking with no beat bridging the change; the field says their objective is to get Farid to trust him and the shot shows him being needlessly hostile with nothing motivating it; the field says one character is wary of another and the shot shows warm familiarity with no earned reason). A character's state CAN legitimately change mid-scene — that is what "emotionalStateExiting" is for — so only flag a genuine, unexplained contradiction, not a natural arc the fields themselves already describe. IF YOU FLAG ONE OF THESE, YOUR REPLACEMENT SHOT MUST REWRITE THE CONTRADICTORY PART — the visible behavior in "description"/"motion"/"dialogue" that clashed with the stated state has to actually change to something consistent with it (e.g. "steps out confidently, laughing" for a character stated as terrified and hiding becomes something like "presses back against the wall, breath held, peering out"). Copying the original text back unchanged is not a fix and will be discarded.`
    : "";

  const userContent = `Here is the complete, already-valid shooting plan for "${breakdown.title}" as JSON — every individual shot has already passed the rulebook. Read it once, start to finish, as if you were watching the assembled film, not reviewing an array:

${JSON.stringify(context, null, 2)}

The bar is not "technically valid" — it is "a viewer feels a real human performed this, filmed by a real production." Look for problems a per-shot rule check cannot see:
- An action with no visible motivation — someone doing something because the shot list needed a shot there, not because the story does.
- Blocking or geography that's internally fine per shot but doesn't add up across the sequence — a path, a distance, a timing that a real person could not actually cover the way these shots imply.
- Pacing that drags (multiple shots doing the same beat with nothing new) or rushes (an emotional beat with no room to land).
- A physical sequence that's individually plausible shot-by-shot but, watched in order, no real human body could perform as one continuous, natural flow of action — including a shot whose OWN duration doesn't leave the described action enough real time to complete naturally (see COMPLETION IS NOT OPTIONAL above).
- Camera work that's mechanically varied (per the rulebook) but not actually DIRECTED — an angle, movement, or distance that doesn't match what the beat is doing emotionally. Judge every shot's "camera" against the CINEMATOGRAPHY section above: is a confrontation using angle to show power? Does a reveal get a push-in instead of a flat cut? Is a tense beat held still instead of drifting? Is handheld reserved for actual chaos? A sequence that's cinematographically flat — every shot the same neutral eye-level medium-ish framing regardless of what's happening emotionally — is exactly the kind of problem this pass exists to catch.${psychologyBullet}

Do NOT re-flag anything already covered by an explicit rule (two endpoints, object permanence, cast/wardrobe consistency, and so on) — assume those already passed. Do NOT rewrite dialogue, invent new characters, or change the story. Do NOT add shots — if a gap needs a whole new beat, leave it for a human to review rather than inventing one here.

If the film genuinely holds together, return exactly: {"approved": true}

If you find real problems, return ONLY the shots that need to change, each REPLACED one-for-one (never split into more than one shot). The replacement "shot" object MUST actually resolve the specific problem you identified — change whatever field (description, motion, camera, dialogue) the problem lives in. Returning the SAME shot back unchanged is never a valid replacement: if you cannot find a real fix, that means the problem was not real, so leave the shot out of "replacements" and approve the film instead.
{"approved": false, "replacements": [{"originalId": "<shot id>", "shot": <the single revised shot object, same id, same shape as above>}]}`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
      console.warn(`⚠️  ${config.repairModel} could not process the director's read-through (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      res = await attempt(config.llmModel);
    } else {
      console.warn(`⚠️  Director's read-through failed (${(e as Error).message}) — skipping it for this render, the compiler-validated plan stands as-is.`);
      return breakdown;
    }
  }
  logUsage("directorReadThrough", config.repairModel, res.usage);

  let parsed: { approved?: boolean; replacements?: { originalId: string; shot: unknown }[] };
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    console.warn("   ⚠️  director's read-through returned unparseable JSON — skipping it for this render.");
    return breakdown;
  }

  const replacements = parsed.replacements ?? [];
  if (parsed.approved || !replacements.length) {
    console.log("   🎬 director's read-through: film holds together as planned.");
    return breakdown;
  }

  const byId = new Map(breakdown.shots.map((s, i) => [s.id, i]));
  const shots = [...breakdown.shots];
  let changed = 0;
  for (const rep of replacements) {
    const at = rep?.originalId ? byId.get(rep.originalId) : undefined;
    if (at === undefined || !rep.shot) continue;
    const base = shots[at];
    const revised = ShotSchema.parse({ ...base, ...(rep.shot as object), id: base.id });
    // GUARD against a confirmed real failure mode: the model sometimes flags
    // a shot (approved:false, names it in "replacements") but returns the
    // SAME shot back unchanged — the prompt above now tells it not to, but
    // this is not trusted on prompt compliance alone. A no-op "replacement"
    // silently counting as a fix would mean a real, identified problem
    // (e.g. a psychology contradiction) ships into the render untouched
    // while every log line claims it was "revised." Skip it and say so.
    if (JSON.stringify(revised) === JSON.stringify(base)) {
      console.warn(`   ⚠️  director's read-through flagged ${base.id} but its own replacement was byte-identical to the original — treating as no fix, shot left as-is.`);
      continue;
    }
    shots[at] = revised;
    changed++;
  }
  if (changed) console.log(`   🎬 director's read-through: revised ${changed} shot(s) for sequence-level plausibility.`);
  return { ...breakdown, shots };
}

/**
 * PRIORITY 4 — DIRECTORIAL JUDGMENT LAYER: shot-type variety and pacing.
 *
 * Everything else in this compiler/repair pipeline validates whether a shot
 * is CORRECT — consistent, non-contradictory, anatomically sound. Nothing
 * evaluates whether a SEQUENCE of shots constitutes good filmmaking: shot
 * variety, pacing, rhythm. That is inherently a softer, judgment-based
 * question a deterministic rule cannot answer on its own — a scene rendered
 * entirely as static medium shots might be a real cinematography failure, or
 * might be a deliberate choice (a tense, unbroken interrogation scene). This
 * is explicitly an LLM-JUDGMENT-TIER check, the SAME tier as
 * directorReadThrough() just above, NOT a hard deterministic rule — stated
 * plainly here so a caller never mistakes its findings for a compiler-grade
 * "this is definitely wrong."
 *
 * DETECTION ONLY — this function itself returns findings, it does not
 * rewrite shots. See reviseShotVariety() just below for the pass that acts
 * on them: kept as a separate call (not folded in here) so detection can
 * still be measured/tuned/disabled independently of correction.
 *

 * Scene-level (not per-shot), only scenes with 3+ shots (variety/pacing is
 * meaningless to judge on a 1-2 shot scene) — sent as ONE lightweight,
 * separate call (not folded into directorReadThrough()'s own already-large
 * call) so this can be tuned/measured/disabled independently.
 */
export interface ShotVarietyFinding {
  scene: string;
  shotIds: string[];
  issue: "framing_repetition" | "pacing_uniformity";
  detail: string;
}

export async function checkShotVariety(breakdown: Breakdown): Promise<ShotVarietyFinding[]> {
  const sceneGroups = new Map<string, typeof breakdown.shots>();
  for (const s of breakdown.shots) {
    const key = s.scene || s.setting || "";
    if (!sceneGroups.has(key)) sceneGroups.set(key, []);
    sceneGroups.get(key)!.push(s);
  }
  const candidates = [...sceneGroups.entries()].filter(([, shots]) => shots.length >= 3);
  if (!candidates.length) return [];

  const context = candidates.map(([scene, shots]) => ({
    scene,
    shots: shots.map((s) => ({
      id: s.id,
      camera: s.camera,
      durationSeconds: s.screenSeconds > 0 ? s.screenSeconds : s.duration,
      whatHappens: s.description || s.motion,
    })),
  }));

  const system = `You are a film editor and cinematographer reviewing a shot list for DIRECTORIAL QUALITY — shot-type variety and pacing — not correctness (that has already been fully validated elsewhere; do not re-check it).

For EACH scene given, judge two things:
1. FRAMING VARIETY: does the sequence of "camera" values across the scene read as a directed sequence (wides, mediums, close-ups, angle changes used where the content actually calls for them), or does it read as accidentally monotonous — the same framing/distance/angle repeated shot after shot with NO narrative reason for the repetition? A scene that is DELIBERATELY all one framing for a real reason (sustained tension, an unbroken interrogation, a formal/static tableau) is NOT a violation — only flag genuine, unmotivated repetition.
2. PACING: does each shot's duration roughly match what's actually happening in it (an action beat and a quiet held moment should not default to identical, uniform lengths for no reason), or is the scene's pacing suspiciously uniform regardless of content?

Return ONLY valid JSON: { "findings": [ { "scene": "<scene value>", "shotIds": ["<id>", ...], "issue": "framing_repetition" | "pacing_uniformity", "detail": "<one or two sentences, specific to what you actually saw>" } ] }
Return an EMPTY findings array for any scene that's genuinely fine — most scenes should not be flagged. Do not flag a scene just because it CAN be described a certain way; flag only a real, specific problem you can point to.`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(context, null, 2) },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
      console.warn(`⚠️  ${config.repairModel} could not process the shot-variety review (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      try {
        res = await attempt(config.llmModel);
      } catch (e2) {
        console.warn(`⚠️  Shot-variety review failed (${(e2 as Error).message}) — skipping it for this render, a judgment-tier check, never blocking.`);
        return [];
      }
    } else {
      console.warn(`⚠️  Shot-variety review failed (${(e as Error).message}) — skipping it for this render, a judgment-tier check, never blocking.`);
      return [];
    }
  }
  logUsage("checkShotVariety", config.repairModel, res.usage);

  try {
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return findings.filter(
      (f: any): f is ShotVarietyFinding =>
        f && typeof f.scene === "string" && Array.isArray(f.shotIds) &&
        (f.issue === "framing_repetition" || f.issue === "pacing_uniformity") && typeof f.detail === "string",
    );
  } catch {
    console.warn("   ⚠️  shot-variety review returned unparseable JSON — skipping it for this render.");
    return [];
  }
}

/**
 * PRIORITY 4 FOLLOW-UP — applies checkShotVariety()'s findings instead of
 * leaving them as report-only. That was deliberately deferred until
 * directorReadThrough()'s revision path (same replace-a-flagged-shot
 * mechanism this reuses) was confirmed trustworthy on a real render —
 * confirmed this session, including catching and fixing a real no-op-
 * replacement failure mode there. This closes the same gap here before it
 * has the chance to repeat it.
 *
 * Deliberately NARROW: only "camera", "motion", and "duration" may change —
 * never "description"/"dialogue"/"characters"/etc. A framing/pacing problem
 * is fixed by changing HOW a beat is shot, not WHAT happens in it, and every
 * other compiler rule (continuity, object permanence, two-endpoints, ...) is
 * keyed off exactly those untouched fields — so a variety fix can never
 * accidentally reopen an already-passed check the way a broader rewrite
 * could. Same no-op guard as directorReadThrough(): a "revision" that
 * changes nothing real is discarded and logged, not silently counted.
 */
export async function reviseShotVariety(breakdown: Breakdown, findings: ShotVarietyFinding[]): Promise<Breakdown> {
  if (!findings.length) return breakdown;

  const flaggedIds = new Set(findings.flatMap((f) => f.shotIds));
  const byId = new Map(breakdown.shots.map((s, i) => [s.id, i]));
  const shotsByScene = new Map<string, typeof breakdown.shots>();
  for (const f of findings) {
    if (!shotsByScene.has(f.scene)) {
      shotsByScene.set(f.scene, breakdown.shots.filter((s) => (s.scene || s.setting || "") === f.scene));
    }
  }

  const context = findings.map((f) => ({
    scene: f.scene,
    issue: f.issue,
    detail: f.detail,
    shotsInScene: (shotsByScene.get(f.scene) ?? []).map((s) => ({
      id: s.id,
      camera: s.camera,
      motion: s.motion,
      durationSeconds: s.screenSeconds > 0 ? s.screenSeconds : s.duration,
      whatHappens: s.description,
      flagged: f.shotIds.includes(s.id),
    })),
  }));

  const system = `You are a film editor fixing REAL, already-identified shot-variety/pacing problems in a shot list. For each scene given, only the shots marked "flagged": true have a confirmed problem — the unflagged shots are shown only for scene context, never revise them.

Fix each flagged shot by choosing a NEW "camera" treatment and/or duration that is actually motivated by "whatHappens" — vary distance/angle/movement across the scene where the content calls for it, and/or adjust duration so it matches the weight of the beat (quick for a fast action, longer for a moment that needs to land). Do NOT change what happens in the shot, who's in it, or any dialogue — only "camera", "motion" (if the new camera choice implies different camera movement), and "duration" may change.

Return ONLY valid JSON: { "revisions": [ { "id": "<flagged shot id>", "camera": "<new camera text>", "motion": "<new motion text, or omit to leave unchanged>", "duration": <new duration in seconds, or omit to leave unchanged> } ] }
One entry per flagged shot you can genuinely improve. If a flagged shot's camera/pacing turns out fine on reflection, leave it out of "revisions" — do not return a no-op entry with the same values it already has.`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(context, null, 2) },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
      try {
        res = await attempt(config.llmModel);
      } catch (e2) {
        console.warn(`⚠️  Shot-variety revision failed (${(e2 as Error).message}) — leaving findings as report-only for this render.`);
        return breakdown;
      }
    } else {
      console.warn(`⚠️  Shot-variety revision failed (${(e as Error).message}) — leaving findings as report-only for this render.`);
      return breakdown;
    }
  }
  logUsage("reviseShotVariety", config.repairModel, res.usage);

  let parsed: { revisions?: { id: string; camera?: string; motion?: string; duration?: number }[] };
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    console.warn("   ⚠️  shot-variety revision returned unparseable JSON — leaving findings as report-only for this render.");
    return breakdown;
  }

  const revisions = (parsed.revisions ?? []).filter((r) => r?.id && flaggedIds.has(r.id) && byId.has(r.id));
  const shots = [...breakdown.shots];
  let changed = 0;
  for (const r of revisions) {
    const at = byId.get(r.id)!;
    const base = shots[at];
    const patch: Partial<Shot> = {};
    if (typeof r.camera === "string" && r.camera.trim() && r.camera !== base.camera) patch.camera = r.camera;
    if (typeof r.motion === "string" && r.motion.trim() && r.motion !== base.motion) patch.motion = r.motion;
    if (typeof r.duration === "number" && r.duration > 0 && r.duration !== base.duration) patch.duration = r.duration;
    if (!Object.keys(patch).length) {
      console.warn(`   ⚠️  shot-variety revision for ${r.id} changed nothing real — treating as no fix, shot left as-is.`);
      continue;
    }
    shots[at] = ShotSchema.parse({ ...base, ...patch });
    changed++;
  }
  if (changed) console.log(`   🎬 shot-variety revision: fixed ${changed} shot(s)' framing/pacing.`);
  return { ...breakdown, shots };
}

/**
 * LENGTH RECONCILIATION — closes the gap between what the user actually
 * requested and what the plan actually adds up to. Nothing upstream of this
 * ever checks the TOTAL: the SHOTS section above only ever gives the director
 * a soft shot-count target derived from the script's "[Target length: ...]"
 * marker, and every per-shot duration is capped independently of the film's
 * overall length (config.maxDuration) — so a multi-minute request can easily
 * come back well short with nothing anywhere catching it. Runs ONCE, on the
 * FINAL shot list (after the compile→repair loop and the director's
 * read-through have already run), so it acts on the truest available shot
 * count rather than an intermediate one later passes might still change —
 * and bounded exactly like every other correction pass in this file: one
 * call, never a loop chasing an exact number an LLM cannot guarantee anyway.
 *
 * ADDS or REMOVES whole shots to close most of the gap — never stretches or
 * compresses an individual shot's own duration, which stays governed
 * entirely by its own content (RULE 5) regardless of the film's total length.
 */
export async function reconcileLength(
  breakdown: Breakdown,
  targetSeconds: number,
  actualSeconds: number,
): Promise<Breakdown> {
  const context = { title: breakdown.title, characters: breakdown.characters, shots: breakdown.shots.map(stripComputedFields) };
  // breakdown.domainPack: reuse the domain already determined by
  // breakdownScript() instead of re-detecting it on every edit — see
  // buildAugmentedSystem()'s own comment for the real, measured cost this avoids.
  const { system } = await buildAugmentedSystem(JSON.stringify(context), breakdown.domainPack, breakdown.language);

  const short = actualSeconds < targetSeconds;
  const gap = Math.abs(targetSeconds - actualSeconds);
  const rawApproxShots = Math.max(1, Math.round(gap / 6));
  // SAFE REMOVAL CAP — CONFIRMED REAL (2026-08-06, "THE PACKAGE" song-video
  // test): for a story that plans well over its target (this one: 151s vs a
  // 60s target, a 152% overage), the uncapped math above asked the model to
  // remove ~15 of 18 shots in ONE pass — not "trim the fat," but "delete
  // almost the entire story." The model complied by amputating the whole
  // second half (the note, the twist ending) rather than proportionally
  // thinning the plan. A film this over-target cannot be fixed by removing
  // shots alone without gutting the story; capping how much ONE pass can cut
  // (never more than 40% of the current shot count) means a severe overage
  // is only ever partially closed here, with the remainder surfaced as a
  // real, visible gap in the logs — never silently "solved" by deleting the
  // ending. Only applies to the too-long direction; the too-short direction
  // has no equivalent failure mode (adding shots can't delete story content).
  const maxRemovable = Math.max(1, Math.floor(breakdown.shots.length * 0.4));
  const approxShots = short ? rawApproxShots : Math.min(rawApproxShots, maxRemovable);
  if (!short && approxShots < rawApproxShots) {
    console.warn(
      `   ⚠️  length reconciliation wants to remove ~${rawApproxShots} of ${breakdown.shots.length} shots to hit ` +
      `the target — capped at ${approxShots} (40% max per pass) so the story doesn't get gutted; the film will ` +
      `likely still run over the ${targetSeconds}s target after this.`,
    );
  }

  const instruction = short
    ? `This shooting plan currently totals about ${actualSeconds}s across ${breakdown.shots.length} shots, but the ` +
      `requested film length is ${targetSeconds}s — it is roughly ${gap}s too SHORT. Add approximately ${approxShots} ` +
      `NEW, genuinely distinct story shots (new beats, new coverage, a scene given more room to breathe, an additional ` +
      `character moment, a new short scene) to close most of that gap. Do NOT stretch or pad any EXISTING shot's ` +
      `duration or content to fill time — every existing shot must be returned completely unchanged (same id, same ` +
      `every field) except for where new shots are inserted around it. Insert the new shots wherever they genuinely ` +
      `belong in the story, not all bunched at the end. Every rule in this document (two endpoints, narrative ` +
      `completeness, continuity, cast discipline, per-shot duration limits) applies to the new shots exactly as it ` +
      `does to every other shot — a longer film is MORE distinct shots, never longer or slower individual ones.`
    : `This shooting plan currently totals about ${actualSeconds}s across ${breakdown.shots.length} shots, but the ` +
      `requested film length is ${targetSeconds}s — it is roughly ${gap}s too LONG. Remove approximately ${approxShots} ` +
      `of the LEAST essential existing shots (repeated beats, padding, business that doesn't earn its place per EVERY ` +
      `SHOT MUST EARN ITS PLACE above) to bring the total down toward the target — spread across the WHOLE story, not ` +
      `concentrated in one section; never remove a story's climax/ending/payoff shots just because they happen to be ` +
      `late in the list. NEVER remove only one frame of a two-endpoint action (that would break RULE 3 — a ` +
      `state-change shot's startFrame/endFrame are one indivisible unit), and never cut a shot that a later shot's ` +
      `CONTINUITY handoff explicitly depends on without also fixing that handoff. Every remaining shot must be ` +
      `returned completely unchanged (same id, same every field) — you may only decide which shots stay or go, ` +
      `never rewrite one you're keeping.`;

  const userContent =
    `Here is the complete, already-valid shooting plan for "${breakdown.title}" as JSON:\n\n${JSON.stringify(context, null, 2)}\n\n${instruction}\n\n` +
    `Return ONLY this JSON — the COMPLETE shots array in final story order (existing shots plus any you added, or ` +
    `minus any you removed), never a partial list:\n{"shots": [ <every shot object, in final order> ]}`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
      console.warn(`⚠️  ${config.repairModel} could not process the length reconciliation (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      res = await attempt(config.llmModel);
    } else {
      console.warn(`⚠️  Length reconciliation failed (${(e as Error).message}) — keeping the plan as-is.`);
      return breakdown;
    }
  }
  logUsage("reconcileLength", config.repairModel, res.usage);

  let parsed: { shots?: unknown[] };
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    console.warn("   ⚠️  length reconciliation returned unparseable JSON — keeping the plan as-is.");
    return breakdown;
  }
  if (!Array.isArray(parsed.shots) || !parsed.shots.length) {
    console.warn("   ⚠️  length reconciliation returned no shots — keeping the plan as-is.");
    return breakdown;
  }

  let shots: Shot[];
  try {
    shots = parsed.shots.map((s) => ShotSchema.parse(s));
  } catch (e) {
    console.warn(`   ⚠️  length reconciliation returned malformed shot(s) (${(e as Error).message}) — keeping the plan as-is.`);
    return breakdown;
  }

  // ENFORCE "unchanged," DON'T JUST REQUEST IT — CONFIRMED REAL (2026-08-06,
  // same test as the removal cap above): the instruction above explicitly
  // says every kept shot must come back "completely unchanged (same id, same
  // every field)," but a real call kept an existing shot's id while silently
  // REWRITING its content — replacing a real beat (Arjun spinning around and
  // running back through the market) with a fabricated one (Arjun vaulting a
  // stone wall that appears nowhere in the script). This is exactly the
  // "invented obstacle" defect class checkScriptContentInvention() exists to
  // catch — and, at the time this was written, that check only ever ran on
  // the ORIGINAL breakdown, before this pass, with no way to know THIS pass
  // silently rewrote a shot it was told to leave alone. 1-breakdown.ts now
  // also runs that check a second time, on the truly final shot list (after
  // this pass and everything else), so a miss here is no longer the only
  // line of defense — but this deterministic, no-LLM-round-trip check still
  // catches it immediately, for free, without waiting on that later pass.
  // Trusting the prompt was the bug; this compares
  // every kept shot's core story-content fields against the original and
  // reverts any real difference, the same "the compiler enforces what the
  // prompt only requests" discipline compileBreakdown() already applies
  // everywhere else. This function's only real license is deciding WHICH
  // shots survive — never rewriting one it was told to keep as-is. A shot id
  // with no match in the original breakdown is a genuine NEW shot (the
  // "short" direction) and passes through untouched.
  const CONTENT_FIELDS = [
    "description", "motion", "camera", "setting", "lighting", "dialogue",
    "startFrame", "endFrame", "duration", "speaker", "offscreenSpeaker", "crowd",
  ] as const;
  const originalById = new Map(breakdown.shots.map((s) => [s.id, s]));
  let reverted = 0;
  const guarded = shots.map((s) => {
    const original = originalById.get(s.id);
    if (!original) return s;
    const sameCast = JSON.stringify([...s.characters].sort()) === JSON.stringify([...original.characters].sort());
    const sameContent = sameCast && CONTENT_FIELDS.every((f) => JSON.stringify(s[f]) === JSON.stringify(original[f]));
    if (sameContent) return s;
    reverted++;
    return original;
  });
  if (reverted) {
    console.warn(
      `   ⚠️  length reconciliation rewrote ${reverted} shot(s) it was told to leave unchanged — reverted to the ` +
      `original content (its keep/remove decision for those shots is still honored, only the content rewrite is not).`,
    );
  }

  return { ...breakdown, shots: guarded };
}

/**
 * Translates ONLY the spoken dialogue lines of an already-finished breakdown
 * into a NEW target language — for producing a second-language version of
 * the SAME film (same shots, same characters, same keyframes; see
 * steps/7-relanguage.ts, the only caller, for why the visual side never
 * needs to change). Returns a Record<shotId, translatedLine> for every shot
 * that actually has dialogue — deliberately NEVER the whole shot/breakdown
 * object: the caller merges this map onto a COPY of the original breakdown
 * by id, so this call has no structural way to touch any other field
 * (description, motion, camera, keyframe refs, duration...) even if the
 * model tried to. Same "the code enforces what the prompt only requests"
 * discipline reconcileLength()'s own CONTENT_FIELDS revert check applies
 * just above, made structural here instead of a post-hoc diff.
 *
 * Throws rather than degrading to the original text on failure — unlike
 * reconcileLength()'s "keep the plan as-is" fallback, there is no safe
 * partial result here: a caller asking for a Hindi version has nothing
 * useful to do with English text silently standing in for it, and a film
 * that's supposedly "in Hindi" but is actually still in English is a much
 * worse, silent failure than the render simply not happening this run.
 */
export async function translateDialogue(
  breakdown: Breakdown,
  targetLanguageCode: string,
): Promise<Record<string, string>> {
  const spoken = breakdown.shots
    .filter((s) => s.dialogue?.trim())
    .map((s) => ({
      id: s.id,
      speaker: s.speaker ? breakdown.characters.find((c) => c.id === s.speaker)?.name ?? s.speaker : null,
      scene: s.scene,
      line: s.dialogue,
    }));
  if (!spoken.length) return {};

  const targetName = languageName(targetLanguageCode);
  const targetNative = languageNative(targetLanguageCode);
  const system =
    `You are a dialogue translator for a film. Translate each spoken LINE into natural, colloquial ${targetName} ` +
    `(${targetNative}) the way a real person would actually SAY it out loud in that scene — not a stiff, literal ` +
    `word-for-word translation. Preserve the meaning, tone, and emotional register of the original line exactly ` +
    `(a curt line stays curt, a warm line stays warm). Keep each translated line roughly the same LENGTH/duration ` +
    `to speak as the original — a much longer or shorter translation will not fit the shot's timing. Return ONLY ` +
    `the translated text for each line, written in the target language's own native script, with no English ` +
    `transliteration, no romanization, and no explanation.`;

  const userContent =
    `Translate every line below into ${targetName} (${targetNative}). Each has an "id" you must return unchanged, ` +
    `the character SPEAKING it (for tone/register), and the SCENE for context:\n\n` +
    `${JSON.stringify(spoken, null, 2)}\n\n` +
    `Return ONLY this JSON — one entry per line above, in the SAME order, every "id" preserved exactly:\n` +
    `{"lines": [{"id": "<same id>", "translated": "<the ${targetName} line, in native script>"}]}`;

  const attempt = async (model: string) =>
    client.chat.completions.create({
      model,
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

  let res;
  try {
    res = await attempt(config.repairModel);
  } catch (e) {
    if ((isRequestTooLargeError(e) || isModelAccessError(e)) && config.repairModel !== config.llmModel) {
      console.warn(`⚠️  ${config.repairModel} could not process dialogue translation (${(e as Error).message}). Falling back to ${config.llmModel}.`);
      res = await attempt(config.llmModel);
    } else {
      throw e;
    }
  }
  logUsage("translateDialogue", config.repairModel, res.usage);

  let parsed: { lines?: { id?: string; translated?: string }[] };
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    throw new Error("dialogue translation returned unparseable JSON");
  }
  if (!Array.isArray(parsed.lines) || !parsed.lines.length) {
    throw new Error("dialogue translation returned no lines");
  }

  const spokenIds = new Set(spoken.map((s) => s.id));
  const result: Record<string, string> = {};
  for (const line of parsed.lines) {
    if (!line?.id || typeof line.translated !== "string" || !line.translated.trim()) continue;
    if (!spokenIds.has(line.id)) continue; // never accept an id we didn't ask about
    result[line.id] = line.translated.trim();
  }

  const missing = spoken.filter((s) => !result[s.id]);
  if (missing.length) {
    throw new Error(
      `dialogue translation is missing ${missing.length} of ${spoken.length} line(s) ` +
      `(shot ids: ${missing.map((s) => s.id).join(", ")})`,
    );
  }

  return result;
}