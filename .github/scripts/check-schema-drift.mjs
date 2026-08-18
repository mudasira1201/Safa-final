#!/usr/bin/env node
// .github/scripts/check-schema-drift.mjs
// -----------------------------------------------------------------------------
// Pre-launch ops automation — Tier 1 #5 (schema drift check), 2026-08-07.
//
// ai-film-pro and safa-web each keep their OWN prisma/schema.prisma describing
// the SAME shared Neon Postgres tables (both files' own comments already say
// this explicitly, e.g. "MIRRORS safa-web's OWN SafetyRefusal model"). There is
// no migrations directory on either side (both are `prisma db push`-only), so
// nothing has ever structurally enforced the two files staying in sync — this
// is the enforcement. Structural diff only: field names, types, and Prisma
// attributes (@id, @default, @db.Text, etc.) — NOT comments or whitespace,
// which are allowed to differ (and already do, confirmed this session: one
// stale Artifact.kind comment mismatch that isn't a real bug).
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_A = join(ROOT, "ai-film-pro", "prisma", "schema.prisma");
const SCHEMA_B = join(ROOT, "safa-web", "prisma", "schema.prisma");

/** Strips a Prisma schema down to just its `model X { ... }` blocks, each
 *  reduced to a normalized field-signature list — comments stripped, field
 *  order within a model preserved (order matters far less than presence, but
 *  keeping it deterministic makes the diff output readable either way). */
function parseModels(schemaText) {
  // Normalize CRLF -> LF FIRST — these files are Windows-edited (\r\n), and
  // JS regex's `.` never matches a line-terminator character (\r included),
  // so a trailing \r silently defeated a naive `//.*$` comment-strip
  // (confirmed by hand: 'abc // x\r'.replace(/\/\/.*$/, "") is a no-op,
  // 'abc // x'.replace(...) is not).
  //
  // Strip comments PER LINE, BEFORE model-block extraction — not after.
  // CONFIRMED REAL BUG, found testing this script against the real files:
  // safa-web's own SafetyRefusal.categories field has a comment containing a
  // literal brace ("// JSON array of {category, ambiguous, reason}"), which
  // prematurely closed the naive `model\s+(\w+)\s*\{([^}]*)\}` block regex's
  // `[^}]*` at THAT `}` instead of the model's real closing one — silently
  // truncating every field after it (reason/scriptExcerpt/createdAt and both
  // @@index lines vanished from the parse, reported as spurious "missing"
  // drift). Stripping comments first removes every comment-embedded brace
  // before the block regex ever runs, so only REAL Prisma syntax braces are
  // left to match against.
  const withoutComments = schemaText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  const models = new Map(); // name -> Map(fieldName -> normalizedSignature)
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = modelRe.exec(withoutComments))) {
    const [, name, body] = m;
    const fields = new Map();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      // A field line starts with an identifier; a block attribute line
      // starts with `@@` — both are real, structural schema content worth
      // comparing, so both are kept, just bucketed under different keys.
      const fieldMatch = line.match(/^(\w+)\s+(.+)$/);
      if (!fieldMatch) continue;
      const [, fieldName, rest] = fieldMatch;
      const key = line.startsWith("@@") ? `@@${fields.size}:${fieldName}` : fieldName;
      // Normalize internal whitespace so "String   @default" and
      // "String @default" compare equal — only REAL token differences count.
      fields.set(key, rest.replace(/\s+/g, " ").trim());
    }
    models.set(name, fields);
  }
  return models;
}

function diffModels(a, b, labelA, labelB) {
  const problems = [];
  const allNames = new Set([...a.keys(), ...b.keys()]);
  for (const name of [...allNames].sort()) {
    const fa = a.get(name);
    const fb = b.get(name);
    if (!fa) { problems.push(`model ${name}: present in ${labelB}, missing from ${labelA}`); continue; }
    if (!fb) { problems.push(`model ${name}: present in ${labelA}, missing from ${labelB}`); continue; }
    const allFields = new Set([...fa.keys(), ...fb.keys()]);
    for (const field of [...allFields].sort()) {
      const va = fa.get(field);
      const vb = fb.get(field);
      if (va === undefined) { problems.push(`model ${name}.${field}: present in ${labelB} ("${vb}"), missing from ${labelA}`); continue; }
      if (vb === undefined) { problems.push(`model ${name}.${field}: present in ${labelA} ("${va}"), missing from ${labelB}`); continue; }
      if (va !== vb) { problems.push(`model ${name}.${field}: "${va}" in ${labelA} vs "${vb}" in ${labelB}`); }
    }
  }
  return problems;
}

const textA = readFileSync(SCHEMA_A, "utf8");
const textB = readFileSync(SCHEMA_B, "utf8");
const problems = diffModels(parseModels(textA), parseModels(textB), "ai-film-pro/prisma/schema.prisma", "safa-web/prisma/schema.prisma");

if (problems.length) {
  console.error(`❌ Schema drift detected between ai-film-pro's and safa-web's schema.prisma (${problems.length} issue(s)):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nBoth files describe the SAME shared database — keep every mirrored model's fields identical on both sides.`);
  process.exit(1);
} else {
  console.log("✅ No structural schema drift between ai-film-pro and safa-web.");
}
