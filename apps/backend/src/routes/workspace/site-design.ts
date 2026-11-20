
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { siteStore } from "@/services/sites/store";
import type { SiteRow } from "@/services/sites/contract";
import { THEME_CSS_PATH, resolveTheme } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { applyDirectionToFiles, briefForChosenLook, findDirection, liveSwitchable, lookIsGiven, type DesignDirection } from "@/services/sites/design-directions";
import { planSectionIds } from "@/services/sites/design-fidelity";
import { parseSitePlan, type SitePlan } from "@/services/sites/design-brief";
import { SITE_BUILD_WAITS_FOR_LOOK_SETTING, lookAutoStartAt, lookAwaitingSiteId, lookParkedAt, pickParkedLook, rowAwaitsPick } from "@/services/sites/look-wait";
import { siteDesignStore, type SiteDesignRow, type SiteDesignStore } from "@/services/sites/site-design-store";
import { pickWindow, scheduleDirectionApply } from "@/services/sites/design-direction-apply";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECTION_RE = /^[a-z][a-z0-9-]{1,30}$/;
const WRITE_ROLES = ["owner", "admin"] as const;

type RunRow = { id: string; status: string | null; goal_graph: unknown };

export type SiteDesignRouteDeps = {
  loadRun: (access_token: string, tenant_id: string, run_id: string) => Promise<RunRow | null>;
  loadSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  store: SiteDesignStore;
  applyLive: (input: { tenant_id: string; site: SiteRow; direction_id: string; stillOpen: () => Promise<boolean> }) => void;
  waitsForLook: (tenant_id: string) => Promise<boolean>;
  kick: (run_id: string) => Promise<unknown>;
  pickParked: (input: { tenant_id: string; conductor_run_id: string; direction: string; user_id: string }) => Promise<{ state: string }>;
};

const realDeps = (): SiteDesignRouteDeps => {
  const store = siteDesignStore();
  return {
    async loadRun(access_token, tenant_id, run_id) {
      const { data, error } = await serverClientFromBearer(access_token)
        .from("conductor_runs")
        .select("id, status, goal_graph")
        .eq("tenant_id", tenant_id)
        .eq("kind", "build_app")
        .eq("id", run_id)
        .maybeSingle();
      if (error) throw new Error(`build run read failed: ${error.message}`);
      return (data as RunRow | null) ?? null;
    },
    loadSite: (tenant_id, site_id) => siteStore().get(tenant_id, site_id),
    store,
    applyLive: ({ tenant_id, site, direction_id, stillOpen }) => {
      void scheduleDirectionApply({ tenant_id, site, direction_id }, { store, stillOpen }).catch(() => undefined);
    },
    async waitsForLook(tenant_id) {
      const { getBoolSetting } = await import("@/services/settings");
      return getBoolSetting(SITE_BUILD_WAITS_FOR_LOOK_SETTING, tenant_id);
    },
    async kick(run_id) {
      const [{ requestConductorTick }, { inngest }] = await Promise.all([
        import("@/services/agents/conductor-kick"),
        import("../../../workers/client"),
      ]);
      return requestConductorTick(inngest, run_id);
    },
    pickParked: pickParkedLook,
  };
};

export type SiteDesignPreview = {
  name: string;
  eyebrow: string;
  headline: string;
  subtitle: string;
  primary_action: string;
  hero_variant?: string;
  sections: Array<{ title: string; body: string; kind?: string; variant?: string; tone?: string }>;
};

export type SiteDesignLook = {
  id: string;
  label: string;
  mood: string;
  recommended: boolean;
  fonts: { display: string; body: string };
  swatches: { background: string; foreground: string; primary: string; accent: string; muted: string };
  radius: string;
  layout: DesignDirection["layout"];
  theme_css: string | null;
  preview: SiteDesignPreview | null;
};

export type SiteDesignView = {
  run_id: string;
  awaiting_pick: boolean;
  auto_start_at: string | null;
  picked: boolean;
  preview: SiteDesignPreview | null;
  source: "model" | "fallback";
  looks: SiteDesignLook[];
  chosen: string;
  applied: string | null;
  structure: string | null;
  look_given: "idea" | "references" | "template" | null;
  locked: null | "live" | "built" | "ended" | "unsupported";
  plan: {
    audience: string | null;
    positioning: string | null;
    tone: string | null;
    main_action: string | null;
    sections: Array<{ id: string; name: string; headline: string }>;
    pages: Array<{ path: string; title: string }>;
    facts: string[];
  };
  checklist: null | {
    checked_at: string;
    found: number;
    total: number;
    items: Array<{ kind: string; label: string; found: boolean }>;
  };
};

function themeCssFor(row: SiteDesignRow, d: DesignDirection): string | null {
  if (row.theme_mode !== "theme_css") return null;
  const css = applyDirectionToFiles({ [THEME_CSS_PATH]: "" }, row.brief, d)[THEME_CSS_PATH];
  return css ? css : null;
}

export function sitePreview(row: Pick<SiteDesignRow, "brief">, plan: SitePlan | null, siteName: string | null): SiteDesignPreview | null {
  const home = plan?.pages.find((p) => p.path === "/");
  const name = siteName?.trim() ?? "";
  if (!plan || !home || !name) return null;
  const at = Math.max(0, home.sections.findIndex((s) => s.component === "Hero"));
  const hero = home.sections[at]!;
  const rest = home.sections.filter((_, i) => i !== at);
  return {
    name,
    eyebrow: row.brief.audience?.trim() ?? "",
    headline: hero.headline,
    subtitle: row.brief.positioning?.trim() || plan.primary_action.steps,
    primary_action: plan.primary_action.label,
    ...(hero.component === "Hero" && hero.variant ? { hero_variant: hero.variant } : {}),
    sections: rest.map((s) => ({
      title: s.name,
      body: s.headline,
      ...(s.component ? { kind: s.component } : {}),
      ...(s.variant ? { variant: s.variant } : {}),
      ...(s.tone ? { tone: s.tone } : {}),
    })),
  };
}

const SAMPLE_HERO: Record<DesignDirection["layout"], string> = {
  split: "split",
  centered: "centered",
  editorial: "editorial",
  bold: "image",
  minimal: "minimal",
};

function sampleSection(layout: DesignDirection["layout"], name: string): SiteDesignPreview["sections"][number] {
  switch (layout) {
    case "split":
      return { title: "What we offer", body: `What ${name} offers`, kind: "Features", variant: "alternating" };
    case "centered":
      return { title: "Services", body: `Why people choose ${name}`, kind: "Features", variant: "cards" };
    case "editorial":
      return { title: "How it works", body: `How ${name} works`, kind: "Features", variant: "split", tone: "muted" };
    case "bold":
      return { title: "At a glance", body: `What ${name} does`, kind: "Features", variant: "icons", tone: "inverse" };
    case "minimal":
      return { title: "Our work", body: `A look at ${name}`, kind: "Gallery", variant: "grid" };
  }
}

function firstClause(text: string | undefined): string {
  return (text ?? "").split(/[:.]/)[0]!.trim().slice(0, 60);
}

export function sampleLookPreview(brief: SiteDesignRow["brief"], d: Pick<DesignDirection, "layout" | "mood">, siteName: string | null): SiteDesignPreview {
  const name = siteName?.trim() || "Your business";
  const label = (brief.plan as { primary_action?: { label?: unknown } } | undefined)?.primary_action?.label;
  return {
    name,
    eyebrow: brief.audience?.trim() || brief.industry?.trim() || firstClause(d.mood),
    headline: brief.positioning?.trim() || `Welcome to ${name}`,
    subtitle: (brief.facts ?? []).slice(0, 3).join(" · "),
    primary_action: (typeof label === "string" && label.trim().slice(0, 60)) || "Get in touch",
    hero_variant: SAMPLE_HERO[d.layout] ?? "centered",
    sections: [sampleSection(d.layout, name)],
  };
}

function lookPreview(row: SiteDesignRow, d: DesignDirection, siteName: string | null): SiteDesignPreview {
  const plan = parseSitePlan(d.plan ?? row.brief.plan);
  return sitePreview(row, plan, siteName?.trim() || "Your business") ?? sampleLookPreview(row.brief, d, siteName);
}

export const RECOMMENDED_LOOK_NAME = "Made for you";

export function plainLookLabel(d: Pick<DesignDirection, "label" | "mood" | "recommended">): string {
  const label = d.label.trim();
  if (!label) return RECOMMENDED_LOOK_NAME;
  return d.recommended && d.mood.trim().toLowerCase().startsWith(label.toLowerCase()) ? RECOMMENDED_LOOK_NAME : label;
}

function look(row: SiteDesignRow, d: DesignDirection, preview: SiteDesignPreview | null): SiteDesignLook {
  const t = resolveTheme(d.preset);
  return {
    id: d.id,
    label: plainLookLabel(d),
    mood: d.mood,
    recommended: d.recommended,
    fonts: d.preset.fonts,
    swatches: { background: t.background, foreground: t.foreground, primary: t.primary, accent: t.accent, muted: t.muted },
    radius: d.preset.radius ?? "0.5rem",
    layout: d.layout,
    theme_css: themeCssFor(row, d),
    preview,
  };
}

export function siteDesignView(
  row: SiteDesignRow,
  locked: SiteDesignView["locked"],
  extra: { awaiting_pick?: boolean; site_name?: string | null; auto_start_at?: string | null } = {},
): SiteDesignView {
  const plan = parseSitePlan(briefForChosenLook(row).plan);
  const name = extra.site_name ?? null;
  const preview = sitePreview(row, plan, name);
  const looks = (row.directions.length ? row.directions : []).map((d) => look(row, d, lookPreview(row, d, name)));
  const home = plan?.pages.find((p) => p.path === "/");
  const ids = home ? planSectionIds(home.sections) : [];
  return {
    run_id: row.conductor_run_id,
    awaiting_pick: extra.awaiting_pick === true,
    auto_start_at: extra.awaiting_pick === true ? (extra.auto_start_at ?? null) : null,
    picked: row.chosen_at !== null,
    preview,
    source: row.brief.source === "fallback" ? "fallback" : "model",
    looks,
    chosen: row.chosen_direction,
    applied: row.applied_direction,
    structure: row.build_direction ?? null,
    look_given: lookIsGiven(row.brief) ? (row.brief.look_given ?? null) : null,
    locked: liveSwitchable(row.theme_mode) ? locked : "unsupported",
    plan: {
      audience: row.brief.audience ?? null,
      positioning: row.brief.positioning ?? null,
      tone: plan?.tone ?? null,
      main_action: plan?.primary_action.label ?? null,
      sections: (home?.sections ?? []).map((s, i) => ({ id: ids[i]!, name: s.name, headline: s.headline })),
      pages: (plan?.pages ?? []).filter((p) => p.path !== "/").map((p) => ({ path: p.path, title: p.title })),
      facts: row.brief.facts ?? [],
    },
    checklist: row.fidelity
      ? {
          checked_at: row.fidelity.checked_at,
          found: row.fidelity.found,
          total: row.fidelity.total,
          items: row.fidelity.items.map((i) => ({ kind: i.kind, label: i.label, found: i.found })),
        }
      : null,
  };
}

function buildNotStarted(graph: unknown): boolean {
  if (lookAwaitingSiteId(graph) !== null) return false;
  const nodes = Array.isArray(graph) ? (graph as Array<{ status?: unknown; payload?: { stage?: unknown } | null }>) : [];
  return nodes.every((n) => n?.payload?.stage !== "build" || n.status === "pending");
}

async function awaitingPick(
  d: SiteDesignRouteDeps,
  tenant_id: string,
  found: { run: RunRow; site: SiteRow; row: SiteDesignRow },
  locked: SiteDesignView["locked"],
): Promise<boolean> {
  if (!rowAwaitsPick(found.row)) return false;
  if (lookAwaitingSiteId(found.run.goal_graph) === found.site.id) return true;
  if (lookIsGiven(found.row.brief)) return false;
  if (locked !== null || !buildNotStarted(found.run.goal_graph)) return false;
  return (await d.waitsForLook(tenant_id)) === true;
}

function siteNameOf(site: SiteRow): string | null {
  return site.name?.trim() || site.label?.trim() || null;
}

function runIdOf(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return UUID_RE.test(id) ? id : null;
}

async function resolve(
  deps: SiteDesignRouteDeps,
  access_token: string,
  tenant_id: string,
  run_id: string,
): Promise<{ run: RunRow; site: SiteRow; row: SiteDesignRow } | null> {
  const run = await deps.loadRun(access_token, tenant_id, run_id);
  const siteId = run ? siteIdFromGraph(run.goal_graph) : null;
  const site = siteId ? await deps.loadSite(tenant_id, siteId) : null;
  if (!run || !site || site.tenant_id !== tenant_id) return null;
  const row = await deps.store.get(tenant_id, site.id);
  if (!row || row.conductor_run_id !== run.id) return null;
  return { run, site, row };
}

const LOCKED_MESSAGE = "The first version is already built. Ask for a different look in the chat.";
const NOT_FOUND = { error: { code: "design_not_found", message: "This build has no design brief." } };

export function makeGetSiteDesign(deps: () => SiteDesignRouteDeps = realDeps) {
  return async function getSiteDesign(req: Request, res: Response): Promise<void> {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const runId = runIdOf(req.query?.run_id);
    if (!runId) {
      res.status(400).json({ error: { code: "bad_request", message: "run_id must be a uuid" } });
      return;
    }
    try {
      const d = deps();
      const found = await resolve(d, auth.access_token, auth.tenant_id, runId);
      if (!found) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const locked = found.row.sealed_at ? "built" : pickWindow({ runStatus: found.run.status, goalGraph: found.run.goal_graph, site: found.site });
      const awaiting_pick = await awaitingPick(d, auth.tenant_id, found, locked);
      const auto_start_at = awaiting_pick ? lookAutoStartAt(lookParkedAt(found.run.goal_graph)) : null;
      res.json({ design: siteDesignView(found.row, locked, { awaiting_pick, site_name: siteNameOf(found.site), auto_start_at }) });
    } catch (e) {
      console.warn(`[site-design] read failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      res.status(500).json({ error: { code: "design_read_failed", message: "Something went wrong. Try again." } });
    }
  };
}

export function makePostSiteDesignDirection(deps: () => SiteDesignRouteDeps = realDeps) {
  return async function postSiteDesignDirection(req: Request, res: Response): Promise<void> {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!(await requireTenantRole(auth, WRITE_ROLES, res))) return;
    const runId = runIdOf(req.body?.run_id);
    const direction = typeof req.body?.direction === "string" ? req.body.direction.trim().toLowerCase() : "";
    if (!runId || !DIRECTION_RE.test(direction)) {
      res.status(400).json({ error: { code: "bad_request", message: "run_id must be a uuid and direction a look id" } });
      return;
    }
    try {
      const d = deps();
      const found = await resolve(d, auth.access_token, auth.tenant_id, runId);
      if (!found) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const { site, row } = found;
      if (!findDirection(row.brief, direction, row.directions) || (row.directions.length > 0 && !row.directions.some((x) => x.id === direction))) {
        res.status(400).json({ error: { code: "unknown_look", message: "That look is not one of this build's options." } });
        return;
      }
      if (!liveSwitchable(row.theme_mode)) {
        res.status(409).json({ error: { code: "look_locked", reason: "unsupported", message: "This site's look can be changed in the chat." } });
        return;
      }
      const locked = row.sealed_at ? "built" : pickWindow({ runStatus: found.run.status, goalGraph: found.run.goal_graph, site });
      if (locked) {
        res.status(409).json({
          error: {
            code: "look_locked",
            reason: locked,
            message: LOCKED_MESSAGE,
          },
        });
        return;
      }
      const parked = lookAwaitingSiteId(found.run.goal_graph) !== null;
      const tenant_id = auth.tenant_id;
      const access_token = auth.access_token;
      const kick = async () => {
        try {
          await d.kick(runId);
        } catch (e) {
          console.warn(`[site-design] build kick failed for ${runId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
        }
      };
      const applyLive = () =>
        d.applyLive({
          tenant_id,
          site,
          direction_id: direction,
          stillOpen: async () => {
            const run = await d.loadRun(access_token, tenant_id, runId);
            const now = await d.loadSite(tenant_id, site.id);
            return !!run && !!now && pickWindow({ runStatus: run.status, goalGraph: run.goal_graph, site: now }) === null;
          },
        });
      if (parked) {
        let picked: { state: string };
        try {
          picked = await d.pickParked({ tenant_id, conductor_run_id: runId, direction, user_id: auth.user_id });
        } catch (e) {
          console.warn(`[site-design] parked pick failed for ${runId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
          res.status(503).json({ error: { code: "design_pick_failed", message: "Your pick did not save. Try again." } });
          return;
        }
        if (picked.state === "expired" || picked.state === "ended" || picked.state === "not_found") {
          res.status(409).json({ error: { code: "look_timed_out", reason: "ended", message: "Waiting for your pick timed out. Start the build again and pick a website." } });
          return;
        }
        if (picked.state === "sealed") {
          res.status(409).json({ error: { code: "look_locked", reason: "built", message: LOCKED_MESSAGE } });
          return;
        }
        if (picked.state === "picked") {
          if (row.chosen_direction !== direction || row.chosen_at === null) applyLive();
          await kick();
          const saved = (await d.store.get(tenant_id, site.id)) ?? row;
          res.json({ design: siteDesignView(saved, null, { site_name: siteNameOf(site) }), started: true });
          return;
        }
      }
      if (row.chosen_direction === direction && row.chosen_at !== null) {
        res.json({ design: siteDesignView(row, null, { site_name: siteNameOf(site) }), started: true });
        return;
      }
      const updated = await d.store.choose(tenant_id, site.id, direction, auth.user_id);
      if (!updated) {
        res.status(409).json({ error: { code: "look_locked", reason: "built", message: LOCKED_MESSAGE } });
        return;
      }
      applyLive();
      await kick();
      res.json({ design: siteDesignView(updated, null, { site_name: siteNameOf(site) }), started: true });
    } catch (e) {
      console.warn(`[site-design] pick failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      res.status(500).json({ error: { code: "design_pick_failed", message: "Your pick did not save. Try again." } });
    }
  };
}

export const getSiteDesign = makeGetSiteDesign();
export const postSiteDesignDirection = makePostSiteDesignDirection();
