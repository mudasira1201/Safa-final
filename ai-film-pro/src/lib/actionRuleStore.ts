import { prisma } from "../db";
import type { ActionRule } from "./actionLibrary";
import type { StagingRule } from "./stagingLibrary";

/**
 * Durable persistence for the action-rule inference cache — see
 * compiler.ts's actionInferenceCache (in-memory, module-level, process-
 * lifetime only) and steps/1-breakdown.ts's use of this module to check the
 * database BEFORE spending a real providers/llm.ts inferActionRule() call.
 * Deliberately kept OUT of compiler.ts itself — compileBreakdown() has no DB
 * access and must stay synchronous; this module is only ever called from the
 * async orchestration layer (1-breakdown.ts), the same place the LLM
 * inference call itself already happens.
 */

export async function loadPersistedActionRule(key: string): Promise<ActionRule | null> {
  const row = await prisma.actionRuleCache.findUnique({ where: { key } });
  if (!row) return null;
  return {
    label: row.label,
    category: row.category as ActionRule["category"],
    pattern: null,
    precondition: row.precondition as unknown as ActionRule["precondition"],
    effect: row.effect as unknown as ActionRule["effect"],
  };
}

export async function persistActionRule(key: string, rule: ActionRule): Promise<void> {
  await prisma.actionRuleCache.upsert({
    where: { key },
    create: {
      key,
      label: rule.label,
      category: rule.category,
      precondition: rule.precondition as unknown as object,
      effect: rule.effect as unknown as object,
    },
    update: {
      label: rule.label,
      category: rule.category,
      precondition: rule.precondition as unknown as object,
      effect: rule.effect as unknown as object,
    },
  });
}

/**
 * Gap B's staging-rule persistence — REUSES the same ActionRuleCache table
 * above rather than a new model/migration (explicitly requested): a
 * "staging:" key prefix keeps this family's keys from ever colliding with
 * action-rule keys in the same table, `category` is fixed to "staging" for
 * easy identification, and the RegExp pair (which can't be stored as JSON
 * directly) is serialized to its .source strings inside the `precondition`
 * column — `effect` is unused for this family, stored as an empty array.
 */
function stagingCacheKey(sceneKey: string): string {
  return `staging:${sceneKey}`;
}

export async function loadPersistedStagingRule(sceneKey: string): Promise<StagingRule | null> {
  const row = await prisma.actionRuleCache.findUnique({ where: { key: stagingCacheKey(sceneKey) } });
  if (!row) return null;
  const stored = row.precondition as unknown as { facts: string[]; triggerSource: string; contradictsSource: string };
  if (!stored?.triggerSource || !stored?.contradictsSource) return null;
  return {
    label: row.label,
    pattern: null,
    facts: stored.facts.map((description) => ({ description })),
    trigger: new RegExp(stored.triggerSource, "i"),
    contradicts: new RegExp(stored.contradictsSource, "i"),
  };
}

export async function persistStagingRule(sceneKey: string, rule: StagingRule): Promise<void> {
  const stored = {
    facts: rule.facts.map((f) => f.description),
    triggerSource: rule.trigger.source,
    contradictsSource: rule.contradicts.source,
  };
  const key = stagingCacheKey(sceneKey);
  await prisma.actionRuleCache.upsert({
    where: { key },
    create: { key, label: rule.label, category: "staging", precondition: stored, effect: [] },
    update: { label: rule.label, category: "staging", precondition: stored, effect: [] },
  });
}
