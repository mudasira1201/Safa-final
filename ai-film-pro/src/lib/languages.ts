/**
 * SPOKEN-LANGUAGE SUPPORT for narrative films (Project.type "film").
 *
 * WHAT IS AND IS NOT TRANSLATED — the single most important rule in this
 * feature. Only `Shot.dialogue` (the words a character actually says) is
 * written in the target language. Every other field on a shot —
 * description, motion, setting, camera, lighting, startFrame/endFrame — is
 * NOT prose for a human reader, it is a PROMPT handed to the image and video
 * models, which are trained overwhelmingly on English. Translating those
 * would quietly degrade every render while looking like a feature. The same
 * goes for character `appearance`, negatives, and the compiler's own injected
 * boilerplate: English, always.
 *
 * Audio comes from the video model's native `generate_audio` (see
 * 5-videos.ts) — there is no TTS stage in this pipeline, and fal's Seedance
 * schema exposes no separate dialogue track (see mixMusicBed()'s comment in
 * util.ts). So the ONLY lever for the spoken language is the dialogue text
 * itself plus an explicit instruction naming the language in the video
 * prompt. That also means lip-sync stays correct for free: the model animates
 * the mouth for the same line it speaks, rather than a dub sliding against
 * footage rendered for another language.
 */

export interface LanguageInfo {
  /** ISO 639-1 code — the canonical form stored on Breakdown.language. */
  code: string;
  /** English name, used when instructing the LLM and the video model. */
  name: string;
  /** Endonym, for UI display. */
  native: string;
  /** Right-to-left script. Not used for audio, but load-bearing for any
   *  future burned-in subtitle work, which must not assume LTR layout. */
  rtl: boolean;
}

export const LANGUAGES: Record<string, LanguageInfo> = {
  en: { code: "en", name: "English", native: "English", rtl: false },
  hi: { code: "hi", name: "Hindi", native: "हिन्दी", rtl: false },
  kn: { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", rtl: false },
  ta: { code: "ta", name: "Tamil", native: "தமிழ்", rtl: false },
  ml: { code: "ml", name: "Malayalam", native: "മലയാളം", rtl: false },
  ur: { code: "ur", name: "Urdu", native: "اردو", rtl: true },
};

export const DEFAULT_LANGUAGE = "en";

/** Resolve a user-supplied value to a supported code. Accepts the code
 *  ("ta"), the English name ("Tamil"), or the endonym ("தமிழ்"), any case —
 *  safa-web sends the name today, but a script a user typed by hand or an
 *  older project row may carry any of the three. Unknown input returns null
 *  rather than guessing: silently falling back to English would ship a film
 *  in the wrong language, which is worse than refusing to recognise the tag. */
export function resolveLanguage(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const info of Object.values(LANGUAGES)) {
    if (info.code === lower || info.name.toLowerCase() === lower || info.native === raw) return info.code;
  }
  return null;
}

/** Parses the "[Language: ...]" marker safa-web folds into the script, the
 *  same bracket-tag convention as "[Target length: ...]" (parseTargetSeconds
 *  in 1-breakdown.ts) and "[Camera style: ...]". Returns null when there is
 *  no tag at all — a bare script, or any project created before this feature
 *  existed — and every caller treats that as English, i.e. exactly today's
 *  behavior. */
export function parseLanguage(script: string): string | null {
  const m = String(script || "").match(/\[Language:\s*([^\]]+)\]/i);
  return m ? resolveLanguage(m[1]) : null;
}

/** The native-script endonym for a stored code (e.g. "हिन्दी" for "hi"), for
 *  prompt text — see 5-videos.ts's languageDirective for why this is stated
 *  ALONGSIDE the English name rather than instead of it: a video model that
 *  fails to treat "in Hindi" as a real instruction may still recognise its
 *  own native name/script as a stronger signal, and the two cost nothing to
 *  say together. Falls back to English for an unrecognised code, same as
 *  languageName() below. */
export function languageNative(code: string | null | undefined): string {
  return LANGUAGES[String(code ?? "").toLowerCase()]?.native ?? LANGUAGES[DEFAULT_LANGUAGE].native;
}

/** The English name for a stored code, for prompt text. Falls back to English
 *  for an unrecognised code so a bad value can never crash a render. */
export function languageName(code: string | null | undefined): string {
  return LANGUAGES[String(code ?? "").toLowerCase()]?.name ?? LANGUAGES[DEFAULT_LANGUAGE].name;
}

/** True when a film should be planned/rendered in something other than
 *  English. The one predicate every caller should branch on, so "is this a
 *  translated film" is defined in exactly one place. */
export function isTranslated(code: string | null | undefined): boolean {
  const resolved = resolveLanguage(code);
  return resolved !== null && resolved !== DEFAULT_LANGUAGE;
}
