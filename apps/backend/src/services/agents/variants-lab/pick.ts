
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SLUG } from "./run-variants";
import { VariantConfigSchema, type VariantConfig } from "../engine/variant-config";
import type { FileVariant } from "./file-variants";

export type PickDeps = {
  sb: SupabaseClient;
  appendLine: (filePath: string, line: string) => Promise<void>;
  runsDir: string;
  now?: () => Date;
  fileVariants?: FileVariant[];
};

export type PickResult = { ship_steps: string[]; log_file: string };

export const SHIP_FINAL_STEP = "Codex review, merge, Ravi deploys.";

export function shipSteps(agentSlug: string, config: VariantConfig | null): string[] {
  if (!config) return ["No change: today's agent stays."];
  const steps: string[] = [];
  const { prompt, behaviors, tools, ...settings } = config;
  if (prompt?.agent_file) {
    steps.push(`Make agent.${prompt.agent_file}.md the ${agentSlug} prompt (replace the agent.md body) in a PR`);
  }
  if (prompt?.recipe_file) {
    steps.push(
      `Make recipe.${prompt.recipe_file}.md the ${agentSlug} channel recipe (replace src/channels/${agentSlug}/recipe.md, keep its frontmatter) in a PR, and lower its line in channels/prompt-budget.json`,
    );
  }
  for (const b of behaviors ?? []) steps.push(`Turn on ${b} by default in code`);
  const move = (key: string, value: unknown) =>
    steps.push(`Move ${key}=${JSON.stringify(value)} into ${agentSlug} agent.md frontmatter (or the fleet default)`);
  for (const [k, v] of Object.entries(settings)) if (v !== undefined) move(k, v);
  if (tools?.always_load?.length) move("tools.always_load", tools.always_load);
  if (tools?.disable?.length) move("tools.disable", tools.disable);
  if (prompt?.drop_core?.length) move("prompt.drop_core", prompt.drop_core);
  if (prompt?.skills?.length) move("prompt.skills", prompt.skills);
  if (steps.length === 0) return ["No change: this variation has no overrides, today's agent stays."];
  return [...steps, SHIP_FINAL_STEP];
}

export async function pickVariant(
  args: {
    tenantId: string;
    agentSlug: string;
    variantSlug: string | null;
    note: string;
    record: unknown;
  },
  deps: PickDeps,
): Promise<PickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const pick = !args.variantSlug || args.variantSlug === DEFAULT_SLUG ? null : args.variantSlug;
  if (!/^[a-z0-9_-]{1,64}$/.test(args.agentSlug)) throw new Error("bad agent slug");

  let config: VariantConfig | null = null;
  const file = pick ? deps.fileVariants?.find((f) => f.slug === pick) : undefined;
  if (file) {
    if (!file.config) throw new Error(`variation ${pick} (local file) is invalid: ${file.error}`);
    config = file.config;
  } else if (pick) {
    const { data, error } = await deps.sb
      .from("agent_engine_variants")
      .select("slug, config")
      .eq("slug", pick)
      .limit(1);
    if (error) throw new Error(`variant read failed: ${error.message}`);
    const row = ((data ?? []) as Array<{ slug: string; config: unknown }>)[0];
    if (!row) throw new Error(`unknown variation: ${pick}`);
    const parsed = VariantConfigSchema.safeParse(row.config);
    if (!parsed.success) throw new Error(`variation ${pick} has an invalid config`);
    config = parsed.data;
  }

  const ship_steps = shipSteps(args.agentSlug, config);
  const logFile = `${deps.runsDir.replace(/\/$/, "")}/${now.toISOString().slice(0, 10)}.jsonl`;
  await deps.appendLine(
    logFile,
    JSON.stringify({
      at: now.toISOString(),
      tenant_id: args.tenantId,
      agent_slug: args.agentSlug,
      pick: pick ?? DEFAULT_SLUG,
      note: args.note,
      ship_steps,
      run: args.record,
    }),
  );
  return { ship_steps, log_file: logFile };
}
