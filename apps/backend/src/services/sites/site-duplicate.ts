
import { SITE_MANIFEST_PATH, type SiteRow, type SiteStore } from "./contract";
import { parseFunctionsManifest } from "@/services/site-functions/manifest";
import { nextFire, parseCron } from "@/services/site-functions/cron";
import type { BlobMode } from "@/services/provisioning/export-to-own-github";
import { cleanSiteName, siteShownName } from "./label";
import { isForbiddenPath } from "@/services/pr-builder/from-sandbox-fs";
import { retargetSiteHead } from "./site-head";
import { BRAND_DIRECTION_ID } from "./design-directions";
import type { SiteDesignStore } from "./site-design-store";
import { buildSiteGoalGraph } from "@/services/agents/product-pipeline";
import type { ConductorNode } from "@/services/agents/conductor";

export const DUPLICATE_MAX_FILES = 3000;
export const DUPLICATE_MAX_BYTES = 25 * 1024 * 1024;
const COPY_SUFFIX = " (copy)";
const COMMIT_PREFIX = "Copy of site";

export class DuplicateRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 503,
    readonly code:
      | "bad_request_key"
      | "site_not_found"
      | "site_not_copyable"
      | "dedicated_site"
      | "no_code"
      | "site_too_large"
      | "product_builder_disabled"
      | "site_backend_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "DuplicateRefused";
  }
}

export type PausedSchedule = { name: string; cron: string; data_access: "function" | "admin"; next_run_at: string };

const SCHEDULE_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;

export function pausedSchedules(files: Map<string, string>, now: Date): PausedSchedule[] {
  const raw = files.get(SITE_MANIFEST_PATH);
  if (raw === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return [];
  }
  try {
    const spec = parseFunctionsManifest(json, now);
    if (!spec) return [];
    return Object.entries(spec.schedules).map(([name, s]) => ({
      name,
      cron: s.cron,
      data_access: s.data,
      next_run_at: nextFire(parseCron(s.cron), now).toISOString(),
    }));
  } catch {
    const declared = (json as { functions?: { schedules?: unknown } } | null)?.functions?.schedules;
    if (!declared || typeof declared !== "object") return [];
    const out: PausedSchedule[] = [];
    for (const [name, s] of Object.entries(declared as Record<string, unknown>)) {
      const cron = (s as { cron?: unknown } | null)?.cron;
      if (!SCHEDULE_NAME_RE.test(name) || typeof cron !== "string" || cron.length < 9 || cron.length > 100) continue;
      try {
        const next = nextFire(parseCron(cron), now).toISOString();
        out.push({ name, cron, data_access: (s as { asAdmin?: unknown }).asAdmin === true ? "admin" : "function", next_run_at: next });
      } catch {
      }
    }
    return out;
  }
}

export const DUPLICATE_KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

export type DuplicateSiteDeps = {
  canCreateSite(): Promise<"ok" | "builder_off" | "backend_unavailable">;
  findDone(tenant_id: string, source_site_id: string, request_key: string): Promise<DuplicateSiteResult | null>;
  store: Pick<SiteStore, "get" | "getOrCreateForRun" | "update" | "transition" | "claimProvider" | "setProviderState">;
  designStore: Pick<SiteDesignStore, "get" | "createIfAbsent" | "choose" | "markApplied" | "seal">;
  acquireRun(input: { tenant_id: string; objective: string }): Promise<string>;
  finishRun(input: { tenant_id: string; conductor_run_id: string; goal_graph: ConductorNode[] }): Promise<void>;
  failRun(input: { tenant_id: string; conductor_run_id: string; reason: string }): Promise<void>;
  initStatic(tenant_id: string, site_id: string): Promise<void>;
  repoOrg(): string;
  ensureRepo(name: string): Promise<{ full_name: string; default_branch: string; repo_url: string }>;
  readRepo(full_name: string): Promise<{ files: Map<string, string>; modes: Map<string, BlobMode> }>;
  pushRepo(input: { full_name: string; files: Map<string, string>; modes: Map<string, BlobMode>; message: string }): Promise<string>;
  ensureGithubConnector(tenant_id: string, full_name: string): Promise<void>;
  pauseSchedules(tenant_id: string, site_id: string, schedules: PausedSchedule[]): Promise<void>;
  clearSchedules(tenant_id: string, site_id: string): Promise<void>;
  deleteSite(tenant_id: string, site_id: string): Promise<void>;
  webBase(): string;
  now(): Date;
};

export type DuplicateSiteResult = { site_id: string; conductor_run_id: string; name: string };

const NOT_COPYABLE: ReadonlySet<SiteRow["status"]> = new Set(["provisioning", "fell_back_old", "deleting", "deleted"]);

export function neverCopied(path: string): boolean {
  const lower = path.toLowerCase();
  if (isForbiddenPath(lower)) return true;
  if (lower.startsWith("supabase/")) return true;
  const base = lower.split("/").pop() ?? "";
  const dirs = lower.split("/").slice(0, -1);
  if (base.startsWith(".env") || base === ".dev.vars" || base.startsWith(".dev.vars.")) return true;
  if (
    [".npmrc", ".yarnrc", ".yarnrc.yml", ".netrc", ".pypirc", ".git-credentials", "credentials", "credentials.json", "credentials.yaml", "credentials.yml", "auth.json", ".htpasswd", ".terraformrc", "terraform.rc"].includes(base)
  ) {
    return true;
  }
  if (/\.tfvars(\.json)?$/.test(base) || /^secrets?\.(json|ya?ml|toml|env)$/.test(base)) return true;
  if (dirs.some((d) => d === ".aws" || d === ".gcp" || d === ".kube" || d === ".ssh" || d === ".gnupg" || d === ".docker" || d === ".git")) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/.test(base)) return true;
  return /service[-_]?account.*\.json$/.test(base);
}

export function copyName(source: Pick<SiteRow, "label" | "name">): string {
  const base = siteShownName(source);
  return cleanSiteName(`${base}${COPY_SUFFIX}`) ?? cleanSiteName(base) ?? "Site copy";
}

export function filesForCopy(
  source: { files: Map<string, string>; modes: Map<string, BlobMode> },
  site: Pick<SiteRow, "label" | "name" | "hostname">,
  webBase: string,
): { files: Map<string, string>; modes: Map<string, BlobMode> } {
  const files = new Map<string, string>();
  const modes = new Map<string, BlobMode>();
  let bytes = 0;
  for (const [path, b64] of source.files) {
    if (neverCopied(path)) continue;
    bytes += Math.floor((b64.length * 3) / 4);
    files.set(path, b64);
    const mode = source.modes.get(path);
    if (mode) modes.set(path, mode);
  }
  if (files.size === 0) throw new DuplicateRefused(409, "no_code", "This site has no code to copy yet.");
  if (files.size > DUPLICATE_MAX_FILES || bytes > DUPLICATE_MAX_BYTES) {
    throw new DuplicateRefused(413, "site_too_large", "This site is too large to duplicate here.");
  }
  const config = files.get("vite.config.ts");
  const head = files.get("vite-zavi-head.ts");
  if (config !== undefined && head !== undefined) {
    const text = { "vite.config.ts": Buffer.from(config, "base64").toString("utf8"), "vite-zavi-head.ts": "present" };
    const out = retargetSiteHead(text, { label: site.label, name: site.name, hostname: site.hostname, webBase });
    if (out["vite.config.ts"] !== text["vite.config.ts"]) {
      files.set("vite.config.ts", Buffer.from(out["vite.config.ts"]!, "utf8").toString("base64"));
    }
  }
  return { files, modes };
}

export async function duplicateSite(
  input: { tenant_id: string; source_site_id: string; user_id: string | null; owner_email: string | null; request_key?: string | null },
  deps: DuplicateSiteDeps,
): Promise<DuplicateSiteResult> {
  const { tenant_id } = input;
  if (input.request_key != null && !DUPLICATE_KEY_RE.test(input.request_key)) {
    throw new DuplicateRefused(400, "bad_request_key", "That request key is not valid.");
  }
  const request_key = input.request_key ?? null;
  if (request_key) {
    const done = await deps.findDone(tenant_id, input.source_site_id, request_key);
    if (done) return done;
  }
  const source = await deps.store.get(tenant_id, input.source_site_id);
  if (!source) throw new DuplicateRefused(404, "site_not_found", "That site was not found.");
  if (NOT_COPYABLE.has(source.status)) {
    throw new DuplicateRefused(409, "site_not_copyable", "This site can't be duplicated until it has been built.");
  }
  if (source.backend_mode === "dedicated" || source.supabase_project_ref) {
    throw new DuplicateRefused(409, "dedicated_site", "Sites with their own database can't be duplicated yet.");
  }
  if (!source.github_full_name) throw new DuplicateRefused(409, "no_code", "This site has no code to copy yet.");

  const gate = await deps.canCreateSite();
  if (gate === "builder_off") throw new DuplicateRefused(403, "product_builder_disabled", "Building sites is paused right now.");
  if (gate === "backend_unavailable") {
    throw new DuplicateRefused(503, "site_backend_unavailable", "New sites can't be set up right now. Try again in a few minutes.");
  }

  const sourceRepo = await deps.readRepo(source.github_full_name);
  const design = await deps.designStore.get(tenant_id, source.id);
  const name = copyName(source);

  const conductor_run_id = await deps.acquireRun({ tenant_id, objective: `Copy of ${siteShownName(source)}` });
  if (request_key) {
    const done = await deps.findDone(tenant_id, source.id, request_key).catch(() => null);
    if (done) {
      await deps.failRun({ tenant_id, conductor_run_id, reason: "a copy for this request already exists" }).catch(() => undefined);
      return done;
    }
  }
  let site: SiteRow | null = null;
  let repoFullName = "";
  try {
    site = await deps.store.getOrCreateForRun({
      tenant_id,
      root_conductor_run_id: conductor_run_id,
      company_name: name,
      started_by_user_id: input.user_id,
      site_name: name,
    });
    const copy = filesForCopy(sourceRepo, site, deps.webBase());
    const provisionStartedAt = deps.now().toISOString();

    await deps.store.claimProvider(tenant_id, site.id, "github_repo", { name: site.label, owner: deps.repoOrg() });
    await deps.initStatic(tenant_id, site.id);
    const ref = await deps.ensureRepo(site.label);
    repoFullName = ref.full_name;
    await deps.store.setProviderState(tenant_id, site.id, "github_repo", "created", { full_name: ref.full_name });
    await deps.store.update(tenant_id, site.id, { github_full_name: ref.full_name });
    const sha = await deps.pushRepo({
      full_name: ref.full_name,
      files: copy.files,
      modes: copy.modes,
      message: `${COMMIT_PREFIX} ${siteShownName(source)} (${source.github_full_name})`,
    });

    const schedules = pausedSchedules(copy.files, deps.now());
    if (schedules.length > 0) await deps.pauseSchedules(tenant_id, site.id, schedules);

    if (design) {
      const look = design.applied_direction ?? design.chosen_direction;
      await deps.designStore.createIfAbsent({
        tenant_id,
        site_id: site.id,
        conductor_run_id,
        brief: design.brief,
        directions: design.directions,
        theme_mode: design.theme_mode,
      });
      if (look !== BRAND_DIRECTION_ID) await deps.designStore.choose(tenant_id, site.id, look, input.user_id);
      if (design.applied_direction) await deps.designStore.markApplied(tenant_id, site.id, look);
      await deps.designStore.seal(tenant_id, site.id);
    }

    const moved = await deps.store.transition(tenant_id, site.id, ["provisioning"], "building", {
      desired_sha: sha,
      last_error: null,
      ...(input.owner_email ? { owner_email: input.owner_email } : {}),
    });
    if (!moved) throw new Error("the copy left provisioning while it was being set up");

    const finishedAt = deps.now().toISOString();
    const graph = buildSiteGoalGraph(
      { tenant_id, company_name: name, idea: `Copy of ${siteShownName(source)}`, max_usd: 0 },
      {
        site_id: site.id,
        target: { github_full_name: ref.full_name, repo_url: ref.repo_url, default_branch: "main", github_target_mode: "umbrella" },
        seed_sha: sha,
        provision_started_at: provisionStartedAt,
        provision_finished_at: finishedAt,
        site_backend: "pooled",
        publish_on_request: true,
        ...(design ? { design_brief: design.brief } : {}),
      },
    );
    const goal_graph: ConductorNode[] = graph.map((node) =>
      node.payload.stage === "build"
        ? {
            ...node,
            status: "done",
            started_at: provisionStartedAt,
            finished_at: finishedAt,
            error: null,
            failure_class: null,
            checkpoint: { kind: "pushed", commit_sha: sha, verified_at: finishedAt },
            payload: { ...node.payload, duplicate_of: { site_id: source.id, ...(request_key ? { request_key } : {}) } },
          }
        : node,
    );
    await deps.finishRun({ tenant_id, conductor_run_id, goal_graph });
  } catch (e) {
    await deps.failRun({ tenant_id, conductor_run_id, reason: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => undefined);
    if (site) {
      await deps.clearSchedules(tenant_id, site.id).catch(() => undefined);
      await deps.deleteSite(tenant_id, site.id).catch(() => undefined);
    }
    throw e;
  }

  await deps.ensureGithubConnector(tenant_id, repoFullName).catch(() => undefined);
  return { site_id: site.id, conductor_run_id, name };
}
