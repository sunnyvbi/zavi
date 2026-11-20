
import { seedTemplate, type SeedTemplateDeps, type SeedTemplateResult } from "./seed-template";
import { classifyPrompt, type StarterCategory } from "./starter-picker";
import { buildStarterFiles } from "./templates/starters";
import { getBoolSetting } from "@/services/settings";

export type SeedProvisionedRepoResult =
  | (SeedTemplateResult & { category?: StarterCategory })
  | { seeded: false; reason: "flag_off" }
  | { seeded: false; reason: "credential_not_configured"; missing_key: string; category?: StarterCategory }
  | { seeded: false; reason: "error"; error: string; category?: StarterCategory; replace_requested?: boolean };

export type SeedProvisionedRepoOpts = {
  idea?: string;
  category?: StarterCategory;
};

export function isSeedTemplateEnabled(
  getFlag: () => string | undefined = () => process.env.PROVISION_SEED_TEMPLATE,
): boolean {
  const v = (getFlag() ?? "").toString().toLowerCase().trim();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

export async function seedProvisionedRepo(
  tenant_id: string,
  repo_full_name: string,
  deps: SeedTemplateDeps & {
    enabled?: () => boolean;
    seed?: (tenant_id: string, repo_full_name: string, deps: SeedTemplateDeps) => Promise<SeedTemplateResult>;
    visitorSafe?: (tenant_id: string) => Promise<boolean>;
  } & SeedProvisionedRepoOpts = {},
): Promise<SeedProvisionedRepoResult> {
  const enabled = deps.enabled ?? (() => isSeedTemplateEnabled());
  if (!enabled()) return { seeded: false, reason: "flag_off" };

  const category: StarterCategory = deps.category ?? classifyPrompt(deps.idea);
  const filesForSeed =
    deps.files ??
    buildStarterFiles(category, {
      visitorSafe: await (deps.visitorSafe ?? readVisitorSafeSeed)(tenant_id).catch(() => false),
    });
  const commitMessage =
    deps.commitMessage ?? `chore: seed starter app (nextjs-supabase-tailwind, ${category})`;

  const run = deps.seed ?? seedTemplate;
  try {
    const result = await run(tenant_id, repo_full_name, { ...deps, files: filesForSeed, commitMessage });
    return { ...result, category };
  } catch (e) {
    if ((e as { name?: string })?.name === "CredentialNotConfigured") {
      return {
        seeded: false,
        reason: "credential_not_configured",
        missing_key: (e as { key?: string }).key ?? "GITHUB_PROVISION_TOKEN",
        category,
      };
    }
    if ((e as { name?: string })?.name === "ReplaceExistingAppError") {
      return { seeded: false, reason: "error", error: (e as Error).message, category, replace_requested: true };
    }
    return { seeded: false, reason: "error", error: (e as Error).message, category };
  }
}

async function readVisitorSafeSeed(tenant_id: string): Promise<boolean> {
  return getBoolSetting("build_visitor_safe_seed", tenant_id);
}
