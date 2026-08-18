import OpenAI from "openai";
import { config } from "../config";
import { languageName, languageNative } from "../lib/languages";
import { withTimeout } from "../util";

// REAL, ALREADY-AUTHENTICATED CLIENT — same LLM_API_KEY/LLM_BASE_URL every
// other OpenAI call in this pipeline uses (see providers/llm.ts), reused
// here rather than requiring a brand-new credential. CONFIRMED REAL, not
// hypothetical: a live call (2026-08-15) with Hindi (Devanagari) input text
// returned a genuine 2.35s MP3 — this is not a guessed-at integration.
//
// WHY THIS EXISTS: Seedance's own native generate_audio does not reliably
// speak a non-English dialogue line in the requested language even with an
// explicit, emphatic prompt instruction naming the language — confirmed on
// a real Hindi render (2026-08-15) that still came back in English despite
// the strengthened languageDirective in 5-videos.ts. A real TTS engine,
// unlike an implicit side-channel of a video-diffusion model, is BUILT to
// comply with "speak this text in this language" — that's its one job — so
// it succeeds where prompt-engineering the video model could not.
//
// THE TRADE-OFF, STATED HONESTLY: this REPLACES the clip's entire audio
// track (see util.ts's muxReplaceAudio()), so the character's mouth
// movements (baked into the video by Seedance, animated for whatever it
// internally intended to say) will not match this new audio's phonetics as
// precisely as Seedance's own native, self-consistent audio+video would —
// same tension every real film dub has. Used only where correct SPOKEN
// LANGUAGE has been explicitly prioritized over lip-sync precision.
const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl, timeout: 60_000 });

const TTS_TIMEOUT_MS = 60_000;

/** Maps this pipeline's existing character voice archetypes (Character.voice
 *  — see types.ts's enum, already used for casting/performance direction
 *  elsewhere) onto OpenAI's standard TTS voice set. Only "alloy" has been
 *  REAL-TESTED directly; the rest are OpenAI's long-standing, documented
 *  voice names, mapped by best-fit gender/register — UNVERIFIED per-voice,
 *  same "tune after a real listen" discipline this codebase already applies
 *  to film grain strength and the vignette angle. "alloy" is the safe
 *  fallback for any archetype not listed (including "narrator"/"child",
 *  which have no close OpenAI-voice equivalent to guess at confidently). */
const VOICE_BY_ARCHETYPE: Record<string, string> = {
  male_young: "echo",
  male_adult: "onyx",
  male_old: "onyx",
  female_young: "nova",
  female_adult: "nova",
  female_old: "shimmer",
};

/** Synthesizes ONE line of film dialogue as speech, in the target language,
 *  returning raw MP3 bytes (caller writes/muxes it — see steps/5-videos.ts).
 *  Throws on failure; there is no safe silent fallback for a line the film
 *  explicitly needs spoken (same "no safe partial result" reasoning
 *  translateDialogue() in llm.ts already applies to the translation step
 *  this depends on). */
export async function synthesizeSpeech(
  text: string,
  archetype: string | null | undefined,
  languageCode: string,
): Promise<Buffer> {
  const voice = VOICE_BY_ARCHETYPE[archetype ?? ""] ?? "alloy";
  const res = await withTimeout(
    client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voice as any,
      input: text,
      instructions:
        `Speak naturally and fluently in ${languageName(languageCode)} (${languageNative(languageCode)}), with real, ` +
        `native ${languageName(languageCode)} pronunciation — never English, never transliterated. This is one line ` +
        `of film dialogue: deliver it with natural spoken rhythm and emotion, not a flat reading.`,
    }),
    TTS_TIMEOUT_MS,
    "TTS synthesis",
  );
  return Buffer.from(await res.arrayBuffer());
}
