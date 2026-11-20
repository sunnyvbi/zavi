
import * as e2b from "@/services/sandbox/e2b-client";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { SITE_REPO_DIR, type SiteRow } from "./contract";
import type { DesignBrief } from "./design-brief";
import { THEME_CSS_PATH, renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { BRAND_DIRECTION_ID, findDirection, liveSwitchable, presetBriefColors, type DesignDirection, type ThemeMode } from "./design-directions";
import { parseLogoRecipe, renderSiteLogo } from "./site-logo";
import { SITE_LOGO_PATH } from "./site-head";

const FAVICON_PATH = "public/favicon.svg";

function logoMarkFor(brief: DesignBrief, direction: DesignDirection): Array<[string, string]> | null {
  const recipe = parseLogoRecipe(brief.logo);
  if (!recipe) return null;
  const c = presetBriefColors(direction.preset);
  const mark = renderSiteLogo(recipe, { primary: c.primary, primaryForeground: c["primary-foreground"] });
  return mark ? [[SITE_LOGO_PATH, mark.logo], [FAVICON_PATH, mark.favicon]] : null;
}
import type { SiteDesignStore } from "./site-design-store";

type GraphNode = { status?: unknown; payload?: { stage?: unknown; fast_single_pass?: unknown } | null };

export function pickWindow(input: { runStatus: string | null; goalGraph: unknown; site: Pick<SiteRow, "live_sha" | "status"> }): null | "live" | "built" | "ended" {
  if (input.site.live_sha) return "live";
  if (!["provisioning", "building"].includes(input.site.status)) return "ended";
  if (!["active", "provisioning", "pending", "queued"].includes(input.runStatus ?? "")) return "ended";
  const nodes = Array.isArray(input.goalGraph) ? (input.goalGraph as GraphNode[]) : [];
  const build = nodes.find((n) => n?.payload?.stage === "build" && n.payload.fast_single_pass === true);
  if (!build) return null;
  return build.status === "pending" || build.status === "dispatched" ? null : "built";
}

export type DirectionSandbox = {
  sandboxFor(tenant_id: string, repo_full_name: string): Promise<string | null>;
  read(sandbox_id: string, path: string): Promise<string>;
  write(sandbox_id: string, path: string, content: string): Promise<void>;
  plainFile(sandbox_id: string, path: string): Promise<boolean>;
};

const LIVE = new Set(["active", "creating"]);

export const realDirectionSandbox: DirectionSandbox = {
  async sandboxFor(tenant_id, repo_full_name) {
    const { data, error } = await (tenantClient(asTenantId(tenant_id))
      .from("tenant_sandbox")
      .select("e2b_sandbox_id, status") as any)
      .eq("repo_full_name", repo_full_name)
      .maybeSingle();
    if (error) throw new Error(`tenant_sandbox read failed: ${error.message ?? "unknown error"}`);
    const row = data as { e2b_sandbox_id?: string | null; status?: string | null } | null;
    return row?.e2b_sandbox_id && LIVE.has(row.status ?? "") ? row.e2b_sandbox_id : null;
  },
  read: (id, path) => e2b.readFile(id, path),
  write: (id, path, content) => e2b.writeFile(id, path, content),
  async plainFile(id, path) {
    const r = await e2b.execCommand(id, `[ "$(realpath -m '${path}')" = '${path}' ]`, 15_000);
    return r.exit_code === 0;
  },
};

export type ApplyOutcome = "applied" | "no_sandbox" | "unsupported";

export async function applyDirectionInSandbox(
  input: {
    tenant_id: string;
    site: Pick<SiteRow, "id" | "github_full_name">;
    brief: DesignBrief;
    directions?: readonly DesignDirection[];
    direction_id: string;
    theme_mode: ThemeMode;
  },
  sandbox: DirectionSandbox = realDirectionSandbox,
): Promise<ApplyOutcome> {
  const direction = findDirection(input.brief, input.direction_id, input.directions);
  const repo = (input.site.github_full_name ?? "").trim();
  if (!direction || !liveSwitchable(input.theme_mode) || !repo) return "unsupported";
  const id = await sandbox.sandboxFor(input.tenant_id, repo);
  if (!id) return "no_sandbox";
  const abs = `${SITE_REPO_DIR}/${THEME_CSS_PATH}`;
  if (!(await sandbox.plainFile(id, abs))) return "unsupported";
  const css = renderThemeCss(direction.preset);
  if ((await sandbox.read(id, abs)) !== css) await sandbox.write(id, abs, css);
  const marks = logoMarkFor(input.brief, direction);
  if (marks) {
    for (const [path, mark] of marks) {
      const file = `${SITE_REPO_DIR}/${path}`;
      if (!(await sandbox.plainFile(id, file))) continue;
      const now = await sandbox.read(id, file).catch(() => "");
      if (/data-zavi-logo="(?:mark|letters)"/.test(now) && now !== mark) await sandbox.write(id, file, mark);
    }
  }
  return "applied";
}

export type PushedFile = { path: string; action: "create" | "modify" | "delete"; diff: string; content?: string; encoding?: "base64" };

export async function enforceSiteTheme(
  input: { tenant_id: string; site_id: string; files: PushedFile[] },
  store: Pick<SiteDesignStore, "get" | "seal">,
): Promise<string | null> {
  const current = await store.get(input.tenant_id, input.site_id);
  if (!current || !liveSwitchable(current.theme_mode)) return null;
  const row = await store.seal(input.tenant_id, input.site_id);
  if (!row) throw new Error("the site's design row disappeared while it was sealed");
  const direction = findDirection(row.brief, row.chosen_direction, row.directions);
  if (!direction) return null;
  const content = renderThemeCss(direction.preset);
  const diff = `(platform) ${THEME_CSS_PATH} rendered from the site's chosen look "${direction.id}"`;
  const marks = logoMarkFor(row.brief, direction);
  if (marks) {
    for (const [path, mark] of marks) {
      if (input.files.some((f) => f.path === path)) continue;
      input.files.push({ path, action: "modify", diff: `(platform) ${path}: the logo mark in the look "${direction.id}"`, content: mark });
    }
  }
  const at = input.files.findIndex((f) => f.path === THEME_CSS_PATH);
  if (at < 0 && direction.id === BRAND_DIRECTION_ID) return direction.id;
  const file: PushedFile = { path: THEME_CSS_PATH, action: "modify", diff, content };
  if (at >= 0) input.files[at] = file;
  else input.files.push(file);
  return direction.id;
}

export const APPLY_RETRY_MS = 3_000;
export const APPLY_RETRY_TRIES = 30;

export async function scheduleDirectionApply(
  input: { tenant_id: string; site: SiteRow; direction_id: string },
  deps: {
    store: SiteDesignStore;
    stillOpen: () => Promise<boolean>;
    sandbox?: DirectionSandbox;
    sleep?: (ms: number) => Promise<void>;
    tries?: number;
  },
): Promise<ApplyOutcome | "superseded" | "closed" | "gave_up"> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = deps.tries ?? APPLY_RETRY_TRIES;
  for (let i = 0; i < tries; i++) {
    try {
      const row = await deps.store.get(input.tenant_id, input.site.id);
      if (!row) return "superseded";
      if (row.sealed_at) return "closed";
      if (!(await deps.stillOpen())) return "closed";
      const out = await applyDirectionInSandbox(
        {
          tenant_id: input.tenant_id,
          site: input.site,
          brief: row.brief,
          directions: row.directions,
          direction_id: row.chosen_direction,
          theme_mode: row.theme_mode,
        },
        deps.sandbox,
      );
      if (out === "applied") {
        const after = await deps.store.get(input.tenant_id, input.site.id);
        if (after && after.chosen_direction === row.chosen_direction) {
          await deps.store.markApplied(input.tenant_id, input.site.id, row.chosen_direction);
          return row.chosen_direction === input.direction_id ? out : "superseded";
        }
        continue;
      }
      if (out === "unsupported") return out;
    } catch (e) {
      console.warn(`[design-direction] tenant=${input.tenant_id} site=${input.site.id} apply try ${i + 1} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    await sleep(APPLY_RETRY_MS);
  }
  return "gave_up";
}
