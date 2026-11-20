import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import type { SiteRow, SiteSandbox, SiteStore } from "@/services/sites/contract";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteStore } from "@/services/sites/store";
import { siteIdFromEditsApp } from "@/services/sites/site-inline-edits";
import { getBoolSetting } from "@/services/settings";
import { estimateCost, fallbackChain } from "@/services/media-router/router";
import { priceUsd } from "@/services/media-router/prices";
import { chargeMedia, checkAffordMedia, mediaChargeRecorded, type ChargeOutcome, type PendingCharge } from "@/services/media-router/charge";
import { realDirectTextDeps } from "@/services/sites/site-text-direct";
import { readSandboxFiles, runDirectSiteChange, type DirectChangeDeps, type DirectChangeFile, type DirectChangePlan, type DirectChangeResult } from "@/services/sites/site-direct-change";
import {
  THEME_CSS_PATH,
  THEME_FONTS,
  THEME_RADII,
  applyThemeEdit,
  cleanThemeEdit,
  parseThemeCss,
  themeEditLabel,
  themeEditMessage,
  themeTokens,
  type ThemeTokens,
} from "@/services/sites/site-theme-edit";
import {
  SECTION_ID_RE,
  applySectionOp,
  describeSection,
  pageFileForPath,
  readSectionFiles,
  sectionEditMessage,
  sectionOpLabel,
  type SectionInfo,
  type SectionOp,
} from "@/services/sites/site-section-edit";
import {
  cleanImageRequest,
  imagePlan,
  imageReplaceMessage,
  photoPreview,
  prepareImage,
  type ImageReplaceDeps,
  type ImageReplaceOutcome,
  type PreparedImage,
} from "@/services/sites/site-image-replace";
import {
  cleanLogoRequest,
  generatedLogoUrl,
  generatedLogoPlan,
  logoBusinessFrom,
  logoGenerationMessage,
  nameOnlyLogoPlan,
  prepareGeneratedLogo,
  readLogoSnapshot,
  siteAppUsesLogo,
  type LogoGenerationDeps,
  type LogoRequest,
  type LogoSnapshot,
  type PreparedLogo,
  siteNameFrom,
} from "@/services/sites/site-logo-generate";
import { siteShownName } from "@/services/sites/label";
import { cleanPreviewId, previewDataUrl, realLogoPreviewStore, type LogoPreviewClaim, type LogoPreviewStore } from "@/services/sites/site-logo-preview";
import { designSiteLogo, logoDesignSummary, type LogoDesignInput, type LogoDesignSpec } from "@/services/sites/site-logo-design";
import { siteSourceWithLogo } from "@/services/sites/site-head";

const EDIT_ROLES = ["owner", "admin", "member"] as const;
export const SITE_DESIGN_EDIT_SETTING = "site_design_edit_direct";
export const SITE_IMAGE_AI_SETTING = "site_image_ai_edit";
export const SITE_IMAGE_MASK_SETTING = "site_image_ai_mask";
const MASK_OFF = "Changing part of a photo isn't on for this workspace. Change the whole photo instead.";
const PATH_RE = /^\/[A-Za-z0-9_\-./:%~]{0,200}$/;

export type SiteDirectEditDeps = {
  store: Pick<SiteStore, "get">;
  enabled: (tenant_id: string) => Promise<boolean>;
  imageAi: (tenant_id: string) => Promise<boolean>;
  imageMask: (tenant_id: string) => Promise<boolean>;
  logoAi: (tenant_id: string) => Promise<boolean>;
  change: DirectChangeDeps;
  slowLease: DirectChangeDeps["claimLease"];
  image: ImageReplaceDeps;
  logo: LogoGenerationDeps;
  logoPreviews: LogoPreviewStore;
  designContext?: (tenant_id: string, site_id: string) => Promise<LogoDesignContext | null>;
  businessBrief?: (tenant_id: string, site_id: string) => Promise<{ industry?: unknown; audience?: unknown; positioning?: unknown; facts?: unknown } | null>;
  charge: (a: PendingCharge) => Promise<ChargeOutcome>;
  chargeRecorded: (tenant_id: string, key: string) => Promise<boolean>;
  run?: typeof runDirectSiteChange;
};

export const SLOW_DIRECT_CHANGE_KINDS: ReadonlySet<string> = new Set(["image_generate", "image_edit", "logo"]);

export function directChangeDepsFor(deps: Pick<SiteDirectEditDeps, "change" | "slowLease">, kind: string): DirectChangeDeps {
  return SLOW_DIRECT_CHANGE_KINDS.has(kind) ? { ...deps.change, claimLease: deps.slowLease } : deps.change;
}

export function realSiteDirectEditDeps(): SiteDirectEditDeps {
  return {
    store: siteStore(),
    enabled: (tid) => getBoolSetting(SITE_DESIGN_EDIT_SETTING, tid),
    imageAi: (tid) => getBoolSetting(SITE_IMAGE_AI_SETTING, tid),
    imageMask: (tid) => getBoolSetting(SITE_IMAGE_MASK_SETTING, tid),
    logoAi: async () => (await import("@/services/media-router/router")).isTaskConfiguredWithFallback("image.vector"),
    change: realDirectTextDeps(),
    slowLease: async (tenant_id, site_id) =>
      (await import("@/services/sites/site-preview-lease")).claimSiteDirectChangeLease(tenant_id, site_id),
    image: realImageReplaceDeps(),
    logo: realLogoGenerationDeps(),
    logoPreviews: realLogoPreviewStore(),
    businessBrief: async (tenant_id, site_id) => (await (await import("@/services/sites/site-design-store")).siteDesignStore().get(tenant_id, site_id))?.brief ?? null,
    designContext: async (tenant_id, site_id) =>
      logoDesignContextFrom((await (await import("@/services/sites/site-design-store")).siteDesignStore().get(tenant_id, site_id))?.brief ?? null),
    charge: chargeMedia,
    chargeRecorded: mediaChargeRecorded,
  };
}

export function realLogoGenerationDeps(): LogoGenerationDeps {
  return {
    configured: async (task) => (await import("@/services/media-router/router")).isTaskConfiguredWithFallback(task),
    estimate: async (task, req) => {
      const chain = await fallbackChain(task);
      return Math.max(estimateCost(task, req), ...chain.map((route) => priceUsd(route, req, {})));
    },
    afford: (tenant_id, cost_usd) => checkAffordMedia(tenant_id, cost_usd),
    generate: async (task, req) => {
      const { generateMediaWithFallback } = await import("@/services/media-router/router");
      const result = await generateMediaWithFallback(task, req, { pollDelayMs: 2_000, maxPolls: 45 });
      return result.ok
        ? { ok: true, url: result.url, cost_usd: result.cost_usd, model: result.model }
        : { ok: false, reason: result.reason, error: result.error };
    },
    download: async (url, maxBytes) => (await import("@/services/media-router/router")).downloadMedia(url, maxBytes),
    design: (input) => designSiteLogo(input),
  };
}

export function logoSiteName(ctx: Pick<Ctx, "site">, siteSource: string | null | undefined): string {
  return siteNameFrom(siteSource).trim() || siteShownName(ctx.site);
}

export type LogoDesignContext = Pick<LogoDesignInput, "business" | "industry" | "mood" | "audience" | "positioning">;

export function logoDesignContextFrom(brief: unknown): LogoDesignContext | null {
  const b = brief as { industry?: unknown; audience?: unknown; positioning?: unknown; facts?: unknown } | null;
  if (!b || typeof b !== "object") return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const industry = text(b.industry, 80);
  const audience = text(b.audience, 140);
  const positioning = text(b.positioning, 160);
  const offers = Array.isArray(b.facts) ? b.facts.map((f) => text(f, 90)).filter(Boolean).slice(0, 2) : [];
  const business = [industry, offers.length ? `offering ${offers.join(", ")}` : ""].filter(Boolean).join(", ");
  if (!business && !audience && !positioning) return null;
  return { business, industry: industry || null, audience: audience || null, positioning: positioning || null };
}

async function designFor(
  deps: SiteDirectEditDeps,
  ctx: Ctx,
  request: LogoRequest,
  colors: { primary: string; accent: string } | null,
  shownName?: string,
): Promise<LogoDesignSpec | null> {
  const design = deps.logo.design;
  if (!design) return null;
  const site_name = shownName || siteShownName(ctx.site);
  const context = deps.designContext ? await deps.designContext(ctx.tenant_id, ctx.site.id).catch(() => null) : null;
  const out = await design({
    site_name,
    business: context?.business || site_name,
    direction: request.description,
    industry: context?.industry ?? null,
    mood: context?.mood ?? null,
    audience: context?.audience ?? null,
    positioning: context?.positioning ?? null,
    primary: colors?.primary ?? null,
    accent: colors?.accent ?? null,
  }).catch(() => null);
  if (out?.reason) {
    void import("@/services/logging/logEvent")
      .then(({ logEvent }) =>
        logEvent({
          level: "warn",
          source: "site-logo",
          code: "site_logo.design_fallback",
          tenant_id: ctx.tenant_id,
          meta: { design_reason: out.reason!.split(":")[0]!.slice(0, 40), design_ms: out.ms, design_source: out.spec.source },
        }),
      )
      .catch(() => undefined);
  }
  return out?.spec ?? null;
}

export function realImageReplaceDeps(): ImageReplaceDeps {
  return {
    configured: async (task) => (await import("@/services/media-router/router")).isTaskConfiguredWithFallback(task),
    estimate: async (task, req) => {
      const chain = await fallbackChain(task);
      return Math.max(estimateCost(task, req), ...chain.map((r) => priceUsd(r, req, {})));
    },
    afford: (tenant_id, cost_usd) => checkAffordMedia(tenant_id, cost_usd),
    generate: async (task, req) => {
      const { generateMediaWithFallback, isMediaRouterEnabled, routeImage } = await import("@/services/media-router/router");
      if (await isMediaRouterEnabled()) {
        const r = await generateMediaWithFallback(task, req, { pollDelayMs: 2_000, maxPolls: 45 });
        return r.ok ? { ok: true, url: r.url, cost_usd: r.cost_usd, model: r.model } : { ok: false, reason: r.reason, error: r.error };
      }
      const r = await routeImage(task, req);
      return r.ok ? { ok: true, url: r.imageUrl, cost_usd: r.cost_usd, model: r.model } : { ok: false, reason: r.reason, error: r.error };
    },
    download: async (url, max) => (await import("@/services/media-router/router")).downloadMedia(url, max),
    fetchPublic: async (url) => (await import("@/services/sites/pinned-image-fetch")).fetchPublicImage(url),
    shareReference: async (tenant_id, bytes) => {
      const [{ asTenantId, tenantStorage }, { randomUUID }] = await Promise.all([import("@/services/tenant-client"), import("node:crypto")]);
      const store = tenantStorage(asTenantId(tenant_id)).from("agent-artifacts");
      const path = `${tenant_id.toLowerCase()}/site-image-edits/${randomUUID()}.png`;
      const up = await store.upload(path, Buffer.from(bytes), { contentType: "image/png", upsert: false });
      if (up.error) return null;
      const signed = await store.createSignedUrl(path, 15 * 60);
      const done = async () => {
        await store.remove([path]);
      };
      if (signed.error || !signed.data?.signedUrl) {
        await done().catch(() => undefined);
        return null;
      }
      return { url: signed.data.signedUrl, done };
    },
  };
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

type Ctx = { tenant_id: string; site: SiteRow };

async function siteFor(req: Request, res: Response, deps: SiteDirectEditDeps, appId: unknown, write: boolean): Promise<Ctx | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (write && !(await requireTenantRole(auth, EDIT_ROLES, res))) return null;
  if (!(await isProductBuilderEnabled())) {
    refuse(res, 403, "product_builder_disabled", "Product builder is not enabled.");
    return null;
  }
  const site_id = siteIdFromEditsApp(appId);
  if (!site_id) {
    refuse(res, 400, "not_a_site", "app_id must name a site (site:<id>).");
    return null;
  }
  const tid = auth.tenant_id;
  let site: SiteRow | null;
  try {
    site = await deps.store.get(tid, site_id);
  } catch {
    refuse(res, 503, "site_unreadable", "We couldn't read this site. Nothing was changed. Try again.");
    return null;
  }
  if (!site || site.tenant_id !== tid || site.id !== site_id || !isVisibleSite(site)) {
    refuse(res, 403, "not_your_app", "this site is not registered to your workspace");
    return null;
  }
  if (!(site.root_conductor_run_id ?? "").trim()) {
    refuse(res, 409, "site_unavailable", "This site has no build to change yet.");
    return null;
  }
  if (!(await deps.enabled(tid).catch(() => false))) {
    refuse(res, 403, "direct_edit_off", "Instant edits are off for this workspace. Ask for the change in the chat.");
    return null;
  }
  return { tenant_id: tid, site };
}

async function maskOn(deps: SiteDirectEditDeps, tenant_id: string): Promise<boolean> {
  const [ai, mask] = await Promise.all([deps.imageAi(tenant_id).catch(() => false), deps.imageMask(tenant_id).catch(() => false)]);
  return ai && mask;
}

function cleanPath(raw: unknown): string | null {
  return typeof raw === "string" && PATH_RE.test(raw.trim()) ? raw.trim() : null;
}

export function cleanSectionOp(raw: unknown): SectionOp | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = typeof r.section_id === "string" ? r.section_id.trim() : "";
  if (!SECTION_ID_RE.test(id)) return null;
  if (typeof r.variant === "string") return { kind: "variant", section_id: id, variant: r.variant };
  if (typeof r.tone === "string") return { kind: "tone", section_id: id, tone: r.tone };
  if (r.move === "up" || r.move === "down") return { kind: "move", section_id: id, direction: r.move };
  return null;
}

export function directChangeMessage(reason: string): string {
  if (reason === "preview_starting") return "Your preview is starting up. Try again in a minute.";
  if (reason === "lease_held" || reason === "build_active") return "Another change to this site is running. Try again when it finishes.";
  if (reason === "behind_main" || reason === "changed") return "This site changed since the preview loaded. Reload the preview and try again.";
  if (reason === "sandbox_unavailable") return "The preview isn't running right now. Open the preview and try again.";
  return "We couldn't save that change. Nothing was changed. Try again, or ask for it in the chat.";
}

function failStatus(reason: string): number {
  if (reason === "sandbox_unavailable") return 503;
  return reason === "lease_held" || reason === "preview_starting" || reason === "build_active" || reason === "behind_main" || reason === "changed" ? 409 : 422;
}

export async function handleGetSiteDesignEdit(req: Request, res: Response, deps: SiteDirectEditDeps): Promise<void> {
  const ctx = await siteFor(req, res, deps, req.query?.app_id, false);
  if (!ctx) return;
  if (req.query?.photo !== undefined) {
    if (!(await maskOn(deps, ctx.tenant_id))) return refuse(res, 403, "image_mask_off", MASK_OFF);
    const sandbox = await deps.change.sandboxFor(ctx.tenant_id, ctx.site.id).catch(() => null);
    if (!sandbox) return refuse(res, 503, "sandbox_unavailable", directChangeMessage("sandbox_unavailable"));
    const photo = typeof req.query.photo === "string" ? await photoPreview(sandbox, req.query.photo).catch(() => null) : null;
    if (!photo) return refuse(res, 422, "image_missing", imageReplaceMessage("image_missing"));
    res.json({ photo });
    return;
  }
  const sectionId = typeof req.query?.section === "string" ? req.query.section.trim() : "";
  const path = cleanPath(req.query?.path) ?? "/";
  const sandbox = await deps.change.sandboxFor(ctx.tenant_id, ctx.site.id).catch(() => null);
  if (!sandbox) {
    refuse(res, 503, "sandbox_unavailable", directChangeMessage("sandbox_unavailable"));
    return;
  }
  let theme: ThemeTokens | null = null;
  try {
    const [css] = await readSandboxFiles(sandbox, [THEME_CSS_PATH]);
    const preset = css ? parseThemeCss(css.content) : null;
    theme = preset ? themeTokens(preset) : null;
  } catch {
    theme = null;
  }
  let section: SectionInfo | null = null;
  let section_message: string | null = null;
  if (sectionId) {
    const read = await readSectionFiles(sandbox).catch(() => null);
    const info = read
      ? describeSection(read.files, sectionId, pageFileForPath(read.app, path, read.files.map((f) => f.path)))
      : ({ error: "unreadable_source" } as const);
    if ("error" in info) section_message = sectionEditMessage(info.error);
    else section = info;
  }
  res.json({
    theme,
    fonts: THEME_FONTS,
    radii: THEME_RADII,
    section,
    section_message,
    image_ai: await deps.imageAi(ctx.tenant_id).catch(() => false),
    image_ai_mask: await maskOn(deps, ctx.tenant_id),
    logo_ai: await deps.logoAi(ctx.tenant_id).catch(() => false),
    logo_preview_free: !(await deps.logoPreviews.freeUsed(ctx.tenant_id, ctx.site.id).catch(() => true)),
  });
}

export async function handlePostSiteDesignEdit(req: Request, res: Response, deps: SiteDirectEditDeps): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ctx = await siteFor(req, res, deps, body.app_id, true);
  if (!ctx) return;
  const op = body.op && typeof body.op === "object" ? (body.op as Record<string, unknown>) : {};
  const run = deps.run ?? runDirectSiteChange;
  const path = cleanPath(body.path) ?? "/";

  if (op.kind === "theme") {
    const hasLogo = op.logo !== undefined && op.logo !== null;
    const nameOnly = hasLogo && (op.logo as Record<string, unknown>).name_only === true;
    const previewId = hasLogo && !nameOnly ? cleanPreviewId((op.logo as Record<string, unknown> | null)?.preview_id) : null;
    if (hasLogo && !nameOnly && !previewId) return refuse(res, 400, "bad_request", "Make a logo on the Logo tab first.");
    const edit = cleanThemeEdit(op);
    if (edit && "error" in edit) return refuse(res, 400, edit.error, themeEditMessage(edit.error));
    if (!edit && !previewId && !nameOnly) return refuse(res, 400, "bad_request", "Nothing to change.");
    let previewSvg: string | null = null;
    if (previewId) {
      const row = await deps.logoPreviews.get(ctx.tenant_id, ctx.site.id, previewId).catch(() => undefined);
      if (row === undefined) return refuse(res, 503, "logo_preview_unreadable", "We couldn't read that logo. Nothing was changed. Try again.");
      if (!row?.svg) return refuse(res, 422, "logo_preview_missing", LOGO_PREVIEW_MISSING);
      previewSvg = row.svg;
    }
    let tokens: ThemeTokens | null = null;
    let refusal: string | null = null;
    const result = await run(
      {
        tenant_id: ctx.tenant_id,
        site: ctx.site,
        kind: previewSvg || nameOnly ? (edit ? "theme_logo" : "logo_apply") : "theme",
        plan: async (sandbox: SiteSandbox): Promise<DirectChangePlan> => {
          const files: DirectChangeFile[] = [];
          let nextTheme: string | null = null;
          if (edit) {
            const [css] = await readSandboxFiles(sandbox, [THEME_CSS_PATH]);
            const next = css ? applyThemeEdit(css.content, edit) : ({ error: "not_platform_theme" } as const);
            if (!css || "error" in next) {
              const error = "error" in next ? next.error : "not_platform_theme";
              refusal = themeEditMessage(error);
              return { reason: error };
            }
            tokens = next.tokens;
            nextTheme = next.css;
            files.push({ path: THEME_CSS_PATH, before: css.content, after: next.css });
          }
          if (previewSvg) {
            const snapshot = await readLogoSnapshot(sandbox);
            if (!logoSlotOk(snapshot)) return { reason: "logo_slot_unavailable" };
            const logo = await generatedLogoPlan({ svg: previewSvg }, snapshot)(sandbox);
            if ("reason" in logo) return logo;
            files.push(...logo.files);
          }
          if (nameOnly) {
            const snapshot = await readLogoSnapshot(sandbox);
            if (!logoSlotOk(snapshot)) return { reason: "logo_slot_unavailable" };
            const logo = await nameOnlyLogoPlan(snapshot, logoSiteName(ctx, snapshot.site), { themeCss: nextTheme })(sandbox);
            if ("reason" in logo) return logo;
            files.push(...logo.files);
          }
          const label = nameOnly && !edit ? "Showed the site name without a logo" : "Changed the site logo";
          return { files, label: edit ? themeEditLabel(edit, previewSvg || nameOnly ? ["logo"] : []) : label };
        },
      },
      directChangeDepsFor(deps, "theme"),
    );
    return answer(res, result, refusal ?? (previewSvg || nameOnly ? logoRefusal(result) : null), {
      theme: tokens,
      ...(previewSvg ? { logo: result.ok ? { src: generatedLogoUrl(previewSvg) } : null } : {}),
      ...(nameOnly ? { logo: null } : {}),
    });
  }

  if (op.kind === "logo_preview") {
    const request = cleanLogoRequest(op);
    if (!request) return refuse(res, 400, "bad_request", "Describe the logo in 3 to 400 characters.");
    if (!(await deps.logoAi(ctx.tenant_id).catch(() => false))) {
      return refuse(res, 403, "logo_ai_off", logoGenerationMessage("not_configured"));
    }
    const sandbox = await deps.change.sandboxFor(ctx.tenant_id, ctx.site.id).catch(() => null);
    if (!sandbox) return refuse(res, 503, "sandbox_unavailable", directChangeMessage("sandbox_unavailable"));
    const snapshot = await readLogoSnapshot(sandbox).catch(() => null);
    if (!snapshot || !logoSlotOk(snapshot)) return refuse(res, 422, "logo_slot_unavailable", LOGO_SLOT_UNAVAILABLE);
    let palette = cleanPreviewColors(op.colors);
    if (!palette) {
      const css = await readSandboxFiles(sandbox, [THEME_CSS_PATH]).then((f) => f[0]?.content ?? null).catch(() => null);
      const preset = css ? parseThemeCss(css) : null;
      palette = preset ? themeTokens(preset).colors : null;
    }
    let claim: LogoPreviewClaim;
    try {
      claim = await deps.logoPreviews.claim(ctx.tenant_id, ctx.site.id, request.description);
    } catch {
      return refuse(res, 503, "logo_preview_unavailable", "We couldn't start the logo. Nothing was run or charged. Try again.");
    }
    const business = logoBusinessFrom(await deps.businessBrief?.(ctx.tenant_id, ctx.site.id).catch(() => null), snapshot.site);
    const shownName = logoSiteName(ctx, snapshot.site);
    const made = await prepareGeneratedLogo(
      {
        tenant_id: ctx.tenant_id,
        site_name: shownName,
        request,
        ...(palette ? { primary: palette.primary, accent: palette.accent } : {}),
        zaviPays: claim.free,
        designLater: () => designFor(deps, ctx, request, palette, shownName),
        business,
      },
      deps.logo,
    ).catch(() => ({ reason: "generation_failed" as const }));
    if ("reason" in made) {
      await deps.logoPreviews.drop(ctx.tenant_id, claim.id).catch(() => undefined);
      if (made.reason === "insufficient_credits") return refuse(res, 402, made.reason, logoGenerationMessage(made.reason));
      if (made.reason === "credits_unavailable") return refuse(res, 503, made.reason, logoGenerationMessage(made.reason));
      return refuse(res, 422, made.reason, logoGenerationMessage(made.reason));
    }
    try {
      await deps.logoPreviews.finish(ctx.tenant_id, claim.id, { svg: made.svg, model: made.model, cost_usd: made.charge.cost_usd });
    } catch {
      await deps.logoPreviews.drop(ctx.tenant_id, claim.id).catch(() => undefined);
      return refuse(res, 503, "logo_preview_unavailable", "We couldn't keep that logo. Nothing was charged. Try again.");
    }
    const chargeKey = `site_logo_preview:${claim.id}`;
    let charged = claim.free
      ? null
      : await chargeLanded(deps, {
          tenant_id: ctx.tenant_id,
          run_id: null,
          key: chargeKey,
          cost_usd: made.charge.cost_usd,
          task: made.charge.task,
          model: made.model,
        });
    if (charged === "error") {
      const landed = await deps.chargeRecorded(ctx.tenant_id, chargeKey).catch(() => null);
      if (landed === true) {
        charged = "charged";
      } else {
        await deps.logoPreviews.drop(ctx.tenant_id, claim.id).catch(() => undefined);
        return refuse(res, 503, "credits_unavailable", "We couldn't charge for that logo, so it wasn't kept. Try again in a minute.");
      }
    }
    res.json({
      ok: true,
      preview: { id: claim.id, src: previewDataUrl(made.svg), free: claim.free, ...(made.design ? { design: logoDesignSummary(made.design) } : {}) },
      ...(charged ? { charged } : {}),
    });
    return;
  }

  if (op.kind === "logo_preview") {
    const request = cleanLogoRequest(op);
    if (!request) return refuse(res, 400, "bad_request", "Describe the logo in 3 to 400 characters.");
    if (!(await deps.logoAi(ctx.tenant_id).catch(() => false))) {
      return refuse(res, 403, "logo_ai_off", logoGenerationMessage("not_configured"));
    }
    const sandbox = await deps.change.sandboxFor(ctx.tenant_id, ctx.site.id).catch(() => null);
    if (!sandbox) return refuse(res, 503, "sandbox_unavailable", directChangeMessage("sandbox_unavailable"));
    const snapshot = await readLogoSnapshot(sandbox).catch(() => null);
    if (!snapshot || !logoSlotOk(snapshot)) return refuse(res, 422, "logo_slot_unavailable", LOGO_SLOT_UNAVAILABLE);
    let palette = cleanPreviewColors(op.colors);
    if (!palette) {
      const css = await readSandboxFiles(sandbox, [THEME_CSS_PATH]).then((f) => f[0]?.content ?? null).catch(() => null);
      const preset = css ? parseThemeCss(css) : null;
      palette = preset ? themeTokens(preset).colors : null;
    }
    let claim: LogoPreviewClaim;
    try {
      claim = await deps.logoPreviews.claim(ctx.tenant_id, ctx.site.id, request.description);
    } catch {
      return refuse(res, 503, "logo_preview_unavailable", "We couldn't start the logo. Nothing was run or charged. Try again.");
    }
    const made = await prepareGeneratedLogo(
      {
        tenant_id: ctx.tenant_id,
        site_name: siteShownName(ctx.site),
        request,
        ...(palette ? { primary: palette.primary, accent: palette.accent } : {}),
        zaviPays: claim.free,
      },
      deps.logo,
    ).catch(() => ({ reason: "generation_failed" as const }));
    if ("reason" in made) {
      await deps.logoPreviews.drop(ctx.tenant_id, claim.id).catch(() => undefined);
      if (made.reason === "insufficient_credits") return refuse(res, 402, made.reason, logoGenerationMessage(made.reason));
      if (made.reason === "credits_unavailable") return refuse(res, 503, made.reason, logoGenerationMessage(made.reason));
      return refuse(res, 422, made.reason, logoGenerationMessage(made.reason));
    }
    try {
      await deps.logoPreviews.finish(ctx.tenant_id, claim.id, { svg: made.svg, model: made.model, cost_usd: made.charge.cost_usd });
    } catch {
      await deps.logoPreviews.drop(ctx.tenant_id, claim.id).catch(() => undefined);
      return refuse(res, 503, "logo_preview_unavailable", "We couldn't keep that logo. Nothing was charged. Try again.");
    }
    const chargeKey = `site_logo_preview:${claim.id}`;
    let charged = claim.free
      ? null
      : await chargeLanded(deps, {
          tenant_id: ctx.tenant_id,
          run_id: null,
          key: chargeKey,
          cost_usd: made.charge.cost_usd,
          task: made.charge.task,
          model: made.model,
        });
    if (charged === "error") {
      const landed = await deps.chargeRecorded(ctx.tenant_id, chargeKey).catch(() => null);
      if (landed === true) {
        charged = "charged";
      } else {
        await deps.logoPreviews.drop(ctx.tenant_id, claim.id).catch(() => undefined);
        return refuse(res, 503, "credits_unavailable", "We couldn't charge for that logo, so it wasn't kept. Try again in a minute.");
      }
    }
    res.json({ ok: true, preview: { id: claim.id, src: previewDataUrl(made.svg), free: claim.free }, ...(charged ? { charged } : {}) });
    return;
  }

  if (op.kind === "section") {
    const sop = cleanSectionOp(op);
    if (!sop) return refuse(res, 400, "bad_request", "Pick a section and what to change.");
    let info: SectionInfo | null = null;
    let refusal: string | null = null;
    let label = "";
    const result = await run(
      {
        tenant_id: ctx.tenant_id,
        site: ctx.site,
        kind: "section",
        plan: async (sandbox: SiteSandbox): Promise<DirectChangePlan> => {
          const read = await readSectionFiles(sandbox);
          const out = read
            ? applySectionOp(read.files, sop, pageFileForPath(read.app, path, read.files.map((f) => f.path)))
            : ({ error: "unreadable_source" } as const);
          if ("error" in out) {
            refusal = sectionEditMessage(out.error);
            return { reason: out.error };
          }
          info = out.info;
          label = sectionOpLabel(sop, out.info);
          return { files: [{ path: out.path, before: out.before, after: out.after }], label };
        },
      },
      directChangeDepsFor(deps, "section"),
    );
    return answer(res, result, refusal, { section: info });
  }

  if (op.kind === "image") {
    const request = cleanImageRequest(op);
    if (!request && op.mask !== undefined && op.mask !== null) return refuse(res, 400, "bad_request", imageReplaceMessage("mask_unreadable"));
    if (!request) return refuse(res, 400, "bad_request", "Describe the photo (3-600 characters), or paste an https address.");
    if (request.mode !== "url" && !(await deps.imageAi(ctx.tenant_id).catch(() => false))) {
      return refuse(res, 403, "image_ai_off", "AI photos aren't on for this workspace yet. Paste a photo address instead.");
    }
    if (request.mask && !(await maskOn(deps, ctx.tenant_id))) return refuse(res, 403, "image_mask_off", MASK_OFF);
    const prepared: { value: PreparedImage | null } = { value: null };
    const outcome: { value: ImageReplaceOutcome | null } = { value: null };
    const result = await run(
      {
        tenant_id: ctx.tenant_id,
        site: ctx.site,
        kind: `image_${request.mode}`,
        plan: async (sandbox) => {
          const made = await prepareImage(sandbox, { tenant_id: ctx.tenant_id, site_id: ctx.site.id, request }, deps.image).catch(
            () => ({ reason: "generation_failed" as const }),
          );
          if ("reason" in made) return made;
          prepared.value = made;
          return imagePlan(made, outcome)(sandbox);
        },
      },
      directChangeDepsFor(deps, `image_${request.mode}`),
    );
    if (!result.ok && (result.reason === "insufficient_credits" || result.reason === "credits_unavailable")) {
      const status = result.reason === "insufficient_credits" ? 402 : 503;
      return refuse(res, status, result.reason, imageReplaceMessage(result.reason));
    }
    let charged: ChargeOutcome | null = null;
    if (result.ok && prepared.value?.charge) {
      charged = await chargeLanded(deps, {
        tenant_id: ctx.tenant_id,
        run_id: null,
        key: `site_image_edit:${result.commit_sha}`,
        cost_usd: prepared.value.charge.cost_usd,
        task: prepared.value.charge.task,
        model: prepared.value.model,
      });
    }
    const refusal = result.ok ? null : imageReplaceMessage(result.reason) || null;
    return answer(res, result, refusal, { image: outcome.value, ...(charged ? { charged } : {}) });
  }

  if (op.kind === "logo") {
    const request = cleanLogoRequest(op);
    if (!request) return refuse(res, 400, "bad_request", "Describe the logo in 3 to 400 characters.");
    if (!(await deps.logoAi(ctx.tenant_id).catch(() => false))) {
      return refuse(res, 403, "logo_ai_off", logoGenerationMessage("not_configured"));
    }
    const logoOutcome: { prepared: PreparedLogo | null } = { prepared: null };
    const brief = (await deps.businessBrief?.(ctx.tenant_id, ctx.site.id).catch(() => null)) ?? null;
    const result = await run(
      {
        tenant_id: ctx.tenant_id,
        site: ctx.site,
        kind: "logo",
        plan: async (sandbox) => {
          const themeFile = await readSandboxFiles(sandbox, [THEME_CSS_PATH]).then((files) => files[0]?.content ?? null);
          const preset = themeFile ? parseThemeCss(themeFile) : null;
          return logoPlan(sandbox, ctx, request, preset ? themeTokens(preset).colors : null, deps, logoOutcome, brief);
        },
      },
      directChangeDepsFor(deps, "logo"),
    );
    if (!result.ok && (result.reason === "insufficient_credits" || result.reason === "credits_unavailable")) {
      const status = result.reason === "insufficient_credits" ? 402 : 503;
      return refuse(res, status, result.reason, logoGenerationMessage(result.reason));
    }
    const charged = result.ok ? await chargeLogo(deps, ctx.tenant_id, result.commit_sha, logoOutcome.prepared) : null;
    return answer(res, result, logoRefusal(result), {
      logo:
        result.ok && logoOutcome.prepared
          ? { src: generatedLogoUrl(logoOutcome.prepared.svg), ...(logoOutcome.prepared.design ? { design: logoDesignSummary(logoOutcome.prepared.design) } : {}) }
          : null,
      ...(charged ? { charged } : {}),
    });
  }

  refuse(res, 400, "bad_request", "Unknown change.");
}

const LOGO_SLOT_UNAVAILABLE = "This site's header cannot show a generated logo yet. Nothing was run or charged.";
const LOGO_PREVIEW_MISSING = "That logo is no longer here. Make it again on the Logo tab.";

function logoSlotOk(snapshot: LogoSnapshot): boolean {
  return !!snapshot.site && !!snapshot.app && !!siteSourceWithLogo(snapshot.site) && siteAppUsesLogo(snapshot.app);
}

const HEX6 = /^#[0-9a-f]{6}$/i;

export function cleanPreviewColors(raw: unknown): { primary: string; accent: string } | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const primary = typeof r.primary === "string" ? r.primary.trim() : "";
  const accent = typeof r.accent === "string" ? r.accent.trim() : "";
  return HEX6.test(primary) && HEX6.test(accent) ? { primary: primary.toLowerCase(), accent: accent.toLowerCase() } : null;
}

async function logoPlan(
  sandbox: SiteSandbox,
  ctx: Ctx,
  request: LogoRequest,
  colors: { primary: string; accent: string } | null,
  deps: SiteDirectEditDeps,
  outcome: { prepared: PreparedLogo | null },
  brief: Parameters<typeof logoBusinessFrom>[0] = null,
): Promise<DirectChangePlan> {
  const snapshot = await readLogoSnapshot(sandbox);
  if (!logoSlotOk(snapshot)) return { reason: "logo_slot_unavailable" };
  const shownName = logoSiteName(ctx, snapshot.site);
  const generated = await prepareGeneratedLogo(
    {
      tenant_id: ctx.tenant_id,
      site_name: shownName,
      request,
      ...(colors ? { primary: colors.primary, accent: colors.accent } : {}),
      designLater: () => designFor(deps, ctx, request, colors, shownName),
      business: logoBusinessFrom(brief, snapshot.site),
    },
    deps.logo,
  ).catch(() => ({ reason: "generation_failed" as const }));
  if ("reason" in generated) return generated;
  outcome.prepared = generated;
  return generatedLogoPlan(generated, snapshot)(sandbox);
}

async function chargeLanded(deps: SiteDirectEditDeps, pending: PendingCharge): Promise<ChargeOutcome> {
  const first = await deps.charge(pending);
  return first === "error" ? deps.charge(pending) : first;
}

async function chargeLogo(deps: SiteDirectEditDeps, tenant_id: string, commit_sha: string, prepared: PreparedLogo | null): Promise<ChargeOutcome | null> {
  if (!prepared) return null;
  return chargeLanded(deps, {
    tenant_id,
    run_id: null,
    key: `site_logo_edit:${commit_sha}`,
    cost_usd: prepared.charge.cost_usd,
    task: prepared.charge.task,
    model: prepared.model,
  });
}

function logoRefusal(result: DirectChangeResult): string | null {
  if (result.ok || result.reason === "changed") return null;
  if (result.reason === "logo_slot_unavailable") return LOGO_SLOT_UNAVAILABLE;
  return ["not_configured", "generation_failed", "download_failed", "unsafe_svg"].includes(result.reason) ? logoGenerationMessage(result.reason) : null;
}

function answer(res: Response, result: DirectChangeResult, refusal: string | null, extra: Record<string, unknown>): void {
  if (!result.ok) {
    res.status(refusal ? 422 : failStatus(result.reason)).json({ error: { code: result.reason, message: refusal ?? directChangeMessage(result.reason) } });
    return;
  }
  res.json({ ok: true, commit_sha: result.commit_sha, conductor_run_id: result.conductor_run_id, ...extra });
}

export async function getSiteDesignEdit(req: Request, res: Response): Promise<void> {
  await handleGetSiteDesignEdit(req, res, realSiteDirectEditDeps());
}

export async function postSiteDesignEdit(req: Request, res: Response): Promise<void> {
  await handlePostSiteDesignEdit(req, res, realSiteDirectEditDeps());
}
