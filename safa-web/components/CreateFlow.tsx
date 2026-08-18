"use client";
import { useEffect, useRef, useState } from "react";
import Dialog, { type DialogSpec } from "./Dialog";
import ChatPanel from "./ChatPanel";
import starterPrompts from "@/config/starter-prompts.json";
import { creditsFor, type Resolution } from "@/lib/pricing";
import { DEFAULT_FILM_LANGUAGE } from "@/lib/languages";
import { MAX_SCRIPT_CHARS, MIN_SCRIPT_CHARS, MIN_AD_SCRIPT_CHARS } from "@/lib/limits";

const MIN_SCRIPT = MIN_SCRIPT_CHARS;
// A real ad brief can be much shorter than a narrative script ("create an ad
// for this product" is ~31 chars) — matches the server's own lower floor for
// type "ad" in safa-web/app/api/projects/route.ts.
const AD_MIN_SCRIPT = MIN_AD_SCRIPT_CHARS;
// Imported, not redeclared — this and the server's own check must never be able
// to disagree (see lib/limits.ts). A client limit lower than the server's is the
// worse direction: the composer refuses a script the API would have accepted.
const MAX_SCRIPT = MAX_SCRIPT_CHARS;

// timecodeStart/timecodeEnd/screenSeconds: computed by ai-film-pro's compiler
// (never authored), see Shot.timecodeStart's own comment in that project's
// types.ts — a running "MM:SS" position in the final assembled film, so a
// user reviewing the plan sees exactly where each shot lands, the same way a
// real shot list is reviewed.
type Shot = {
  id: string; scene?: string; description: string; duration?: number; dialogue?: string;
  // The beat-by-beat physical ACTION timeline (ai-film-pro's compiler.ts / llm.ts
  // "motion" field) — this is where "what each character actually does" lives,
  // separately from "description" (which is mostly visual/scene-setting). The
  // render prompt (ai-film-pro's 5-videos.ts) sends BOTH to the video model as
  // "<description>. ... Action: <motion>.", so a review screen that only shows
  // "description" is showing an incomplete, misleading picture of what will
  // actually render — see the shot-card JSX below for where this is surfaced.
  motion?: string;
  timecodeStart?: string; timecodeEnd?: string; screenSeconds?: number;
  [k: string]: unknown;
};
// id/name/appearance mirror ai-film-pro's own CharacterSchema (types.ts) —
// appearance is the description the user/breakdown actually authored for
// this character, carried through breakdown.characters but (until now)
// never surfaced back to the user anywhere in this UI.
type BreakdownCharacter = { id: string; name: string; appearance?: string; voice?: string; [k: string]: unknown };
// A user's saved, reusable character — see app/api/characters/route.ts.
// Only referenceImageUrl actually reaches a future render (matched by array
// order into characterImages, same path a manual photo upload already uses);
// name/appearance/voice are UI-only labels for this picker.
type SavedCharacter = { id: string; name: string; appearance: string; voice: string; referenceImageUrl: string; sourceProjectId?: string | null };
type Breakdown = { title?: string; shots: Shot[]; characters?: BreakdownCharacter[] };
type Options = Record<string, { name: string; options: string[] }>;
// flagged/flagReason: set by worker.ts when the generation pipeline's own QA
// or identity checks couldn't resolve a defect after their retry — surfaces
// directly here so a long film's handful of problem clips are findable
// without scrubbing through all of them (see #4 in the long-form plan).
type Clip = { id: string; url: string; label: string; flagged?: boolean; flagReason?: string };
// Same shape as Clip, one stage earlier — a still keyframe, not a rendered clip.
// See ai-film-pro's worker.ts Keyframe type for where this comes from.
type Keyframe = { id: string; url: string; label: string; flagged?: boolean; flagReason?: string };
// AI SONG VIDEOS — written by ai-film-pro's handleSong() (worker.ts) into
// Project.songJson. `[k: string]: unknown` on the section shapes, same
// looseness as Shot above, since only title/url/lyrics text are actually
// rendered here — the rest is passed through untouched.
type SongSection = { tag?: string; lyrics?: string; [k: string]: unknown };
type Song = {
  lyrics: { title?: string; stylePrompt?: string; sections: SongSection[] };
  song: { url: string; durationSec?: number; [k: string]: unknown };
};
type Status = {
  status: string;
  title?: string;
  script?: string;
  type?: string;
  song: Song | null;
  breakdown: Breakdown | null;
  options: Options | null;
  selection?: Record<string, number>;
  locationOptions?: Options | null;
  locationSelection?: Record<string, number>;
  keyframes: Keyframe[] | null;
  clips: Clip[] | null;
  filmUrl: string | null;
  error: string | null;
  job: { type: string; status: string; stage: string; progress: number } | null;
};
type Phase = "idle" | "working" | "song" | "breakdown" | "select" | "keyframes" | "clips" | "done" | "error";

/** A regen-shot/regen-clip/assemble failure reverts the project to its review
 *  screen rather than the hard "failed" status, so the user keeps everything
 *  else and can just try again -- but that means the error needs to show
 *  HERE, inline, not on a separate error screen the user never reaches. */
function ErrorNotice({ notice, onDismiss }: { notice: string | null; onDismiss: () => void }) {
  if (!notice) return null;
  return (
    <div
      style={{
        display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px",
        margin: "8px 0 16px", borderRadius: 8, background: "rgba(220, 60, 60, 0.10)",
        border: "1px solid rgba(220, 60, 60, 0.35)",
      }}
    >
      <span style={{ flex: 1 }}>⚠️ {notice}</span>
      <button className="shot-regen" onClick={onDismiss} style={{ whiteSpace: "nowrap" }}>Dismiss</button>
    </div>
  );
}

export default function CreateFlow({
  greeting, firstName, initialScript = "", onTitle, resumeProjectId, onExit,
}: {
  greeting: string; firstName: string; initialScript?: string; onTitle?: (title: string) => void;
  // resumeProjectId: reopen an EXISTING project (from "click a project" or
  // "modify -> edit the clips") into this same wizard instead of starting a
  // fresh one — see pollStatus()'s status->phase mapping below, which was
  // already fully status-driven and needed no separate hydration path.
  // onExit: called when a resumed instance's reset() runs (Start over / Make
  // another) -- there is no meaningful "idle" screen to fall back to for an
  // existing project, so the parent should navigate away instead.
  resumeProjectId?: string; onExit?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(resumeProjectId ? "working" : "idle");
  const [script, setScript] = useState(initialScript);
  const [mode, setMode] = useState<"script" | "ai" | "song" | "ad">("script");
  // Project.type as the SERVER knows it ("film" | "ad" | "song_video") —
  // `mode` above is only the creation-screen tab and resets/never hydrates on
  // resume, so ad-specific review screens (the select screen's regenerate
  // dialog) key off this instead. Captured unconditionally in pollStatus(),
  // same discipline as script/breakdown/options there.
  const [projType, setProjType] = useState<string>("");
  const [secs, setSecs] = useState(60);
  const [customLen, setCustomLen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(resumeProjectId ?? null);
  // Raw status string (pollStatus keeps this in sync with `phase`) — phase
  // collapses several statuses into one screen (e.g. both breakdown_review
  // and needs_edit render phase="breakdown"), but the breakdown screen's own
  // CTA and the chat panel both need to know which one it actually is.
  const [status, setStatus] = useState<string>(resumeProjectId ? "" : "draft");
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [options, setOptions] = useState<Options>({});
  // Which character's detail modal (full photo + their authored appearance
  // description) is open, keyed by character id — null when none is.
  const [expandedCharId, setExpandedCharId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, number>>({});
  // Same shape/reasoning as options/selection above, for locations — every
  // distinct location in the film gets a few looks to choose from, on this
  // same screen, not just genuinely-revisited ones.
  const [locationOptions, setLocationOptions] = useState<Options>({});
  const [locationSelection, setLocationSelection] = useState<Record<string, number>>({});
  const [song, setSong] = useState<Song | null>(null);
  const [visualTheme, setVisualTheme] = useState("");
  const [performerAppearance, setPerformerAppearance] = useState("");
  const [songBusy, setSongBusy] = useState(false);
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [film, setFilm] = useState<string | null>(null);
  const [stage, setStage] = useState("Working");
  const [progress, setProgress] = useState(5);
  const [err, setErr] = useState("");
  const [stalled, setStalled] = useState(false);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  // A regen-shot/regen-clip/assemble failure reverts the project to its
  // REVIEW screen (breakdown_review/clips_review), not the "failed" status —
  // by design, so the user keeps everything else and can just try again.
  // But that meant s.error was silently dropped: the worker sets it, nothing
  // ever showed it. Mirrors s.error directly (the worker now also clears it
  // back to null on every subsequent success, so this never shows a stale,
  // already-resolved failure).
  const [notice, setNotice] = useState<string | null>(null);
  // Stop/Resume — see api/projects/[id]/cancel|resume. jobType/jobStatus mirror
  // the current job's own fields (polled alongside stage/progress below):
  // jobType gates WHERE the Stop button shows (the slow/expensive job types
  // only — see `stoppable` below; breakdown/options finish in under a
  // minute, not worth the UI); jobStatus === "cancelled" swaps the working
  // screen for a Paused/Resume state instead of the spinner.
  const [jobType, setJobType] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pid = useRef<string | null>(resumeProjectId ?? null);
  const lastProg = useRef({ p: -1, at: Date.now() });
  const [elapsed, setElapsed] = useState(0);
  const [expanding, setExpanding] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [wrote, setWrote] = useState(false);
  const [productImages, setProductImages] = useState<string[]>([]); // uploaded product photos for ad mode
  const [uploading, setUploading] = useState(false);
  // Uploaded character casting photos — skips AI-generated look options for
  // the matching character(s), same shape/reasoning as productImages above.
  const [characterImages, setCharacterImages] = useState<string[]>([]);
  const [charUploading, setCharUploading] = useState(false);
  // "Save to my characters" (char-modal) — a small saving/saved-confirmation
  // pair per character id, same "busy Set + timed confirmation" shape
  // AppShell's own regeneratingSheets/shareCopied state already use.
  const [savingCharId, setSavingCharId] = useState<string | null>(null);
  const [savedCharIds, setSavedCharIds] = useState<Set<string>>(new Set());
  // "My characters" picker (attach-bar) — lazy-loaded on first open, not on
  // every CreateFlow mount, since most visits never open it.
  const [savedCharacters, setSavedCharacters] = useState<SavedCharacter[]>([]);
  const [savedCharsLoaded, setSavedCharsLoaded] = useState(false);
  const [charPickerOpen, setCharPickerOpen] = useState(false);
  // RESTORED — ai-film-pro (Seedance 1.5 Pro) honors all three tiers again
  // per-project; see lib/pricing.ts. Real user choice now, priced accordingly
  // by creditsFor() below.
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [audioOn, setAudioOn] = useState(false);
  const [titleCardOn, setTitleCardOn] = useState(true); // free — opening title card + closing fade, on by default
  // Ad mode's "click, don't prompt" signature camera style — a key into
  // ai-film-pro's CAMERA_MOVE_LIBRARY.json, sent as-is to POST /api/projects
  // (route.ts folds it into the script as a bracket tag, same convention as
  // `duration`). "" = Auto, the director still defaults to a 360° orbit,
  // completely unchanged from before this picker existed.
  const [cameraStyle, setCameraStyle] = useState("");
  // Film mode: the language the film's dialogue is WRITTEN and PERFORMED in.
  // Sent as-is to POST /api/projects, which folds it into the script as a
  // "[Language: xx]" bracket tag (same convention as `duration`/`cameraStyle`).
  // Defaults to English, and route.ts writes no tag at all for English — so a
  // user who never touches this picker gets byte-identical behaviour to before.
  // Spoken-language picker removed (see the removed rr-group block further
  // down) — language is permanently the default now, never changed by the
  // user, so there is no setter to wire up.
  const [language] = useState(DEFAULT_FILM_LANGUAGE);
  // Ad mode: whether a spokesperson appears in the ad at all. OFF = faceless
  // product-only ad (the default). ON = the director plans one shot with a
  // person — the user's own Character photo if attached, otherwise an
  // AI-designed spokesperson they pick at casting time. An attached
  // character photo implies ON (see adHasPerson below).
  const [adSpokesperson, setAdSpokesperson] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const charFileRef = useRef<HTMLInputElement>(null);
  const startAt = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the composer with its content. Previously CSS field-sizing:content
  // did this natively on browsers that support it, with this effect only as a
  // fallback — CONFIRMED REAL BUG, FIXED: field-sizing recomputes the
  // textarea's intrinsic height on EVERY render, with no dependency scoping at
  // all, so switching Resolution/Title card/Audio (each an unrelated state
  // update elsewhere in this same component) triggered a transient height
  // recalculation on a textarea whose actual content never changed. Without
  // the scroll container reliably re-settling after that, the page was left
  // scrolled into blank space the (now back-to-normal) content no longer
  // filled — the reported "gap." This effect is properly scoped to [script,
  // phase] and only resizes when there's an actual reason to, so it now runs
  // unconditionally instead of yielding to field-sizing.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [script, phase]);

  const fmtSecs = (n: number) => (n < 60 ? `${n}s` : n % 60 === 0 ? `${n / 60} min` : `${Math.floor(n / 60)}m ${n % 60}s`);
  const toggleCustomLen = () => {
    if (customLen) setSecs((v) => Math.min(60, Math.max(10, Math.round(v / 5) * 5)));
    setCustomLen((c) => !c);
  };

  useEffect(() => () => { if (poll.current) clearTimeout(poll.current); }, []);

  // Resume: kick off the same status-driven poll used mid-generation, just
  // with an id that came from the caller instead of start(). pollStatus()
  // already fetches, maps status -> phase, and populates every piece of
  // state (breakdown/options/clips/film) from the response — no separate
  // hydration path needed.
  useEffect(() => { if (resumeProjectId) pollStatus(resumeProjectId); }, [resumeProjectId]);

  // tick elapsed time while a render is in progress
  useEffect(() => {
    if (phase === "working") {
      if (startAt.current === null) startAt.current = Date.now();
      const t = setInterval(() => {
        if (startAt.current !== null) setElapsed(Math.floor((Date.now() - startAt.current) / 1000));
      }, 1000);
      return () => clearInterval(t);
    }
    startAt.current = null;
    setElapsed(0);
  }, [phase]);
  const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function stopPoll() { if (poll.current) clearTimeout(poll.current); }

  async function post(url: string, body: unknown) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Request failed");
    return d;
  }

  // ONE SOURCE OF TRUTH — this used to be a separate, hardcoded copy of
  // lib/pricing.ts's formula (same numbers, duplicated by hand), a real drift
  // risk: three places (here, lib/pricing.ts, and ai-film-pro's spend.ts)
  // that all had to be kept in sync manually. Now imports the actual function.
  const estCredits = creditsFor({ seconds: secs, resolution, audio: audioOn });

  // Shared core for both the product-photo and character-photo uploaders —
  // same upload endpoint, same cap-and-append pattern, only the target
  // state/setter/ref/cap differ.
  async function uploadTo(
    files: File[],
    current: string[],
    setImages: React.Dispatch<React.SetStateAction<string[]>>,
    cap: number,
    setBusy: (v: boolean) => void,
    inputRef: React.RefObject<HTMLInputElement>,
  ) {
    if (!files.length) return;
    setErr("");
    setBusy(true);
    try {
      for (const file of files) {
        if (current.length >= cap) break;
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || "Upload failed.");
        setImages((prev) => (prev.length >= cap ? prev : [...prev, j.url]));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }
  const productCap = mode === "ad" ? 1 : 4; // one hero product for an ad, up to 4 for a normal film
  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    await uploadTo(Array.from(e.target.files ?? []), productImages, setProductImages, productCap, setUploading, fileRef);
  }
  function removeProductImage(url: string) {
    setProductImages((prev) => prev.filter((u) => u !== url));
  }
  async function onPickCharacterFiles(e: React.ChangeEvent<HTMLInputElement>) {
    await uploadTo(Array.from(e.target.files ?? []), characterImages, setCharacterImages, 4, setCharUploading, charFileRef);
  }
  function removeCharacterImage(url: string) {
    setCharacterImages((prev) => prev.filter((u) => u !== url));
  }

  // "Save to my characters" — called from the char-modal, which already has
  // everything needed client-side (name/appearance/voice from this project's
  // own breakdown, url from the chosen casting photo) — no server-side
  // lookup required.
  async function saveCharacter(charId: string, name: string, appearance: string, voice: string | undefined, url: string) {
    setSavingCharId(charId);
    try {
      const r = await fetch("/api/characters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, appearance, voice: voice || "narrator", referenceImageUrl: url, sourceProjectId: projectId }),
      });
      if (r.ok) {
        setSavedCharIds((prev) => new Set(prev).add(charId));
        setSavedCharsLoaded(false); // next picker open re-fetches, so the new save shows up there too
      }
    } catch {
      // silent — the button just stays un-"Saved", the user can retry
    } finally {
      setSavingCharId(null);
    }
  }

  // "My characters" picker — lazy-loaded on first open of the popover.
  async function openCharPicker() {
    setCharPickerOpen((v) => !v);
    if (savedCharsLoaded) return;
    try {
      const r = await fetch("/api/characters");
      const j = await r.json();
      setSavedCharacters(j.characters || []);
      setSavedCharsLoaded(true);
    } catch {
      // leave savedCharsLoaded false — the picker just shows nothing this time, retries on next open
    }
  }
  function pickSavedCharacter(url: string) {
    setCharacterImages((prev) => (prev.length >= 4 || prev.includes(url) ? prev : [...prev, url]));
  }
  async function deleteSavedCharacter(id: string) {
    setSavedCharacters((prev) => prev.filter((c) => c.id !== id));
    await fetch(`/api/characters/${id}`, { method: "DELETE" }).catch(() => {});
  }

  async function start() {
    if (script.trim().length < (mode === "ad" ? AD_MIN_SCRIPT : MIN_SCRIPT)) return;
    onTitle?.("");
    setErr(""); setPhase("working"); setStage(mode === "song" ? "Sending your theme" : "Sending your script"); setProgress(5);
    try {
      // AI SONG VIDEOS — a different body shape, not just a different `type`
      // value: no duration-prefix hack (targetLengthSec travels as a real
      // structured field, read server-side from `seconds`) and no product
      // images (no product being advertised in a song video). Character
      // photos (an optional performer reference) travel either way. type
      // "ad" reuses the SAME shape as a normal film (still the
      // duration-prefix convention, still productImages/characterImages) —
      // only the `type` value differs, since app/api/projects/route.ts
      // already treats "ad" as a variant of the narrative-film path, not a
      // separate branch the way song_video is. Response handling below is
      // identical either way — see that route's song_video branch, which
      // returns the same {id, credits, estimatedUsd, clamped} shape.
      const body =
        mode === "song"
          ? { script, type: "song_video", characterImages, seconds: secs, resolution, aspectRatio: aspect, audio: audioOn, titleCard: titleCardOn }
          : { script, type: mode === "ad" ? "ad" : "film", duration: secs % 60 === 0 ? `${secs / 60} min` : `${secs} seconds`, productImages, characterImages, seconds: secs, resolution, aspectRatio: aspect, audio: audioOn, titleCard: titleCardOn, cameraStyle: mode === "ad" ? cameraStyle : undefined, spokesperson: mode === "ad" ? (adSpokesperson || characterImages.length > 0) : undefined, language: mode === "ad" ? undefined : language };
      const d = await post("/api/projects", body);
      setProjectId(d.id); pid.current = d.id;
      // CONFIRMED REAL GAP, FIXED: applyPlanLimits() (safa-web/lib/pricing.ts)
      // has always computed exactly why a free-plan request got downgraded
      // ("length capped to 15s on the free plan", etc.) specifically so the
      // UI could explain it instead of silently changing what the user
      // asked for — but nothing here ever read `d.clamped`. A free-tier user
      // requesting 60s/1080p/audio got quietly downgraded with zero
      // indication anything changed. Reusing the existing ErrorNotice
      // mechanism (already shown on every later screen via `notice`) rather
      // than inventing a new banner for one string.
      if (Array.isArray(d.clamped) && d.clamped.length) {
        setNotice(`Adjusted for your plan: ${d.clamped.join("; ")}.`);
      }
      pollStatus(d.id);
    } catch (e) { setErr((e as Error).message); setPhase("error"); }
  }
  // AI writer: expand a one-line idea into a screenplay, then drop into review mode so the user can edit before generating.
  async function expandIdea() {
    const idea = script.trim();
    if (idea.length < 8 || expanding) return;
    setExpanding(true); setErr("");
    try {
      const r = await fetch("/api/expand", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idea }) });
      const j = await r.json();
      if (!r.ok || !j?.script) throw new Error(j?.error || "Could not write the script.");
      setScript(j.script);
      setMode("script"); // switch to review mode: the full screenplay is now editable before generating
      setWrote(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExpanding(false);
    }
  }
  // Enrich: take a script the user ALREADY wrote (not a one-line idea — see
  // expandIdea() above for that path) and hand it back fuller and more
  // cinematic — dialogue added, any referenced note/letter text actually
  // written out, sized to the same `secs` target already set on this screen.
  // Same review-before-generating discipline as expandIdea(): the result
  // replaces the editable textarea, nothing is generated automatically.
  async function enrichScript() {
    const current = script.trim();
    if (current.length < MIN_SCRIPT || enriching) return;
    setEnriching(true); setErr("");
    try {
      const r = await fetch("/api/expand", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script: current, targetSeconds: secs }) });
      const j = await r.json();
      if (!r.ok || !j?.script) throw new Error(j?.error || "Could not enrich the script.");
      setScript(j.script);
      setWrote(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setEnriching(false);
    }
  }

  async function pollStatus(id: string) {
    try {
      const r = await fetch(`/api/projects/${id}`);
      const s: Status = await r.json();
      if (s.title) onTitle?.(s.title);
      setStatus(s.status);
      // UNCONDITIONAL CAPTURE — every one of these was previously only set
      // inside the ONE switch branch that phase actively needs it for, which
      // meant a project resumed straight into a LATER status (most visibly
      // "done") never fetched the script, breakdown, or character selection
      // at all — landing on the finished-film screen with nothing to show
      // but the video itself. The server already returns all of this on
      // every single call; there's no reason to gate capturing it on which
      // phase happens to be active. renderPhase()'s per-phase screens still
      // read these same state variables for their own interactive controls —
      // this only changes WHEN they get populated, not how they're used.
      if (s.script) setScript(s.script);
      if (s.type) setProjType(s.type);
      if (s.breakdown) setBreakdown(s.breakdown);
      if (s.options) setOptions(s.options);
      if (s.selection && Object.keys(s.selection).length) setSelection(s.selection);
      if (s.locationOptions) setLocationOptions(s.locationOptions);
      if (s.locationSelection && Object.keys(s.locationSelection).length) setLocationSelection(s.locationSelection);
      if (s.keyframes) setKeyframes(s.keyframes);
      if (s.clips) setClips(s.clips);
      if (s.filmUrl) setFilm(s.filmUrl);
      if (s.song) setSong(s.song);
      // CONFIRMED REAL GAP, FIXED: `dialog` is shared, unscoped state rendered
      // on every review screen (select/keyframes/clips). Polling only ever
      // reaches here on an initial load or an explicit resume() after the
      // user just submitted something (review screens stopPoll() once
      // reached, so this doesn't fire while one just sits open) — but a
      // dialog opened on one screen (e.g. "regenerate this keyframe") could
      // still be left open if the project moved on before it was confirmed
      // (another tab, or chat's "continue"). Clearing it here means a stale
      // dialog can never render on — or submit an action against — a screen
      // it no longer belongs to.
      setDialog(null);
      setJobType(s.job?.type ?? null);
      setJobStatus(s.job?.status ?? null);
      switch (s.status) {
        case "song_review":
          setNotice(s.error || null);
          setPhase("song"); stopPoll(); return;
        case "breakdown_review":
          setNotice(s.error || null);
          setPhase("breakdown"); stopPoll(); return;
        // needs_edit: the worker paused a shots render because the LLM
        // refused something in the current breakdown (see worker.ts's
        // ContentRefusedError handling) — the fix is the SAME screen as
        // breakdown_review (edit the offending shot), but "continue" from
        // here must skip straight back to rendering, not go through
        // character options again. confirmBreakdown() below branches on
        // `status` to send that continuation through chat's existing
        // RESUME_STEPS["needs_edit"] instead of the normal confirm action.
        case "needs_edit":
          setNotice(s.error || null);
          setPhase("breakdown"); stopPoll(); return;
        case "awaiting_selection":
          // if each character has exactly one option, auto-select it (single-character flow)
          if (s.options && Object.values(s.options).every((c) => c.options.length === 1)) {
            setSelection(Object.fromEntries(Object.keys(s.options).map((cid) => [cid, 0])));
          }
          // same auto-select for locations, same reasoning
          if (s.locationOptions && Object.values(s.locationOptions).every((c: any) => c.options.length === 1)) {
            setLocationSelection(Object.fromEntries(Object.keys(s.locationOptions).map((lid) => [lid, 0])));
          }
          setNotice(s.error || null);
          setPhase("select"); stopPoll(); return;
        case "keyframes_review":
          setNotice(s.error || null);
          setPhase("keyframes"); stopPoll(); return;
        case "clips_review":
          setNotice(s.error || null);
          setPhase("clips"); stopPoll(); return;
        case "done":
          setPhase("done"); stopPoll(); return;
        case "failed":
          setErr(s.error || "Something failed. Check the worker logs."); setPhase("error"); stopPoll(); return;
        default:
          if (s.job) {
            setStage(s.job.stage);
            const p = s.job.progress || 5;
            setProgress(p);
            // a long stretch with no movement reads as a crash; reassure instead
            if (p !== lastProg.current.p) lastProg.current = { p, at: Date.now() };
            setStalled(Date.now() - lastProg.current.at > 60000);
          }
          setPhase("working");
          poll.current = setTimeout(() => pollStatus(id), 2500);
      }
    } catch { poll.current = setTimeout(() => pollStatus(id), 3500); }
  }

  function resume() { setPhase("working"); setProgress(10); if (pid.current) pollStatus(pid.current); }

  // ---- stop / resume (keyframes + clips only — see cancel/route.ts's own
  // CANCELLABLE_TYPES) ----
  // Fire-and-continue-polling, not fire-and-forget: the worker checks
  // cancelRequested once per shot, not instantly, so the job usually keeps
  // running (and jobStatus stays "running"/"queued") for a little while
  // after this call returns — the existing poll loop is what actually shows
  // "Paused" the moment the worker's own render loop reaches a checkpoint
  // and the poll picks up jobStatus === "cancelled".
  async function stopGeneration() {
    if (!pid.current || stopping) return;
    setStopping(true);
    try { await post(`/api/projects/${pid.current}/cancel`, {}); } catch (e) { setErr((e as Error).message); }
    finally { setStopping(false); }
  }
  function resumeGeneration() {
    if (!pid.current || resuming) return;
    setResuming(true);
    post(`/api/projects/${pid.current}/resume`, {})
      .then(() => resume())
      .catch((e) => setErr((e as Error).message))
      .finally(() => setResuming(false));
  }
  // CONFIRMED REAL GAP, FIXED — the "Start over" button on the error screen
  // (phase === "error", below) was the ONLY action offered there, and reset()
  // abandons the project entirely (setProjectId(null)), which is exactly what
  // throws away eligibility for the worker's own project-scoped caching
  // (restoreCachedArtifacts, plus 4-images.ts's per-shot cache-hit check) —
  // a render that died mid-way (e.g. a shots job failing on shot 2 after
  // shot 1's keyframe already rendered and was banked to R2/Artifact) had no
  // way to pick back up from there through this screen; the user's only path
  // re-paid for and re-rendered everything from shot 1 again.
  // /api/projects/[id]/chat's "proceed" intent ALREADY handles project.status
  // === "failed" correctly end to end (retryForFailedJob(), same file) — it
  // re-queues a NEW job of the SAME type against the SAME project, which the
  // worker's existing cache machinery (project-id-scoped, not job-id-scoped)
  // picks up correctly. The only missing piece was a UI path to reach it
  // without the user having to know to type "continue" (not "again" — the
  // more natural "render again" is vetoed by lib/intent.ts's REDO_RE) into
  // the chat panel instead of clicking the one visible button.
  function continueFailedRender() {
    if (!pid.current || resuming) return;
    setResuming(true);
    post(`/api/projects/${pid.current}/chat`, { content: "continue" })
      .then((d: { acted?: boolean; messages?: { content: string }[] }) => {
        if (d?.acted) { resume(); return; }
        // Nothing was actually queued (e.g. no job on record for this
        // project to retry from) — surface the assistant's own explanation
        // rather than silently flipping to the working/polling screen with
        // nothing actually running.
        const last = d?.messages?.[d.messages.length - 1];
        setErr(last?.content || "Couldn't continue this render — try Start over instead.");
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setResuming(false));
  }

  // ---- breakdown review actions ----
  // "MM:SS" / "HH:MM:SS" — must match ai-film-pro's compiler.ts formatTimecode()
  // exactly, since these are the SAME numbers shown before and after a free edit.
  function formatTimecode(totalSeconds: number): string {
    const whole = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const sec = whole % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  // Re-derives timecodeStart/timecodeEnd for the WHOLE list after any edit.
  // The server's "update" action (see confirmBreakdown()) is a free PATCH with
  // no recompile — without this, editing shot 3's length would silently leave
  // every later shot's displayed timecode wrong until the next paid regen,
  // exactly the kind of stale, confusing number this feature exists to avoid.
  function recomputeTimecodes(shots: Shot[]): Shot[] {
    let elapsed = 0;
    return shots.map((s) => {
      const onScreen = (typeof s.screenSeconds === "number" && s.screenSeconds > 0) ? s.screenSeconds : (s.duration ?? 0);
      const timecodeStart = formatTimecode(elapsed);
      elapsed += onScreen;
      const timecodeEnd = formatTimecode(elapsed);
      return { ...s, timecodeStart, timecodeEnd };
    });
  }
  function editShot(i: number, field: keyof Shot, value: string) {
    if (!breakdown) return;
    const shots = breakdown.shots.map((s, k) => {
      if (k !== i) return s;
      if (field === "duration") {
        // A manual "Seconds" edit means "make this shot exactly this long" —
        // it supersedes whatever rapid-cut trim the AI planned for this one
        // shot (this UI has no separate control for the trim target itself),
        // so screenSeconds moves together with duration rather than going
        // stale and silently keeping an old, now-irrelevant trim value.
        const n = Number(value);
        return { ...s, duration: n, screenSeconds: n };
      }
      return { ...s, [field]: value };
    });
    setBreakdown({ ...breakdown, shots: recomputeTimecodes(shots) });
  }
  // ---- song review ----
  async function confirmSongBreakdown() {
    if (!visualTheme.trim() || songBusy) return;
    setSongBusy(true);
    try {
      setPhase("working"); setStage("Planning your visuals");
      await post(`/api/projects/${pid.current}/song`, { action: "confirmBreakdown", visualTheme: visualTheme.trim(), performerAppearance: performerAppearance.trim() || undefined });
      resume();
    } catch (e) { setErr((e as Error).message); setPhase("error"); } finally { setSongBusy(false); }
  }
  async function regenerateSong() {
    if (songBusy) return;
    setSongBusy(true);
    try {
      setPhase("working"); setStage("Writing a new song");
      await post(`/api/projects/${pid.current}/song`, { action: "regenerate" });
      resume();
    } catch (e) { setErr((e as Error).message); setPhase("error"); } finally { setSongBusy(false); }
  }

  async function regenAll() { try { setPhase("working"); setStage("Rewriting the whole breakdown"); await post(`/api/projects/${pid.current}/breakdown`, { action: "regenerate" }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); } }
  async function regenShot(i: number) { try { setPhase("working"); setStage(`Rewriting shot ${i + 1}`); await post(`/api/projects/${pid.current}/breakdown`, { action: "regenShot", index: i }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); } }
  async function confirmBreakdown() {
    try {
      if (breakdown) await post(`/api/projects/${pid.current}/breakdown`, { action: "update", shots: breakdown.shots });
      if (status === "needs_edit") {
        // Resuming from a content-refusal pause skips character options
        // entirely — RESUME_STEPS["needs_edit"] (chat/route.ts) already
        // knows to go straight back into rendering with the fixed shots.
        setPhase("working"); setStage("Picking up where that left off");
        await post(`/api/projects/${pid.current}/chat`, { content: "continue" });
      } else {
        setPhase("working"); setStage("Saving and designing characters");
        await post(`/api/projects/${pid.current}/breakdown`, { action: "confirm" });
      }
      resume();
    } catch (e) { setErr((e as Error).message); setPhase("error"); }
  }

  // ---- character select ----
  // locationOptions can legitimately be empty (a film whose breakdown never
  // resolved a locationId at all) — unlike options, its own presence is NOT
  // required, only that every location IT DOES have gets a pick (vacuously
  // true when there are none).
  // CONFIRMED REAL GAP, FIXED: `Object.keys(options).length > 0` assumed
  // every project has character options — but a product-only ad (no
  // character images, breakdown.characters []) legitimately has NONE, which
  // left the continue button permanently disabled on the select screen.
  // Require at least ONE thing to pick (characters or locations), then that
  // everything present has a pick.
  const allPicked =
    (Object.keys(options).length > 0 || Object.keys(locationOptions).length > 0) &&
    Object.keys(options).every((cid) => selection[cid] !== undefined) &&
    Object.keys(locationOptions).every((lid) => locationSelection[lid] !== undefined);
  async function createShots() { try { setPhase("working"); setStage("Starting generation"); await post(`/api/projects/${pid.current}/select`, { selection, locationSelection }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); } }
  function regenChar() {
    // AD MODE — the note the user types here is applied to the SCENE as well
    // as any character (worker.ts handleOptions folds it into every shot's
    // setting for type "ad"), so the wording invites scenery/background
    // changes instead of only character ones. Every other mode keeps the
    // character-only wording — there the note only ever touches appearance.
    const isAd = projType === "ad";
    setDialog({
      title: isAd ? "Regenerate the ad visuals" : "Regenerate the character",
      body: isAd
        ? "Describe what should change — the setting, the background, or the character. Your note is applied to the whole ad, so the new images and every later shot pick it up."
        : "Describe what should change, or leave it blank for a fresh take.",
      placeholder: isAd ? "e.g. set it in a garden full of roses and lilies" : "e.g. older, black hair, wearing a red jacket",
      confirmLabel: "Regenerate",
      allowEmpty: true,
      onConfirm: async (note) => {
        try {
          setPhase("working");
          setStage(note ? (isAd ? "Redesigning the ad with your changes" : "Redesigning the character with your changes") : (isAd ? "Designing a fresh look" : "Designing a new character"));
          await post(`/api/projects/${pid.current}/options`, { action: "regenerate", note });
          resume();
        } catch (e) { setErr((e as Error).message); setPhase("error"); }
      },
    });
  }

  // ---- keyframes review ----
  function regenKeyframe(id: string) {
    setDialog({
      title: "Regenerate this keyframe",
      body: "Describe what should change, or leave it blank for a fresh take.",
      placeholder: "e.g. make it nighttime, remove the background people",
      confirmLabel: "Repaint keyframe",
      allowEmpty: true,
      onConfirm: async (note) => {
        try { setPhase("working"); setStage(note ? "Repainting with your changes" : "Repainting that keyframe"); await post(`/api/projects/${pid.current}/keyframes`, { action: "regenKeyframe", id, note }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); }
      },
    });
  }
  async function approveKeyframes() {
    // CONFIRMED REAL GAP, FIXED: flaggedOnly is shared, unscoped state between
    // this screen and the clips screen below. Without resetting it here, a
    // user who filtered to "flagged only" on the keyframes screen could land
    // on clips_review with the SAME filter still on — if the resulting clips
    // happen to have zero flags, `visible` filters to an empty list and the
    // "show all" toggle only exists inside the flagged-count banner, which
    // also doesn't render with zero flags — a dead-end blank screen.
    setFlaggedOnly(false);
    try { setPhase("working"); setStage("Filming the clips"); await post(`/api/projects/${pid.current}/keyframes`, { action: "approveAll" }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); }
  }

  // ---- clips review ----
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= clips.length) return;
    const next = clips.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setClips(next);
  }
  function regenClip(id: string) {
    setDialog({
      title: "Regenerate this clip",
      body: "Describe what should change, or leave it blank for a fresh take.",
      placeholder: "e.g. make it nighttime, remove the background people",
      confirmLabel: "Re-film clip",
      allowEmpty: true,
      onConfirm: async (note) => {
        try { setPhase("working"); setStage(note ? "Re-filming with your changes" : "Re-filming that clip"); await post(`/api/projects/${pid.current}/clips`, { action: "regenClip", id, note }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); }
      },
    });
  }
  function deleteShot(id: string, label: string) {
    setDialog({
      title: "Delete this shot?",
      body: `"${label}" will be removed from the film — everything else stays. This can't be undone. Free, no credit charged.`,
      confirmLabel: "Delete shot",
      danger: true,
      onConfirm: async () => {
        try { setPhase("working"); setStage("Removing that shot"); await post(`/api/projects/${pid.current}/clips`, { action: "deleteShot", id }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); }
      },
    });
  }
  // afterId=null inserts at the very start; afterId=<last clip id> inserts at the end.
  function insertShot(afterId: string | null) {
    setDialog({
      title: "Insert a new shot",
      body: "Describe what happens in the new shot — it'll be written and filmed to fit right where you're inserting it. Costs 1 credit.",
      placeholder: "e.g. a close-up of her hands trembling as she opens the letter",
      confirmLabel: "Insert shot (1 credit)",
      onConfirm: async (prompt) => {
        try { setPhase("working"); setStage("Writing and filming the new shot"); await post(`/api/projects/${pid.current}/clips`, { action: "insertShot", afterId, prompt }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); }
      },
    });
  }
  async function assemble() { try { setPhase("working"); setStage("Stitching your film"); await post(`/api/projects/${pid.current}/clips`, { action: "assemble", order: clips.map((c) => c.id) }); resume(); } catch (e) { setErr((e as Error).message); setPhase("error"); } }
  async function reopenClips() { try { await post(`/api/projects/${pid.current}/clips`, { action: "reopen" }); setPhase("clips"); } catch (e) { setErr((e as Error).message); } }

  function reset() {
    stopPoll(); onTitle?.(""); setPhase("idle"); setScript(""); setProjectId(null); pid.current = null;
    setBreakdown(null); setOptions({}); setSelection({}); setLocationOptions({}); setLocationSelection({}); setKeyframes([]); setClips([]); setFilm(null); setErr(""); setProgress(5); setFlaggedOnly(false);
    setSong(null); setVisualTheme(""); setPerformerAppearance("");
    // A resumed instance has no meaningful "idle" screen to fall back to —
    // there's no script composer for an existing project — so hand control
    // back to whoever opened it instead of showing one anyway.
    if (resumeProjectId) onExit?.();
  }

  // ===================== RENDER =====================
  // Split into an inner function so the actual component return (below) can
  // wrap whichever phase screen is showing with the persistent chat panel —
  // available at every phase once a project exists, new or resumed alike.
  function renderPhase() {
  if (phase === "idle") {
    return (
      <div className="np fadein">
        <img src="/safa-symbol.png" alt="safa" className="np-symbol" />
        <h1>{greeting}, {firstName}</h1>
        <p className="lead">What story should we bring to life today?</p>
        <div className="composer">
          <div className="ta-wrap">
            <textarea ref={taRef} value={script} onChange={(e) => { setScript(e.target.value); if (wrote) setWrote(false); }} disabled={expanding || enriching}
              placeholder={
                mode === "song" ? "Describe the theme or mood for your song — e.g. a bittersweet farewell, a triumphant homecoming, a rainy-day heartbreak."
                : mode === "ad" ? "Describe the ad you want — e.g. \"Create a cinematic ad for this perfume\" is enough. Attach a product photo below if you have one."
                : mode === "ai" ? "Describe your idea in a sentence or two and safa will write the script for you."
                : "Describe your idea, or paste your full script"
              } />
            {expanding && (
              <div className="ai-writing" aria-live="polite">
                <span className="cf-spin" />
                <span>safa is writing your screenplay<span className="ai-dots"><i>.</i><i>.</i><i>.</i></span></span>
              </div>
            )}
            {enriching && (
              <div className="ai-writing" aria-live="polite">
                <span className="cf-spin" />
                <span>safa is making your script more cinematic<span className="ai-dots"><i>.</i><i>.</i><i>.</i></span></span>
              </div>
            )}
            <div className="attach-bar">
              {/* Product photo: not a song-video concept (no product being
                  advertised), so still scoped to every OTHER mode. */}
              {mode !== "song" && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    onChange={onPickFiles}
                    style={{ display: "none" }}
                  />
                  <button
                    type="button"
                    className="attach-chip"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading || productImages.length >= 4}
                    title="Attach a product photo — for making ads"
                    aria-label="Attach product photo"
                  >
                    {uploading
                      ? <span className="cf-spin" />
                      : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>}
                    {productImages.length ? `Product photo (${productImages.length})` : "Product photo"}
                  </button>
                  {productImages.map((url) => (
                    <div key={url} className="pt">
                      <img src={url} alt="product" />
                      <button type="button" onClick={() => removeProductImage(url)} aria-label="Remove image">×</button>
                    </div>
                  ))}
                </>
              )}
              {/* Character photo: your own reference photo for a character —
                  skips AI-generated look options for them at casting time.
                  Available in every mode, including song video (the
                  performer). */}
              <input
                ref={charFileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={onPickCharacterFiles}
                style={{ display: "none" }}
              />
              <button
                type="button"
                className="attach-chip"
                onClick={() => charFileRef.current?.click()}
                disabled={charUploading || characterImages.length >= 4}
                title="Attach your own photo for a character — skips AI-generated look options for them"
                aria-label="Attach character photo"
              >
                {charUploading
                  ? <span className="cf-spin" />
                  : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>}
                {characterImages.length ? `Character photo (${characterImages.length})` : "Character photo"}
              </button>
              {characterImages.map((url) => (
                <div key={url} className="pt">
                  <img src={url} alt="character" />
                  <button type="button" onClick={() => removeCharacterImage(url)} aria-label="Remove image">×</button>
                </div>
              ))}
              {/* My characters: reuse a character saved from a past project
                  (see the char-modal's "Save to my characters" button) —
                  only its photo carries over, matched into characterImages
                  the same way a fresh upload already is. */}
              <div style={{ position: "relative", display: "inline-block" }}>
                <button
                  type="button"
                  className="attach-chip"
                  onClick={openCharPicker}
                  title="Reuse a character you've saved from a past project"
                  aria-label="My characters"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.5-7 8-7s8 3 8 7" /></svg>
                  My characters
                </button>
                {charPickerOpen && (
                  <div
                    style={{
                      position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 20,
                      minWidth: 220, maxHeight: 260, overflowY: "auto",
                      background: "#fff", border: "1.5px solid var(--line, #e6ddd0)", borderRadius: 12,
                      boxShadow: "0 12px 30px rgba(80,40,25,.18)", padding: 8,
                    }}
                  >
                    {!savedCharsLoaded ? (
                      <div style={{ padding: "8px 6px", fontSize: 13, color: "var(--ink-soft, #6b5a4f)" }}>Loading…</div>
                    ) : savedCharacters.length === 0 ? (
                      <div style={{ padding: "8px 6px", fontSize: 13, color: "var(--ink-soft, #6b5a4f)" }}>
                        Nothing saved yet — save a character from a finished project first.
                      </div>
                    ) : (
                      <>
                        <div style={{ padding: "2px 6px 8px", fontSize: 11.5, color: "var(--ink-soft, #6b5a4f)" }}>
                          Matched in the order you attach them — only the photo carries over.
                        </div>
                        {savedCharacters.map((c) => (
                          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 8 }}>
                            <button
                              type="button"
                              onClick={() => pickSavedCharacter(c.referenceImageUrl)}
                              disabled={characterImages.length >= 4 || characterImages.includes(c.referenceImageUrl)}
                              style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
                            >
                              <img src={c.referenceImageUrl} alt={c.name} style={{ width: 30, height: 30, borderRadius: "50%", objectFit: "cover", flex: "none" }} />
                              <span style={{ fontSize: 13.5, color: "#2C211C", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {characterImages.includes(c.referenceImageUrl) ? `${c.name} (added)` : c.name}
                              </span>
                            </button>
                            <button type="button" onClick={() => deleteSavedCharacter(c.id)} aria-label={`Delete ${c.name}`} style={{ background: "none", border: "none", color: "var(--ink-soft, #6b5a4f)", cursor: "pointer", fontSize: 16, lineHeight: 1, flex: "none" }}>×</button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="composer-row">
            <div className="seg">
              <button className={mode === "script" ? "on" : ""} onClick={() => setMode("script")} disabled={expanding}>Use my script</button>
              <button className={mode === "ai" ? "on" : ""} onClick={() => setMode("ai")} disabled={expanding}>Write it with AI</button>
              <button className={mode === "song" ? "on" : ""} onClick={() => setMode("song")} disabled={expanding}>Song video</button>
              <button className={mode === "ad" ? "on" : ""} onClick={() => setMode("ad")} disabled={expanding}>Advertisement</button>
            </div>
            <div className="dur"><span>Length</span>
              {customLen ? (
                <span className="durcustom">
                  <input
                    type="number" min={0} max={10} value={Math.floor(secs / 60)} aria-label="Minutes"
                    onChange={(e) => setSecs(Math.max(5, Math.min(10, Math.max(0, Number(e.target.value) || 0)) * 60 + (secs % 60)))}
                  />
                  <span>min</span>
                  <input
                    type="number" min={0} max={59} value={secs % 60} aria-label="Seconds"
                    onChange={(e) => setSecs(Math.max(5, Math.floor(secs / 60) * 60 + Math.min(59, Math.max(0, Number(e.target.value) || 0))))}
                  />
                  <span>sec</span>
                </span>
              ) : (
                <>
                  <input
                    type="range"
                    className="durslide"
                    min={10}
                    max={60}
                    step={5}
                    value={Math.min(60, Math.max(10, secs))}
                    aria-label="Film length in seconds"
                    aria-valuetext={fmtSecs(secs)}
                    style={{ ["--fill" as string]: `${((Math.min(60, Math.max(10, secs)) - 10) / 50) * 100}%` }}
                    onChange={(e) => setSecs(Number(e.target.value))}
                  />
                  <span className="durval">{fmtSecs(secs)}</span>
                </>
              )}
              <label className="swtch-wrap">
                <span className="swtch-lbl">Custom</span>
                <input type="checkbox" className="swtch-input" checked={customLen} onChange={toggleCustomLen} aria-label="Custom length" />
                <span className="swtch" aria-hidden="true" />
              </label>
            </div>
            {mode === "ai" ? (
              <button className="go" onClick={expandIdea} disabled={script.trim().length < 8 || expanding} style={{ opacity: script.trim().length < 8 ? 0.5 : 1 }}>
                {expanding ? <span className="cf-spin-w" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}{expanding ? "Writing your script" : "Write my script"}
              </button>
            ) : mode === "song" ? (
              <button className="go" onClick={start} disabled={script.trim().length < MIN_SCRIPT || script.length > MAX_SCRIPT} style={{ opacity: script.trim().length < MIN_SCRIPT ? 0.5 : 1 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>Generate song
              </button>
            ) : mode === "ad" ? (
              <button className="go" onClick={start} disabled={script.trim().length < AD_MIN_SCRIPT || script.length > MAX_SCRIPT} style={{ opacity: script.trim().length < AD_MIN_SCRIPT ? 0.5 : 1 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>Generate ad
              </button>
            ) : (
              <>
                <button
                  className="tb-btn"
                  onClick={enrichScript}
                  disabled={script.trim().length < MIN_SCRIPT || enriching}
                  style={{ opacity: script.trim().length < MIN_SCRIPT ? 0.5 : 1 }}
                  title="Add dialogue, write out any referenced notes/letters in full, and pace it to your target length — you'll review the result before generating."
                >
                  {enriching ? <span className="cf-spin-w" /> : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 4.9L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9L12 3z" /></svg>}
                  {enriching ? "Making it cinematic" : "Make it cinematic"}
                </button>
                <button className="go" onClick={start} disabled={script.trim().length < MIN_SCRIPT || script.length > MAX_SCRIPT} style={{ opacity: script.trim().length < MIN_SCRIPT ? 0.5 : 1 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>Generate
                </button>
              </>
            )}
          </div>
          <div className="render-row">
            <div className="rr-group">
              <span className="rr-lbl">Format</span>
              <div className="rr-seg">
                <button className={aspect === "16:9" ? "on" : ""} onClick={() => setAspect("16:9")} type="button" title="Landscape">Landscape</button>
                <button className={aspect === "9:16" ? "on" : ""} onClick={() => setAspect("9:16")} type="button" title="Portrait">Portrait</button>
                <button className={aspect === "1:1" ? "on" : ""} onClick={() => setAspect("1:1")} type="button" title="Square">Square</button>
              </div>
            </div>
            <div className="rr-group">
              <span className="rr-lbl">Resolution</span>
              <div className="rr-seg">
                <button className={resolution === "480p" ? "on" : ""} onClick={() => setResolution("480p")} type="button" title="480p — cheapest">480p</button>
                <button className={resolution === "720p" ? "on" : ""} onClick={() => setResolution("720p")} type="button" title="720p — HD, AI-upscaled for enhanced detail">720p</button>
                <button className={resolution === "1080p" ? "on" : ""} onClick={() => setResolution("1080p")} type="button" title="1080p — Full HD, AI-upscaled for enhanced detail">1080p</button>
              </div>
            </div>
            {/* Spoken-language picker removed (multilingual dubbing/lip-sync
                feature turned off product-wide — see 1-breakdown.ts and
                5-videos.ts in ai-film-pro for the backend half of this).
                `language` state is left wired to its DEFAULT_FILM_LANGUAGE
                initial value below and still flows into the create payload
                unchanged — nothing else in this component needs to change. */}
            {mode === "ad" && (
              <div className="rr-group">
                <span className="rr-lbl">Signature camera style</span>
                <div className="rr-seg rr-seg-wrap">
                  {[
                    { key: "", label: "Auto" },
                    { key: "orbit_360", label: "360° Orbit" },
                    { key: "dolly_zoom", label: "Dolly Zoom" },
                    { key: "crash_zoom_in", label: "Crash Zoom In" },
                    { key: "whip_pan", label: "Whip Pan" },
                    { key: "hero_rise", label: "Hero Rise" },
                    { key: "turntable", label: "Turntable" },
                    { key: "overhead", label: "Overhead" },
                    { key: "arc_right", label: "Arc Right" },
                    { key: "rotation_3d", label: "3D Rotation" },
                    { key: "handheld", label: "Handheld Energy" },
                    { key: "static_glam", label: "Static Glam" },
                  ].map((s) => (
                    <button
                      key={s.key || "auto"}
                      className={cameraStyle === s.key ? "on" : ""}
                      onClick={() => setCameraStyle(s.key)}
                      type="button"
                      title={s.key ? `Use "${s.label}" for this ad's signature shot` : "Let the director choose (defaults to a 360° orbit)"}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === "ad" && (
              <div className="rr-group">
                <span className="rr-lbl">Spokesperson</span>
                <div className="rr-seg">
                  <button
                    className={!(adSpokesperson || characterImages.length > 0) ? "on" : ""}
                    onClick={() => setAdSpokesperson(false)}
                    type="button"
                    disabled={characterImages.length > 0}
                    title={characterImages.length > 0 ? "Remove the attached character photo to go faceless" : "Product-only ad — no people on screen"}
                  >
                    Faceless
                  </button>
                  <button
                    className={adSpokesperson || characterImages.length > 0 ? "on" : ""}
                    onClick={() => setAdSpokesperson(true)}
                    type="button"
                    title="One shot features a person using the product — attach a Character photo to use your own, or we'll design one for you to choose at casting"
                  >
                    With a person
                  </button>
                </div>
              </div>
            )}
            <label className="rr-audio">
              <input type="checkbox" className="swtch-input" checked={audioOn} onChange={(e) => setAudioOn(e.target.checked)} aria-label="Generate audio" />
              <span className="swtch" aria-hidden="true" />
              <span className="rr-lbl">Audio</span>
            </label>
            <label className="rr-audio">
              <input type="checkbox" className="swtch-input" checked={titleCardOn} onChange={(e) => setTitleCardOn(e.target.checked)} aria-label="Title card" />
              <span className="swtch" aria-hidden="true" />
              <span className="rr-lbl">Title card</span>
            </label>
            <span className="rr-cost">{estCredits} credit{estCredits === 1 ? "" : "s"}</span>
          </div>
          {mode === "script" && wrote && (
            <div className="composer-hint" style={{ color: "var(--coral)", fontWeight: 600 }}>Your script is ready. Read it over and edit anything, then hit Generate.</div>
          )}
          {mode === "script" && script.trim().length > 0 && script.trim().length < MIN_SCRIPT && (
            <div className="composer-hint">A little more story helps. Add at least {MIN_SCRIPT - script.trim().length} more characters.</div>
          )}
          {mode === "song" && script.trim().length > 0 && script.trim().length < MIN_SCRIPT && (
            <div className="composer-hint">A little more detail helps. Add at least {MIN_SCRIPT - script.trim().length} more characters.</div>
          )}
          {mode === "ad" && script.trim().length > 0 && script.trim().length < AD_MIN_SCRIPT && (
            <div className="composer-hint">Add at least {AD_MIN_SCRIPT - script.trim().length} more character{AD_MIN_SCRIPT - script.trim().length === 1 ? "" : "s"}.</div>
          )}
          {script.length > MAX_SCRIPT - 1000 && (
            <div className="composer-hint" style={script.length > MAX_SCRIPT ? { color: "var(--coral-deep)" } : undefined}>
              {script.length.toLocaleString()} / {MAX_SCRIPT.toLocaleString()} characters{script.length > MAX_SCRIPT ? " — too long, trim it down to generate." : ""}
            </div>
          )}
        </div>
        {mode !== "song" && (
          <div className="chips" aria-label="Starter ideas">
            {(starterPrompts as { label: string; script: string }[]).map((sp) => (
              <button key={sp.label} className="chip" onClick={() => setScript(sp.script)}>{sp.label}</button>
            ))}
          </div>
        )}
        <p className="hint">
          {mode === "song"
            ? "Step 1 of 7 · You'll review the song, then the shot plan, then pick characters before anything renders."
            : "Step 1 of 6 · You'll review the shots and pick characters before anything renders."}
        </p>
      </div>
    );
  }

  if (phase === "song" && song) {
    return (
      <div className="cf fadein">
        <div className="section-h">{song.lyrics.title || "Your song"}</div>
        <div className="section-sub">Listen to what safa wrote. Happy with it, or want a different take? Then describe how it should look on screen.</div>
        <ErrorNotice notice={notice} onDismiss={() => setNotice(null)} />
        <audio controls src={song.song.url} style={{ width: "100%", marginBottom: 16 }} />
        <div className="shot-card">
          {song.lyrics.sections.map((sec, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              {sec.tag && <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.6, marginBottom: 4 }}>{sec.tag}</div>}
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{sec.lyrics}</div>
            </div>
          ))}
        </div>
        <div className="shot-card">
          <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>Visual theme <span style={{ fontWeight: 400, opacity: 0.7 }}>(required)</span></label>
          <textarea
            className="shot-desc"
            placeholder="e.g. a lone dancer in an empty rain-soaked city, neon reflections, slow motion"
            value={visualTheme}
            onChange={(e) => setVisualTheme(e.target.value)}
          />
          <label style={{ display: "block", fontWeight: 600, margin: "12px 0 6px" }}>Performer appearance <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional — leave blank for no performer on screen)</span></label>
          <textarea
            className="shot-desc"
            placeholder="e.g. woman in her 20s, curly dark hair, wearing a red coat"
            value={performerAppearance}
            onChange={(e) => setPerformerAppearance(e.target.value)}
          />
        </div>
        <div className="cf-actions">
          <button className="tb-btn" onClick={regenerateSong} disabled={songBusy}>↻ Try a different song</button>
          <button className="go" onClick={confirmSongBreakdown} disabled={!visualTheme.trim() || songBusy}>Looks good, plan the shots →</button>
        </div>
      </div>
    );
  }

  if (phase === "breakdown" && breakdown) {
    return (
      <div className="cf fadein">
        <div className="section-h">Review your shots</div>
        <div className="section-sub">Edit any shot, regenerate one you don&apos;t like, or regenerate the whole plan. Nothing renders until you continue.</div>
        <ErrorNotice notice={notice} onDismiss={() => setNotice(null)} />
        {breakdown.shots.map((s, i) => {
          const trimmed = !!s.screenSeconds && !!s.duration && s.screenSeconds > 0 && s.screenSeconds < s.duration;
          return (
            <div className="shot-card" key={s.id}>
              <div className="shot-head">
                <span className="shot-head-left">
                  {s.timecodeStart && s.timecodeEnd && <span className="shot-time">{s.timecodeStart}–{s.timecodeEnd}</span>}
                  <span className="shot-num">Shot {i + 1}{s.scene ? ` · ${s.scene}` : ""}</span>
                </span>
                <button className="shot-regen" onClick={() => regenShot(i)}>↻ Regenerate</button>
              </div>
              {/* FULL shot text, deliberately unstripped. An earlier version showed
                  only the authored prose and hid the compiler's appended direction
                  (cast lock, continuity chain, ground contact, action mechanics).
                  That was wrong: this screen is where a user REVIEWS what the
                  render will actually be told to do, and that direction is the
                  most informative part of it — hiding it reduced a full paragraph
                  of real instruction to a single sentence. Show everything.

                  THAT PROMISE WAS ONLY HALF KEPT: "description" is mostly visual/
                  scene-setting (setting, cast lock, eyeline) — the ACTUAL per-
                  character action timeline lives in the separate "motion" field
                  (ground contact, action-library mechanics, the beat-by-beat
                  "First... then... finally..." choreography), which this screen
                  never showed at all. CONFIRMED REAL USER-FACING BUG: a reviewer
                  reading only "description" sees the environment ("pale light,
                  windows...") with no sense of what any character actually does,
                  even though 5-videos.ts's render prompt is built from BOTH
                  fields ("<description>. ... Action: <motion>."). Showing motion
                  here too is what actually makes "review what will render" true. */}
              <div className="shot-field-label">Description &amp; setting</div>
              <textarea className="shot-desc" value={s.description} onChange={(e) => editShot(i, "description", e.target.value)} />
              <div className="shot-field-label">What each character does</div>
              <textarea className="shot-desc" value={(s.motion as string) || ""} onChange={(e) => editShot(i, "motion", e.target.value)} />
              <div className="shot-meta">
                <label>Seconds <input type="number" min={2} max={12} value={s.duration ?? 6} onChange={(e) => editShot(i, "duration", e.target.value)} /></label>
                {("dialogue" in s) && <input className="shot-dlg" placeholder="Dialogue (optional)" value={(s.dialogue as string) || ""} onChange={(e) => editShot(i, "dialogue", e.target.value)} />}
                {trimmed && <span className="shot-trim-note" title={`Rendered at ${s.duration}s, kept to the first ${s.screenSeconds}s for a rapid cut`}>⚡ rapid cut</span>}
              </div>
            </div>
          );
        })}
        <div className="cf-actions">
          <button className="tb-btn" onClick={regenAll}>↻ Regenerate all shots</button>
          <button className="go" onClick={confirmBreakdown}>Looks good, continue</button>
        </div>
      </div>
    );
  }

  if (phase === "select") {
    const single = Object.values(options).every((c) => c.options.length === 1);
    // A product-only ad has NO character options at all — hide the character
    // section entirely instead of rendering an empty "Meet your character"
    // heading above the backdrop picker.
    const hasChars = Object.keys(options).length > 0;
    return (
      <div className="cf fadein">
        {hasChars && (
          <>
            <div className="section-h">{projType === "ad" ? "Choose your spokesperson" : single ? "Meet your character" : "Choose your character"}</div>
            <div className="section-sub">{projType === "ad"
              ? "Pick the person who appears in your ad."
              : single ? "This is who'll appear in every shot. Happy with it, or want a different one?" : "Pick one look for each character. This becomes the person in every shot."}</div>
          </>
        )}
        <ErrorNotice notice={notice} onDismiss={() => setNotice(null)} />
        {Object.entries(options).map(([cid, c]) => (
          <div className="cf-char" key={cid}>
            <div className="cf-cn">{c.name}</div>
            <div className="cf-opts">
              {c.options.map((url, i) => (
                <button key={i} className={`cf-opt ${selection[cid] === i ? "sel" : ""}`} onClick={() => setSelection({ ...selection, [cid]: i })}>
                  <img src={url} alt={`${c.name} option ${i + 1}`} />
                </button>
              ))}
            </div>
          </div>
        ))}
        {Object.keys(locationOptions).length > 0 && (
          <>
            <div className="section-h" style={{ marginTop: 28 }}>
              {projType === "ad"
                ? "Choose your backdrop"
                : Object.values(locationOptions).every((c) => c.options.length === 1) ? "Meet your location" : "Choose your location"}
            </div>
            <div className="section-sub">{projType === "ad"
              ? "Pick the one backdrop for your ad — every shot is filmed against it."
              : "Pick one look for each place in the story. This becomes that location in every shot there."}</div>
            {Object.entries(locationOptions).map(([lid, l]) => (
              <div className="cf-char" key={lid}>
                <div className="cf-cn">{l.name}</div>
                <div className="cf-opts">
                  {l.options.map((url, i) => (
                    <button key={i} className={`cf-opt ${locationSelection[lid] === i ? "sel" : ""}`} onClick={() => setLocationSelection({ ...locationSelection, [lid]: i })}>
                      <img src={url} alt={`${l.name} option ${i + 1}`} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
        <div className="cf-actions">
          <button className="tb-btn" onClick={regenChar}>↻ {projType === "ad" ? "Regenerate the visuals" : `Regenerate ${single ? "character" : "characters"}`}</button>
          <button className="go" disabled={!allPicked} onClick={createShots} style={{ opacity: allPicked ? 1 : 0.5 }}>{hasChars && single ? "Use this character →" : "Generate the shots →"}</button>
        </div>
        <Dialog spec={dialog} onClose={() => setDialog(null)} />
      </div>
    );
  }

  if (phase === "keyframes") {
    // Same "flagged, filterable" pattern as the clips screen below, one stage
    // earlier — see #4 in the long-form consistency plan. No reorder/delete/
    // insert here: shots aren't being restructured at this stage, just
    // reviewed before the expensive clip-rendering step spends real money on them.
    const flaggedCount = keyframes.filter((k) => k.flagged).length;
    const visible = keyframes.filter((k) => !flaggedOnly || k.flagged);

    return (
      <div className="cf fadein">
        <div className="section-h">Review your keyframes</div>
        <div className="section-sub">These are the still frames each clip will be filmed from. Catch a problem now, before it's animated — regenerating a keyframe is free.</div>
        <ErrorNotice notice={notice} onDismiss={() => setNotice(null)} />
        {flaggedCount > 0 && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
              margin: "8px 0 16px", borderRadius: 8, background: "rgba(230, 126, 34, 0.12)",
              border: "1px solid rgba(230, 126, 34, 0.4)",
            }}
          >
            <span>🚩 {flaggedCount} of {keyframes.length} keyframe{keyframes.length === 1 ? "" : "s"} flagged for review — our automatic checks couldn't fully fix these, worth a look before you film the clips.</span>
            <button className="shot-regen" onClick={() => setFlaggedOnly((v) => !v)} style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
              {flaggedOnly ? "Show all keyframes" : "Show only flagged"}
            </button>
          </div>
        )}
        {visible.map((k, i) => (
          <div
            key={k.id}
            className="clip-row"
            style={k.flagged ? { borderLeft: "4px solid #e67e22", background: "rgba(230, 126, 34, 0.06)" } : undefined}
          >
            <div className="clip-order"><span>{i + 1}</span></div>
            <img className="clip-vid" src={k.url} alt={k.label} style={{ objectFit: "cover" }} />
            <div className="clip-info">
              <div className="clip-label">
                {k.flagged && <span title={k.flagReason} style={{ color: "#e67e22", fontWeight: 600, marginRight: 6 }}>🚩 Flagged</span>}
                {k.label}
              </div>
              {k.flagged && k.flagReason && (
                <div style={{ fontSize: 13, color: "#b35a00", marginBottom: 4 }}>{k.flagReason}</div>
              )}
              <button className="shot-regen" onClick={() => regenKeyframe(k.id)}>↻ Regenerate keyframe</button>
            </div>
          </div>
        ))}
        <div className="cf-actions">
          <button className="go" onClick={approveKeyframes}>Looks good, film the clips →</button>
        </div>
        <Dialog spec={dialog} onClose={() => setDialog(null)} />
      </div>
    );
  }

  if (phase === "clips") {
    // Which of possibly hundreds of clips actually need a look — see #4 in
    // the long-form consistency plan. Filter AFTER pairing each clip with its
    // ORIGINAL index, since move()/regenClip() operate on the full clips
    // array's indices, not the filtered view's.
    const flaggedCount = clips.filter((c) => c.flagged).length;
    const visible = clips
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !flaggedOnly || c.flagged);

    return (
      <div className="cf fadein">
        <div className="section-h">Review &amp; order your clips</div>
        <div className="section-sub">Drag order with the arrows, regenerate any clip, then stitch them into the final film.</div>
        <ErrorNotice notice={notice} onDismiss={() => setNotice(null)} />
        {flaggedCount > 0 && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
              margin: "8px 0 16px", borderRadius: 8, background: "rgba(230, 126, 34, 0.12)",
              border: "1px solid rgba(230, 126, 34, 0.4)",
            }}
          >
            <span>🚩 {flaggedCount} of {clips.length} clip{clips.length === 1 ? "" : "s"} flagged for review — our automatic checks couldn't fully fix these, worth a look before you assemble.</span>
            <button className="shot-regen" onClick={() => setFlaggedOnly((v) => !v)} style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
              {flaggedOnly ? "Show all clips" : "Show only flagged"}
            </button>
          </div>
        )}
        <button className="tb-btn" style={{ marginBottom: 10 }} onClick={() => insertShot(null)}>+ Insert shot at the start</button>
        {visible.map(({ c, i }) => (
          <div key={c.id}>
            <div
              className="clip-row"
              style={c.flagged ? { borderLeft: "4px solid #e67e22", background: "rgba(230, 126, 34, 0.06)" } : undefined}
            >
              <div className="clip-order">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move clip ${i + 1} up`}>▲</button>
                <span>{i + 1}</span>
                <button onClick={() => move(i, 1)} disabled={i === clips.length - 1} aria-label={`Move clip ${i + 1} down`}>▼</button>
              </div>
              <video className="clip-vid" src={c.url} controls preload="metadata" />
              <div className="clip-info">
                <div className="clip-label">
                  {c.flagged && <span title={c.flagReason} style={{ color: "#e67e22", fontWeight: 600, marginRight: 6 }}>🚩 Flagged</span>}
                  {c.label}
                </div>
                {c.flagged && c.flagReason && (
                  <div style={{ fontSize: 13, color: "#b35a00", marginBottom: 4 }}>{c.flagReason}</div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="shot-regen" onClick={() => regenClip(c.id)}>↻ Regenerate clip</button>
                  <button
                    className="shot-regen"
                    style={{ color: "var(--coral-deep, #c0392b)" }}
                    onClick={() => deleteShot(c.id, c.label)}
                    disabled={clips.length <= 1}
                    title={clips.length <= 1 ? "A film needs at least one shot" : undefined}
                  >
                    ✕ Delete shot
                  </button>
                </div>
              </div>
            </div>
            <button className="tb-btn" style={{ margin: "6px 0 10px" }} onClick={() => insertShot(c.id)}>+ Insert shot here</button>
          </div>
        ))}
        <div className="cf-actions">
          <button className="go" onClick={assemble}>Stitch final film →</button>
        </div>
        <Dialog spec={dialog} onClose={() => setDialog(null)} />
      </div>
    );
  }

  if (phase === "done" && film) {
    return (
      <div className="cf fadein" style={{ maxWidth: 760 }}>
        <div className="section-h">Your film is ready</div>
        <video className="cf-video" src={film} controls />
        <div className="cf-actions">
          <a className="go" href={film} download>Download</a>
          <button className="tb-btn" onClick={reopenClips}>Not happy? Re-edit clips</button>
          <button className="tb-btn" onClick={reset}>Make another</button>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="cf fadein" style={{ maxWidth: 600 }}>
        <div className="cf-err">Something went wrong: {err}</div>
        <p className="hint">
          If the cause is fixed now (e.g. a billing/provider issue), Continue picks back up from
          whatever already finished rendering — it does not start over from the beginning.
        </p>
        <div className="cf-actions" style={{ marginTop: 14 }}>
          <button className="go" onClick={continueFailedRender} disabled={resuming}>
            {resuming ? "Continuing…" : "▶ Continue"}
          </button>
          <button className="tb-btn" onClick={reset}>Start over</button>
        </div>
      </div>
    );
  }

  // PAUSED — the worker's own render loop hit a checkpoint after cancelRequested
  // was set and stopped itself, mid-way through (see cancel/route.ts's comment on
  // why this isn't instant). Nothing already rendered is lost: clips bank the
  // instant each one finishes, and the keyframe pass now banks whatever's on disk
  // no matter how it exits — Resume just re-queues the same job and the worker's
  // own caching skips everything already done.
  if (jobStatus === "cancelled") {
    return (
      <div className="cf fadein cf-working">
        <img src="/safa-symbol.png" alt="" className="cfw-symbol" />
        <div className="cfw-row">
          <div className="cf-stage">⏸ Paused</div>
        </div>
        <div className="cf-bar"><i style={{ width: `${progress}%` }} /></div>
        <p className="hint">
          Stopped at your request. Nothing already rendered was lost — Resume picks up right where this left off.
        </p>
        <button className="go" style={{ marginTop: 14 }} onClick={resumeGeneration} disabled={resuming}>
          {resuming ? "Resuming…" : "▶ Resume"}
        </button>
      </div>
    );
  }

  // working / generating
  // Matches cancel/route.ts's CANCELLABLE_TYPES exactly — regen_keyframe/
  // regen_clip included because those single-shot regens are the ORIGINAL
  // reported case of a run silently taking 90 minutes, not just the two main
  // render phases.
  const stoppable = jobType === "shots" || jobType === "render_clips" || jobType === "regen_keyframe" || jobType === "regen_clip";
  return (
    <div className="cf fadein cf-working">
      <img src="/safa-symbol.png" alt="" className="cfw-symbol" />
      <div className="cfw-row">
        <div className="cf-stage"><span className="cf-spin" />{stage}</div>
        <span className="cfw-pct">{Math.round(progress)}%</span>
      </div>
      <div className="cf-bar"><i style={{ width: `${progress}%` }} /></div>
      <p className="cf-elapsed">{fmtElapsed(elapsed)} elapsed</p>
      <p className="hint">You can leave this page. Generation keeps running in the background.</p>
      {stalled && <p className="hint">Video rendering takes a few minutes. Everything is still running.</p>}
      {stoppable && (
        <button className="tb-btn" style={{ marginTop: 14 }} onClick={stopGeneration} disabled={stopping}>
          {stopping ? "Stopping…" : "⏸ Stop"}
        </button>
      )}
    </div>
  );
  }

  // "Film so far" — a persistent, read-only recap of every stage already
  // completed: script -> characters -> shots -> clips. The old sidebar view
  // (removed when this became a single-column resumable flow) used to show
  // all of this stacked on one page; the phase wizard replaced by this file
  // shows exactly ONE screen at a time and discards the rest, so a project
  // resumed straight into "done" showed nothing but the final video — the
  // script, the characters, and the shot breakdown were simply never
  // fetched (see pollStatus()'s unconditional-capture fix above) or shown
  // anywhere once phase moved on. Each section below only renders once it
  // has real data, and is skipped while it's ALSO the current phase's own
  // interactive screen (no point showing a read-only shot list directly on
  // top of the editable one renderPhase() is already showing).
  function renderRecap() {
    if (!projectId) return null;
    const sections: React.ReactNode[] = [];

    if (script.trim() && phase !== "idle") {
      sections.push(
        <div className="pd-block" key="script">
          <div className="pd-h">Your script</div>
          <pre className="pd-script">{script}</pre>
        </div>,
      );
    }

    const charEntries = Object.entries(options);
    if (charEntries.length > 0 && phase !== "select") {
      sections.push(
        <div className="pd-block" key="characters">
          <div className="pd-h">Characters</div>
          <div className="cf-recap-chars">
            {charEntries.map(([cid, c]) => {
              const url = c.options[selection[cid] ?? 0] ?? c.options[0];
              return (
                <div
                  className="cf-recap-char"
                  key={cid}
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedCharId(cid)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedCharId(cid); } }}
                  aria-label={`View ${c.name}'s full photo and description`}
                >
                  {url && <img src={url} alt={c.name} />}
                  <span>{c.name}</span>
                </div>
              );
            })}
          </div>
        </div>,
      );
    }

    if (breakdown?.shots?.length && phase !== "breakdown") {
      sections.push(
        <div className="pd-block" key="shots">
          <div className="pd-h">Shots ({breakdown.shots.length})</div>
          <div className="pd-shots">
            {breakdown.shots.map((s, i) => (
              <div className="pd-shot" key={s.id}>
                {s.timecodeStart && s.timecodeEnd && <span className="pd-shot-time">{s.timecodeStart}–{s.timecodeEnd}</span>}
                <b>Shot {i + 1}.</b> {s.description}
                {/* "description" is mostly the visual/scene-setting half of the shot —
                    the actual per-character ACTION timeline lives in the separate
                    "motion" field (see the Shot type's own comment), and the render
                    prompt (ai-film-pro's 5-videos.ts) is built from BOTH. Omitting it
                    here meant this recap — same as the editable review screen before
                    it was fixed — could read as pure scenery with no sense of what
                    anyone in the shot actually does. */}
                {!!(s.motion as string)?.trim() && (
                  <div className="pd-shot-motion"><b>What happens:</b> {s.motion as string}</div>
                )}
              </div>
            ))}
          </div>
        </div>,
      );
    }

    if (clips.length > 0 && phase !== "clips") {
      sections.push(
        <div className="pd-block" key="clips">
          <div className="pd-h">Clips ({clips.length})</div>
          <div className="pd-clips">
            {clips.map((c) => (
              <div className="pd-clip" key={c.id}>
                <video src={`${c.url}#t=0.1`} controls preload="metadata" />
                <span>{c.label}</span>
              </div>
            ))}
          </div>
        </div>,
      );
    }

    if (!sections.length) return null;
    return <div className="cf-recap fadein">{sections}</div>;
  }

  // Character detail modal — full photo + the appearance description the
  // user/breakdown actually authored for them (breakdown.characters, keyed
  // by id — see BreakdownCharacter's own comment). Escape-to-close and
  // backdrop-click-to-close, same convention Dialog.tsx already established.
  useEffect(() => {
    if (!expandedCharId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpandedCharId(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expandedCharId]);

  const expandedChar = expandedCharId ? options[expandedCharId] : undefined;
  const expandedCharUrl = expandedChar ? (expandedChar.options[selection[expandedCharId!] ?? 0] ?? expandedChar.options[0]) : undefined;
  const expandedCharDesc = breakdown?.characters?.find((c) => c.id === expandedCharId)?.appearance;
  const expandedCharVoice = breakdown?.characters?.find((c) => c.id === expandedCharId)?.voice;

  return (
    <>
      {renderRecap()}
      {renderPhase()}
      {expandedChar && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setExpandedCharId(null); }}>
          <div className="modal char-modal" role="dialog" aria-modal="true" aria-label={`${expandedChar.name}'s photo and description`}>
            <button className="modal-close" onClick={() => setExpandedCharId(null)} aria-label="Close">×</button>
            <h3>{expandedChar.name}</h3>
            {expandedCharUrl && <img src={expandedCharUrl} alt={expandedChar.name} className="char-modal-photo" />}
            {expandedCharDesc && <p className="char-modal-desc">{expandedCharDesc}</p>}
            {expandedCharUrl && expandedCharId && (
              <button
                type="button"
                className="dlg-btn"
                disabled={savingCharId === expandedCharId || savedCharIds.has(expandedCharId)}
                onClick={() => saveCharacter(expandedCharId, expandedChar.name, expandedCharDesc || "", expandedCharVoice, expandedCharUrl)}
              >
                {savedCharIds.has(expandedCharId) ? "Saved to my characters" : savingCharId === expandedCharId ? "Saving…" : "Save to my characters"}
              </button>
            )}
          </div>
        </div>
      )}
      {projectId && <ChatPanel projectId={projectId} status={status} onActed={resume} />}
    </>
  );
}