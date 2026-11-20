import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({ role: "owner" as string, builderOn: true, prepared: null as unknown, prepareCalls: 0 }));

const loggedEvents = vi.hoisted(() => [] as Array<{ code: string; meta?: Record<string, unknown> }>);
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async (e: { code: string; meta?: Record<string, unknown> }) => { loggedEvents.push(e); } }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", access_token: "tok" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: readonly string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(state.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => state.builderOn }));
vi.mock("@/services/sites/site-image-replace", async (orig) => ({
  ...(await orig<typeof import("@/services/sites/site-image-replace")>()),
  prepareImage: async () => {
    state.prepareCalls++;
    return state.prepared;
  },
  imagePlan: (_prepared: unknown, outcome: { value: unknown }) => async () => {
    outcome.value = { src: "/images/new.webp", srcset: "/images/new.webp 1280w", places: 1 };
    return { files: [], label: "Replaced a photo" };
  },
}));

import type { Request, Response } from "express";
import type { SiteRow } from "@/services/sites/contract";
import type { DirectChangeResult } from "@/services/sites/site-direct-change";
import { handleGetSiteDesignEdit, handlePostSiteDesignEdit, realLogoGenerationDeps, cleanSectionOp, type SiteDirectEditDeps } from "../site-direct-edits";
import { THEME_CSS_PATH, THEME_PRESETS, renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { themeTokens } from "@/services/sites/site-theme-edit";
import type { LogoPreviewStore } from "@/services/sites/site-logo-preview";

function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  const r = {
    status(n: number) {
      out.status = n;
      return r;
    },
    json(b: unknown) {
      out.body = b;
      return r;
    },
  };
  return { out, r: r as unknown as Response };
}

const site = { id: SITE, tenant_id: T, status: "live", root_conductor_run_id: "root-1", github_full_name: "o/r" } as unknown as SiteRow;

const PREVIEW_SVG = '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="20"/></svg>\n';

function fakePreviews() {
  const rows: Array<{ id: string; tenant_id: string; site_id: string; free: boolean; svg: string | null }> = [];
  let n = 0;
  const store: LogoPreviewStore & { rows: typeof rows } = {
    rows,
    claim: vi.fn(async (tenant_id: string, site_id: string) => {
      const free = !rows.some((r) => r.site_id === site_id && r.free);
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      rows.push({ id, tenant_id, site_id, free, svg: null });
      return { id, free };
    }),
    finish: vi.fn(async (tenant_id: string, id: string, made: { svg: string }) => {
      const r = rows.find((x) => x.id === id && x.tenant_id === tenant_id);
      if (r) r.svg = made.svg;
    }),
    drop: vi.fn(async (tenant_id: string, id: string) => {
      const i = rows.findIndex((x) => x.id === id && x.tenant_id === tenant_id);
      if (i >= 0) rows.splice(i, 1);
    }),
    freeUsed: vi.fn(async (_tenant_id: string, site_id: string) => rows.some((r) => r.site_id === site_id && r.free)),
    get: vi.fn(async (tenant_id: string, site_id: string, id: string) => {
      const r = rows.find((x) => x.id === id && x.tenant_id === tenant_id && x.site_id === site_id);
      return r ? { id: r.id, site_id: r.site_id, svg: r.svg } : null;
    }),
  };
  return store;
}

function deps(over: Partial<SiteDirectEditDeps> = {}): SiteDirectEditDeps & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    store: { get: vi.fn(async (tid: string, id: string) => (tid === T && id === SITE ? site : null)) },
    enabled: vi.fn(async () => true),
    imageAi: vi.fn(async () => false),
    imageMask: vi.fn(async () => true),
    logoAi: vi.fn(async () => false),
    change: {} as SiteDirectEditDeps["change"],
    slowLease: vi.fn(async () => ({ held: "unknown" as const })),
    image: {} as SiteDirectEditDeps["image"],
    logo: {} as SiteDirectEditDeps["logo"],
    logoPreviews: fakePreviews(),
    charge: vi.fn(async () => "charged" as const),
    chargeRecorded: vi.fn(async () => false),
    run: vi.fn(async (input: { kind: string; plan: (sandbox: unknown) => Promise<{ reason: string } | { files: unknown[]; label: string }> }): Promise<DirectChangeResult> => {
      runs.push(input.kind);
      if (input.kind.startsWith("image_")) {
        const plan = await input.plan({});
        if ("reason" in plan) return { ok: false, reason: plan.reason } as DirectChangeResult;
      }
      return { ok: true, commit_sha: "c".repeat(40), conductor_run_id: "run-1", files: [] };
    }) as unknown as SiteDirectEditDeps["run"],
    ...over,
  };
}

async function post(body: unknown, d: SiteDirectEditDeps) {
  const { out, r } = res();
  await handlePostSiteDesignEdit({ body } as Request, r, d);
  return out;
}

beforeEach(() => {
  state.role = "owner";
  state.builderOn = true;
  state.prepareCalls = 0;
});

const MASK = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64")}`;

function imageSpies() {
  return {
    configured: vi.fn(async () => true),
    estimate: vi.fn(async () => 0.05),
    afford: vi.fn(async () => "ok" as const),
    generate: vi.fn(),
    download: vi.fn(),
    fetchPublic: vi.fn(),
    shareReference: vi.fn(),
  } as unknown as SiteDirectEditDeps["image"] & Record<string, ReturnType<typeof vi.fn>>;
}

function untouched(image: ReturnType<typeof imageSpies>) {
  for (const f of Object.values(image)) expect(f).not.toHaveBeenCalled();
}

function paidDeps(over: Partial<SiteDirectEditDeps> = {}) {
  const sandboxFor = vi.fn(async () => ({}));
  const image = imageSpies();
  const d = deps({
    imageAi: vi.fn(async () => true),
    change: { sandboxFor } as unknown as SiteDirectEditDeps["change"],
    image,
    ...over,
  });
  return { d, image, sandboxFor };
}

async function get(query: Record<string, string>, d: SiteDirectEditDeps) {
  const { out, r } = res();
  await handleGetSiteDesignEdit({ query } as unknown as Request, r, d);
  return out;
}

describe("partial photo edits (a brushed mask)", () => {
  const masked = { kind: "image", src: "/images/a.webp", mode: "edit", text: "make the sky blue", mask: MASK };

  it("charges a masked edit once, keyed on its commit, and nothing when the commit or the vendor fails", async () => {
    state.prepared = { request: { mode: "edit" }, model: "m1", charge: { task: "image.edit", cost_usd: 0.04 } };
    const ok = paidDeps();
    const out = await post({ app_id: `site:${SITE}`, op: masked }, ok.d);
    expect(out.status).toBe(200);
    expect(ok.d.runs).toEqual(["image_edit"]);
    expect(ok.d.charge).toHaveBeenCalledTimes(1);
    expect(ok.d.charge).toHaveBeenCalledWith({ tenant_id: T, run_id: null, key: `site_image_edit:${"c".repeat(40)}`, cost_usd: 0.04, task: "image.edit", model: "m1" });

    const lost = paidDeps({ run: vi.fn(async () => ({ ok: false, reason: "changed" })) as unknown as SiteDirectEditDeps["run"] });
    expect((await post({ app_id: `site:${SITE}`, op: masked }, lost.d)).status).toBe(409);
    expect(lost.d.charge).not.toHaveBeenCalled();

    state.prepared = { reason: "generation_failed" };
    const vendor = paidDeps();
    const failed = await post({ app_id: `site:${SITE}`, op: masked }, vendor.d);
    expect(failed.status).toBe(422);
    expect(vendor.d.runs).toEqual(["image_edit"]);
    expect(vendor.d.charge).not.toHaveBeenCalled();
    state.prepared = null;
  });

  it("refuses a bad mask with 400 before the sandbox, the wallet or the vendor", async () => {
    const bad = [
      "data:image/jpeg;base64,/9j/4AAQ",
      `data:image/png;base64,${Buffer.from("GIF89a-not-a-png-at-all").toString("base64")}`,
      `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(800 * 1024)]).toString("base64")}`,
      12,
    ];
    for (const mask of bad) {
      const p = paidDeps();
      const out = await post({ app_id: `site:${SITE}`, op: { ...masked, mask } }, p.d);
      expect(out.status).toBe(400);
      expect((out.body as { error: { message: string } }).error.message).toContain("brushed area");
      expect(p.sandboxFor).not.toHaveBeenCalled();
      untouched(p.image);
      expect(p.d.charge).not.toHaveBeenCalled();
    }
    const onGenerate = paidDeps();
    expect((await post({ app_id: `site:${SITE}`, op: { ...masked, mode: "generate" } }, onGenerate.d)).status).toBe(400);
    expect(state.prepareCalls).toBe(0);
  });

  it("refuses a mask when the mask switch is off, while a whole-photo edit still runs and charges", async () => {
    state.prepared = { request: { mode: "edit" }, model: "m1", charge: { task: "image.edit", cost_usd: 0.04 } };
    const off = paidDeps({ imageMask: vi.fn(async () => false) });
    const refused = await post({ app_id: `site:${SITE}`, op: masked }, off.d);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe("image_mask_off");
    expect(off.sandboxFor).not.toHaveBeenCalled();
    expect(state.prepareCalls).toBe(0);
    untouched(off.image);
    const whole = await post({ app_id: `site:${SITE}`, op: { ...masked, mask: undefined } }, off.d);
    expect(whole.status).toBe(200);
    expect(off.d.charge).toHaveBeenCalledTimes(1);

    const aiOff = paidDeps({ imageAi: vi.fn(async () => false) });
    expect((await post({ app_id: `site:${SITE}`, op: masked }, aiOff.d)).status).toBe(403);
    expect(aiOff.sandboxFor).not.toHaveBeenCalled();
    state.prepared = null;
  });

  it("tells the editor the brush is on only when both switches are on, and serves the photo only then", async () => {
    const both = paidDeps();
    expect(((await get({ app_id: `site:${SITE}` }, both.d)).body as { image_ai_mask: boolean }).image_ai_mask).toBe(true);
    const maskOff = paidDeps({ imageMask: vi.fn(async () => false) });
    expect(((await get({ app_id: `site:${SITE}` }, maskOff.d)).body as { image_ai_mask: boolean }).image_ai_mask).toBe(false);
    const aiOff = paidDeps({ imageAi: vi.fn(async () => false) });
    expect(((await get({ app_id: `site:${SITE}` }, aiOff.d)).body as { image_ai_mask: boolean }).image_ai_mask).toBe(false);
    const fresh = paidDeps({ imageMask: vi.fn(async () => false) });
    const photoOff = await get({ app_id: `site:${SITE}`, photo: "/images/a.webp" }, fresh.d);
    expect(photoOff.status).toBe(403);
    expect(fresh.sandboxFor).not.toHaveBeenCalled();
    const missing = await get({ app_id: `site:${SITE}`, photo: "/images/a.webp" }, paidDeps({ change: { sandboxFor: vi.fn(async () => ({ readFile: async () => { throw new Error("gone"); } })) } as unknown as SiteDirectEditDeps["change"] }).d);
    expect(missing.status).toBe(422);
  });
});

describe("POST /api/website/site-design-edit", () => {
  it("runs a valid theme edit for a member", async () => {
    state.role = "member";
    const d = deps();
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "theme", colors: { primary: "#112233" } } }, d);
    expect(out.status).toBe(200);
    expect(d.runs).toEqual(["theme"]);
  });

  it("refuses viewers, other sites, the kill switch and bad input before any change", async () => {
    state.role = "viewer";
    const d = deps();
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "theme", radius: "0" } }, d)).status).toBe(403);
    state.role = "owner";
    expect((await post({ app_id: "site:bbbbbbbb-0000-4000-8000-000000000002", op: { kind: "theme", radius: "0" } }, d)).status).toBe(403);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "theme", radius: "0" } }, deps({ enabled: vi.fn(async () => false) }))).status).toBe(403);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "theme", colors: { primary: "blue" } } }, d)).status).toBe(400);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "section", section_id: "hero" } }, d)).status).toBe(400);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "nope" } }, d)).status).toBe(400);
    expect(d.runs).toEqual([]);
  });

  it("charges a paid photo once, after it is committed, keyed on the commit, to the caller's tenant", async () => {
    state.prepared = { request: { mode: "generate" }, model: "m1", charge: { task: "image.hero", cost_usd: 0.04 } };
    const d = deps({ imageAi: vi.fn(async () => true), change: { sandboxFor: vi.fn(async () => ({})) } as unknown as SiteDirectEditDeps["change"] });
    const out = await post({ app_id: `site:${SITE}`, tenant_id: "someone-else", op: { kind: "image", src: "/images/a.webp", mode: "generate", text: "a quiet workshop" } }, d);
    expect(out.status).toBe(200);
    expect(d.charge).toHaveBeenCalledTimes(1);
    expect(d.charge).toHaveBeenCalledWith({ tenant_id: T, run_id: null, key: `site_image_edit:${"c".repeat(40)}`, cost_usd: 0.04, task: "image.hero", model: "m1" });
    const failed = deps({
      imageAi: vi.fn(async () => true),
      change: { sandboxFor: vi.fn(async () => ({})) } as unknown as SiteDirectEditDeps["change"],
      run: vi.fn(async () => ({ ok: false, reason: "behind_main" })) as unknown as SiteDirectEditDeps["run"],
    });
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "image", src: "/images/a.webp", mode: "edit", text: "make it sunny" } }, failed)).status).toBe(409);
    expect(failed.charge).not.toHaveBeenCalled();
    state.prepared = { reason: "insufficient_credits" };
    const short = deps({ imageAi: vi.fn(async () => true), change: { sandboxFor: vi.fn(async () => ({})) } as unknown as SiteDirectEditDeps["change"] });
    const r = await post({ app_id: `site:${SITE}`, op: { kind: "image", src: "/images/a.webp", mode: "generate", text: "a quiet workshop" } }, short);
    expect(r.status).toBe(402);
    expect(short.runs).toEqual(["image_generate"]);
    expect(short.charge).not.toHaveBeenCalled();
    state.prepared = null;
  });

  it("takes the site lease before checking the wallet or calling the image vendor", async () => {
    state.prepared = { request: { mode: "generate" }, model: "m1", charge: { task: "image.hero", cost_usd: 0.04 } };
    const image = imageSpies();
    const d = deps({
      imageAi: vi.fn(async () => true),
      image,
      run: vi.fn(async () => ({ ok: false, reason: "lease_held" })) as unknown as SiteDirectEditDeps["run"],
    });
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "image", src: "/images/a.webp", mode: "generate", text: "a quiet workshop" } }, d);
    expect(out.status).toBe(409);
    expect(state.prepareCalls).toBe(0);
    untouched(image);
    expect(d.charge).not.toHaveBeenCalled();
    state.prepared = null;
  });

  it("keeps AI photos off until the workspace setting is on, but allows a pasted address", async () => {
    const d = deps();
    const ai = await post({ app_id: `site:${SITE}`, op: { kind: "image", src: "/images/a.webp", mode: "generate", text: "a quiet workshop" } }, d);
    expect(ai.status).toBe(403);
    expect((ai.body as { error: { code: string } }).error.code).toBe("image_ai_off");
    const url = await post(
      { app_id: `site:${SITE}`, op: { kind: "image", src: "/images/a.webp", mode: "url", text: "https://p.example/a.jpg" } },
      deps({ run: vi.fn(async () => ({ ok: false, reason: "sandbox_unavailable" })) as unknown as SiteDirectEditDeps["run"] }),
    );
    expect(url.status).toBe(503);
  });

  it("maps a busy site to 409 with plain words", async () => {
    const d = deps({ run: vi.fn(async () => ({ ok: false, reason: "lease_held" })) as unknown as SiteDirectEditDeps["run"] });
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "section", section_id: "hero", move: "down" } }, d);
    expect(out.status).toBe(409);
    expect((out.body as { error: { message: string } }).error.message).toContain("Another change");
  });

  it("says the preview is starting, not that another change runs, while a wake or restart holds the site", async () => {
    const d = deps({ run: vi.fn(async () => ({ ok: false, reason: "preview_starting" })) as unknown as SiteDirectEditDeps["run"] });
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "section", section_id: "hero", move: "down" } }, d);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: { code: "preview_starting", message: "Your preview is starting up. Try again in a minute." } });
  });

  it("generates the requested contextual logo, commits it, and charges only after success", async () => {
    const logo = {
      configured: vi.fn(async () => true),
      estimate: vi.fn(async () => 0.08),
      afford: vi.fn(async () => "ok" as const),
      generate: vi.fn(async () => ({ ok: true as const, url: "https://vendor.example/logo.svg", cost_usd: 0.08, model: "recraft" })),
      download: vi.fn(async () => new TextEncoder().encode('<svg viewBox="0 0 64 64"><path d="M0 0L8 8"/></svg>')),
    };
    const sandbox = {
      readFile: vi.fn(async (path: string) =>
        path.endsWith("logo.svg")
          ? "old-logo"
          : path.endsWith("favicon.svg")
            ? "old-favicon"
            : path.endsWith("src/site.ts")
              ? 'export const SITE = {\n  name: "Acme",\n};\n'
              : path.endsWith("src/App.tsx")
                ? "export function App() { return <SiteHeader logo={SITE.logo} />; }\n"
              : "",
      ),
    };
    const d = deps({
      logoAi: vi.fn(async () => true),
      logo,
      change: { sandboxFor: vi.fn(async () => sandbox) } as unknown as SiteDirectEditDeps["change"],
      run: vi.fn(async (input: { kind: string; plan: (sandbox: unknown) => Promise<unknown> }) => {
        expect(await input.plan(sandbox)).toMatchObject({ label: "Changed the site logo" });
        return { ok: true, commit_sha: "c".repeat(40), conductor_run_id: "run-1", files: [] } as DirectChangeResult;
      }) as unknown as SiteDirectEditDeps["run"],
    });
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "logo", description: "an angular fox made from two shapes" } }, d);
    expect(out.status).toBe(200);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(logo.generate).toHaveBeenCalledWith("image.vector", expect.objectContaining({ aspect_ratio: "1:1", prompt: expect.stringContaining("angular fox") }));
    expect(d.charge).toHaveBeenCalledWith({
      tenant_id: T,
      run_id: null,
      key: `site_logo_edit:${"c".repeat(40)}`,
      cost_usd: 0.08,
      task: "image.vector",
      model: "recraft",
    });

    const failed = deps({
      logoAi: vi.fn(async () => true),
      logo,
      change: { sandboxFor: vi.fn(async () => sandbox) } as unknown as SiteDirectEditDeps["change"],
      run: vi.fn(async () => ({ ok: false, reason: "changed" })) as unknown as SiteDirectEditDeps["run"],
    });
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "logo", description: "an angular fox" } }, failed)).status).toBe(409);
    expect(failed.charge).not.toHaveBeenCalled();
  });

  it("acquires the site edit lease before any paid logo work", async () => {
    const logo = {
      configured: vi.fn(async () => true),
      estimate: vi.fn(async () => 0.08),
      afford: vi.fn(async () => "ok" as const),
      generate: vi.fn(),
      download: vi.fn(),
    };
    const d = deps({
      logoAi: vi.fn(async () => true),
      logo,
      run: vi.fn(async () => ({ ok: false, reason: "lease_held" })) as unknown as SiteDirectEditDeps["run"],
    });
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "logo", description: "an angular fox" } }, d)).status).toBe(409);
    expect(logo.configured).not.toHaveBeenCalled();
    expect(logo.estimate).not.toHaveBeenCalled();
    expect(logo.afford).not.toHaveBeenCalled();
    expect(logo.generate).not.toHaveBeenCalled();
    expect(d.charge).not.toHaveBeenCalled();
  });
});

describe("Logo tab: a preview before Apply, the first per site free", () => {
  const SVG = '<svg viewBox="0 0 64 64"><path d="M0 0L8 8"/></svg>';
  const logoSpies = () => ({
    configured: vi.fn(async () => true),
    estimate: vi.fn(async () => 0.08),
    afford: vi.fn(async () => "ok" as const),
    generate: vi.fn(async () => ({ ok: true as const, url: "https://vendor.example/logo.svg", cost_usd: 0.08, model: "recraft" })),
    download: vi.fn(async () => new TextEncoder().encode(SVG)),
  });
  const sandboxWith = (css: string) => ({
    readFile: vi.fn(async (path: string) =>
      path.endsWith(THEME_CSS_PATH)
        ? css
        : path.endsWith("logo.svg")
          ? "old-logo"
          : path.endsWith("favicon.svg")
            ? "old-favicon"
            : path.endsWith("src/site.ts")
              ? 'export const SITE = {\n  name: "Acme",\n};\n'
              : path.endsWith("src/App.tsx")
                ? "export function App() { return <SiteHeader logo={SITE.logo} />; }\n"
                : "",
    ),
  });
  const css = () => renderThemeCss(THEME_PRESETS[0]!);
  const previewDeps = (over: Partial<SiteDirectEditDeps> = {}) => {
    const logo = logoSpies();
    const sandbox = sandboxWith(css());
    const previews = fakePreviews();
    const d = deps({
      logoAi: vi.fn(async () => true),
      logo,
      logoPreviews: previews,
      change: { sandboxFor: vi.fn(async () => sandbox) } as unknown as SiteDirectEditDeps["change"],
      ...over,
    });
    return { d, logo, previews, sandbox };
  };
  const preview = (d: SiteDirectEditDeps, extra: Record<string, unknown> = {}) =>
    post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "an angular fox", ...extra } }, d);
  type PreviewBody = { preview: { id: string; src: string; free: boolean }; charged?: string };

  it("the first preview of a site is free: no wallet check, no charge, and the SVG comes back to show", async () => {
    const { d, logo, previews } = previewDeps();
    const out = await preview(d);
    expect(out.status).toBe(200);
    const body = out.body as PreviewBody;
    expect(body.preview.free).toBe(true);
    expect(body.preview.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(body.preview.src.split(",")[1]!, "base64").toString()).toContain("<svg");
    expect(logo.afford).not.toHaveBeenCalled();
    expect(logo.generate).toHaveBeenCalledTimes(1);
    expect(d.charge).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    expect(previews.rows).toHaveLength(1);
    expect(previews.rows[0]!.svg).toContain("<svg");
  });

  it("tells the model what the business is: its kind, its own tagline, what it sells, who it serves and why they pick it", async () => {
    const { d, logo, sandbox } = previewDeps({
      businessBrief: vi.fn(async () => ({
        industry: "cake shop",
        audience: "families planning birthdays",
        positioning: "custom cakes baked the same morning",
        facts: ["Custom and ready-made cakes", "Local delivery included"],
      })),
    });
    const readFile = sandbox.readFile.getMockImplementation()!;
    sandbox.readFile.mockImplementation(async (path: string) =>
      path.endsWith("src/site.ts")
        ? 'export const SITE = {\n  name: "Sweet Layers",\n  logo: "/images/logo.svg",\n  tagline: "Layers of joy, baked fresh",\n};\n'
        : readFile(path),
    );
    expect((await preview(d)).status).toBe(200);
    const prompt = (logo.generate.mock.calls[0] as unknown as [string, { prompt: string }])[1].prompt;
    expect(prompt).toContain("About the business: It is a cake shop");
    expect(prompt).toContain('Its line: "Layers of joy, baked fresh"');
    expect(prompt).toContain("It offers: Custom and ready-made cakes; Local delivery included");
    expect(prompt).toContain("For: families planning birthdays");
    expect(prompt).toContain("Why customers choose it: custom cakes baked the same morning");
    expect(prompt).toContain("Founder direction: an angular fox.");
    expect(prompt.length).toBeLessThanOrEqual(1000);
  });

  it("a logo is designed for the name the site shows now (renamed in a chat change), not the name it was created with", async () => {
    const { d, logo, sandbox } = previewDeps();
    const readFile = sandbox.readFile.getMockImplementation()!;
    sandbox.readFile.mockImplementation(async (path: string) =>
      path.endsWith("src/site.ts") ? 'export const SITE = {\n  name: "Saffron Spoon Catering",\n  logo: "/images/logo.svg",\n};\n' : readFile(path),
    );
    const out = await preview(d, { layout: "wordmark" });
    expect(out.status).toBe(200);
    const prompt = (logo.generate.mock.calls[0] as unknown as [string, { prompt: string }])[1].prompt;
    expect(prompt).toContain("Saffron Spoon Catering");
    expect(prompt).not.toContain("Untitled site");
    expect(prompt).toContain("no text, letters or initials");
  });

  it("still makes a logo when the brief cannot be read", async () => {
    const { d, logo } = previewDeps({ businessBrief: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect((await preview(d)).status).toBe(200);
    expect((logo.generate.mock.calls[0] as unknown as [string, { prompt: string }])[1].prompt).not.toContain("About the business");
  });

  it("the second preview is charged when made, keyed on its own preview row", async () => {
    const { d, logo } = previewDeps();
    await preview(d);
    const out = await preview(d, { description: "a calm heron" });
    const body = out.body as PreviewBody;
    expect(out.status).toBe(200);
    expect(body.preview.free).toBe(false);
    expect(logo.afford).toHaveBeenCalledTimes(1);
    expect(d.charge).toHaveBeenCalledTimes(1);
    expect(d.charge).toHaveBeenCalledWith({
      tenant_id: T,
      run_id: null,
      key: `site_logo_preview:${body.preview.id}`,
      cost_usd: 0.08,
      task: "image.vector",
      model: "recraft",
    });
    expect(body.charged).toBe("charged");
  });

  it("a failed charge for a paid preview is retried once under the same key", async () => {
    const charge = vi.fn().mockResolvedValueOnce("error").mockResolvedValueOnce("charged");
    const { d } = previewDeps({ charge: charge as unknown as SiteDirectEditDeps["charge"] });
    await preview(d);
    const out = await preview(d, { description: "a calm heron" });
    expect(charge).toHaveBeenCalledTimes(2);
    expect(charge.mock.calls[0]![0]).toEqual(charge.mock.calls[1]![0]);
    expect((out.body as PreviewBody).charged).toBe("charged");
  });

  it("a paid preview whose charge cannot be recorded is withheld: no preview id, row dropped, nothing to apply", async () => {
    const charge = vi.fn(async () => "error" as const);
    const { d, previews } = previewDeps({ charge: charge as unknown as SiteDirectEditDeps["charge"] });
    await preview(d);
    const out = await preview(d, { description: "a calm heron" });
    expect(out.status).toBe(503);
    expect((out.body as Record<string, unknown>).preview).toBeUndefined();
    expect(charge).toHaveBeenCalledTimes(2);
    expect(previews.rows.filter((r) => !r.free)).toHaveLength(0);
  });

  it("a charge that landed but answered 'error' is read back from the ledger and the preview is delivered", async () => {
    const charge = vi.fn(async () => "error" as const);
    const chargeRecorded = vi.fn(async () => true);
    const { d } = previewDeps({ charge: charge as unknown as SiteDirectEditDeps["charge"], chargeRecorded });
    await preview(d);
    const out = await preview(d, { description: "a calm heron" });
    expect(out.status).toBe(200);
    const body = out.body as PreviewBody;
    expect(chargeRecorded).toHaveBeenCalledWith(T, `site_logo_preview:${body.preview.id}`);
    expect(body.charged).toBe("charged");
  });

  it("an unreadable ledger after a failed charge withholds the preview", async () => {
    const { d, previews } = previewDeps({
      charge: vi.fn(async () => "error" as const) as unknown as SiteDirectEditDeps["charge"],
      chargeRecorded: vi.fn(async () => { throw new Error("db down"); }),
    });
    await preview(d);
    expect((await preview(d, { description: "a calm heron" })).status).toBe(503);
    expect(previews.rows.filter((r) => !r.free)).toHaveLength(0);
  });

  it("a failed first preview releases its row, so the next try is still free and nothing is charged", async () => {
    const { d, logo, previews } = previewDeps();
    logo.generate.mockResolvedValueOnce({ ok: false, reason: "vendor_error", error: "boom" } as never);
    const failed = await preview(d);
    expect(failed.status).toBe(422);
    expect(previews.rows).toHaveLength(0);
    const out = await preview(d);
    expect((out.body as PreviewBody).preview.free).toBe(true);
    expect(d.charge).not.toHaveBeenCalled();
  });

  it("a paid preview the tenant cannot afford runs nothing, charges nothing, and does not use up a row", async () => {
    const { d, logo, previews } = previewDeps();
    await preview(d);
    logo.afford.mockResolvedValueOnce("short" as never);
    const out = await preview(d);
    expect(out.status).toBe(402);
    expect(logo.generate).toHaveBeenCalledTimes(1);
    expect(previews.rows).toHaveLength(1);
    expect(d.charge).not.toHaveBeenCalled();
  });

  it("tells the panel whether the next preview is the free one, and says not-free when that read fails", async () => {
    const { d } = previewDeps();
    d.change.sandboxFor = vi.fn(async () => ({ readFile: vi.fn(async () => "") })) as never;
    const read = async () => {
      const { out, r } = res();
      await handleGetSiteDesignEdit({ query: { app_id: `site:${SITE}` } } as unknown as Request, r, d);
      return (out.body as { logo_preview_free: boolean }).logo_preview_free;
    };
    expect(await read()).toBe(true);
    (d.logoPreviews as ReturnType<typeof fakePreviews>).rows.push({ id: "00000000-0000-4000-8000-0000000000f1", tenant_id: T, site_id: SITE, free: true, svg: PREVIEW_SVG });
    expect(await read()).toBe(false);
    d.logoPreviews.freeUsed = vi.fn(async () => { throw new Error("db down"); });
    expect(await read()).toBe(false);
  });

  it("uses the Theme tab's draft colours for the preview when it sends them", async () => {
    const { d, logo } = previewDeps();
    await preview(d, { colors: { primary: "#DC2626", accent: "#FDE68A" } });
    expect(logo.generate).toHaveBeenCalledWith("image.vector", expect.objectContaining({ prompt: expect.stringContaining("Palette: #dc2626 and #fde68a"), colors: [{ r: 220, g: 38, b: 38 }, { r: 253, g: 230, b: 138 }] }));
  });

  it("refuses before claiming or generating when the header has no logo slot", async () => {
    const { d, logo, previews } = previewDeps({
      change: { sandboxFor: vi.fn(async () => sandboxWith("")) } as unknown as SiteDirectEditDeps["change"],
    });
    (d.change.sandboxFor as ReturnType<typeof vi.fn>).mockResolvedValue({ readFile: vi.fn(async () => "") });
    const out = await preview(d);
    expect(out.status).toBe(422);
    expect(previews.claim).not.toHaveBeenCalled();
    expect(logo.generate).not.toHaveBeenCalled();
  });

  it("Apply saves the theme and the previewed logo in ONE commit and charges nothing more", async () => {
    const { d, sandbox } = previewDeps();
    await preview(d);
    const paid = (await preview(d, { description: "a calm heron" })).body as PreviewBody;
    (d.charge as ReturnType<typeof vi.fn>).mockClear();
    let planned: { files: Array<{ path: string; after: string | null }>; label: string } | null = null;
    d.run = vi.fn(async (input: { kind: string; plan: (sandbox: unknown) => Promise<unknown> }) => {
      planned = (await input.plan(sandbox)) as typeof planned;
      return { ok: true, commit_sha: "d".repeat(40), conductor_run_id: "run-2", files: [] } as DirectChangeResult;
    }) as unknown as SiteDirectEditDeps["run"];
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "theme", colors: { primary: "#dc2626" }, logo: { preview_id: paid.preview.id } } }, d);
    expect(out.status).toBe(200);
    expect(d.run).toHaveBeenCalledTimes(1);
    const paths = planned!.files.map((f) => f.path);
    expect(paths[0]).toBe(THEME_CSS_PATH);
    expect(paths).toEqual(expect.arrayContaining(["public/favicon.svg", "src/site.ts"]));
    expect(planned!.files.find((f) => f.path === "public/favicon.svg")!.after).toContain('<path d="M0 0L8 8"/>');
    expect(planned!.label).toBe("Changed the site's colours and logo");
    expect(d.charge).not.toHaveBeenCalled();
    expect((out.body as { logo: { src: string } }).logo.src).toMatch(/logo\.svg\?v=/);
  });

  it("applies a logo alone, with no theme change, and charges nothing", async () => {
    const { d, sandbox } = previewDeps();
    const free = (await preview(d)).body as PreviewBody;
    d.run = vi.fn(async (input: { plan: (sandbox: unknown) => Promise<unknown> }) => {
      expect(await input.plan(sandbox)).toMatchObject({ label: "Changed the site logo" });
      return { ok: true, commit_sha: "e".repeat(40), conductor_run_id: "run-3", files: [] } as DirectChangeResult;
    }) as unknown as SiteDirectEditDeps["run"];
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "theme", logo: { preview_id: free.preview.id } } }, d);
    expect(out.status).toBe(200);
    expect(d.charge).not.toHaveBeenCalled();
  });

  it("Name only drops the logo image in a commit of its own: nothing is designed, generated or charged", async () => {
    const { d, logo } = previewDeps();
    const sandbox = {
      readFile: vi.fn(async (path: string) =>
        path.endsWith(THEME_CSS_PATH)
          ? css()
          : path.endsWith("favicon.svg")
            ? "old-favicon"
            : path.endsWith("src/site.ts")
              ? 'export const SITE = {\n  name: "Acme Bakery",\n  logo: "/images/logo.svg?v=abc123abc123",\n};\n'
              : path.endsWith("src/App.tsx")
                ? "export function App() { return <SiteHeader logo={SITE.logo} />; }\n"
                : "",
      ),
    };
    let planned: { files: Array<{ path: string; after: string | null }>; label: string } | null = null;
    d.run = vi.fn(async (input: { kind: string; plan: (sandbox: unknown) => Promise<unknown> }) => {
      expect(input.kind).toBe("logo_apply");
      planned = (await input.plan(sandbox)) as typeof planned;
      return { ok: true, commit_sha: "f".repeat(40), conductor_run_id: "run-4", files: [] } as DirectChangeResult;
    }) as unknown as SiteDirectEditDeps["run"];
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "theme", logo: { name_only: true } } }, d);
    expect(out.status).toBe(200);
    expect(planned!.label).toBe("Showed the site name without a logo");
    const site = planned!.files.find((f) => f.path === "src/site.ts")!.after!;
    expect(site).not.toContain("logo:");
    expect(site).toContain('name: "Acme Bakery"');
    expect(planned!.files.find((f) => f.path === "public/favicon.svg")!.after).toContain(">AB</text>");
    expect(logo.generate).not.toHaveBeenCalled();
    expect(d.charge).not.toHaveBeenCalled();
  });

  it("never applies another tenant's or another site's preview, or a preview that is not finished", async () => {
    const { d, previews } = previewDeps();
    previews.rows.push(
      { id: "aaaaaaaa-1111-4111-8111-111111111111", tenant_id: "99999999-9999-4999-8999-999999999999", site_id: SITE, free: false, svg: PREVIEW_SVG },
      { id: "bbbbbbbb-1111-4111-8111-111111111111", tenant_id: T, site_id: "cccccccc-0000-4000-8000-000000000003", free: false, svg: PREVIEW_SVG },
      { id: "dddddddd-1111-4111-8111-111111111111", tenant_id: T, site_id: SITE, free: false, svg: null },
    );
    for (const id of ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-1111-4111-8111-111111111111", "dddddddd-1111-4111-8111-111111111111"]) {
      const out = await post({ app_id: `site:${SITE}`, op: { kind: "theme", logo: { preview_id: id } } }, d);
      expect(out.status).toBe(422);
      expect((out.body as { error: { code: string } }).error.code).toBe("logo_preview_missing");
    }
    expect(previews.get).toHaveBeenCalledWith(T, SITE, expect.any(String));
    expect(d.run).not.toHaveBeenCalled();
    expect(d.charge).not.toHaveBeenCalled();
  });

  it("a theme-only Apply runs no AI and charges nothing", async () => {
    const { d, logo, sandbox } = previewDeps();
    d.run = vi.fn(async (input: { plan: (sandbox: unknown) => Promise<unknown> }) => {
      await input.plan(sandbox);
      return { ok: true, commit_sha: "e".repeat(40), conductor_run_id: "run-3", files: [] } as DirectChangeResult;
    }) as unknown as SiteDirectEditDeps["run"];
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "theme", radius: "0" } }, d);
    expect(out.status).toBe(200);
    expect(logo.generate).not.toHaveBeenCalled();
    expect(d.charge).not.toHaveBeenCalled();
    expect((out.body as Record<string, unknown>).logo).toBeUndefined();
  });

  it("refuses a bad preview id, a short description, AI logos off, or an empty Apply, before running anything", async () => {
    const d = deps({ logoAi: vi.fn(async () => false) });
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "theme", logo: { preview_id: "nope" } } }, d)).status).toBe(400);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "theme", logo: { description: "an angular fox" } } }, d)).status).toBe(400);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "x" } }, d)).status).toBe(400);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "an angular fox" } }, d)).status).toBe(403);
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "theme" } }, d)).status).toBe(400);
    expect(d.run).not.toHaveBeenCalled();
    expect(d.charge).not.toHaveBeenCalled();
  });
});

describe("cleanSectionOp", () => {
  it("reads one change", () => {
    expect(cleanSectionOp({ section_id: "hero", variant: "split" })).toEqual({ kind: "variant", section_id: "hero", variant: "split" });
    expect(cleanSectionOp({ section_id: "faq", move: "up" })).toEqual({ kind: "move", section_id: "faq", direction: "up" });
    expect(cleanSectionOp({ section_id: "Bad id", move: "up" })).toBeNull();
  });
});

describe("which lease each direct change holds", () => {
  const ops: Array<[string, "short" | "long", Record<string, unknown>]> = [
    ["theme", "short", { kind: "theme", colors: { primary: "#112233" } }],
    ["section", "short", { kind: "section", section_id: "faq", move: "up" }],
    ["image_url", "short", { kind: "image", src: "/images/a.webp", mode: "url", text: "https://example.com/a.jpg" }],
    ["image_generate", "long", { kind: "image", src: "/images/a.webp", mode: "generate", text: "a quiet workshop" }],
    ["image_edit", "long", { kind: "image", src: "/images/a.webp", mode: "edit", text: "make the sky blue" }],
    ["logo", "long", { kind: "logo", description: "a calm blue fox mark" }],
    ["theme_logo", "short", { kind: "theme", colors: { primary: "#112233" }, logo: { preview_id: "00000000-0000-4000-8000-000000000042" } }],
  ];

  it.each(ops)("%s claims the %s lease and never the other", async (kind, want, op) => {
    const short = vi.fn(async () => ({ release: async () => undefined }));
    const long = vi.fn(async () => ({ release: async () => undefined }));
    const run = vi.fn(async (input: { kind: string }, change: SiteDirectEditDeps["change"]): Promise<DirectChangeResult> => {
      await change.claimLease(T, SITE);
      return { ok: false, reason: "lease_held" } as DirectChangeResult;
    });
    const d = deps({
      imageAi: vi.fn(async () => true),
      logoAi: vi.fn(async () => true),
      change: { claimLease: short } as unknown as SiteDirectEditDeps["change"],
      slowLease: long,
      run: run as unknown as SiteDirectEditDeps["run"],
    });
    (d.logoPreviews as ReturnType<typeof fakePreviews>).rows.push({ id: "00000000-0000-4000-8000-000000000042", tenant_id: T, site_id: SITE, free: true, svg: PREVIEW_SVG });
    await post({ app_id: `site:${SITE}`, op }, d);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].kind).toBe(kind);
    expect(short).toHaveBeenCalledTimes(want === "short" ? 1 : 0);
    expect(long).toHaveBeenCalledTimes(want === "long" ? 1 : 0);
  });
});

describe("Logo tab: the designer picks the mark before the vendor draws it", () => {
  const SVG = '<svg viewBox="0 0 64 64"><path d="M0 0L8 8"/></svg>';
  const SPEC = {
    type: "pictorial" as const,
    subject: "a heron whose neck forms the letter S",
    concept: "Patience and precision",
    style: "negative-space" as const,
    rationale: "Customers already know the bird.",
    avoid: ["a swoosh"],
    source: "founder" as const,
  };
  const sandbox = () => ({
    readFile: vi.fn(async (path: string) =>
      path.endsWith(THEME_CSS_PATH)
        ? renderThemeCss(THEME_PRESETS[0]!)
        : path.endsWith("logo.svg")
          ? "old-logo"
          : path.endsWith("favicon.svg")
            ? "old-favicon"
            : path.endsWith("src/site.ts")
              ? 'export const SITE = {\n  name: "Acme",\n};\n'
              : path.endsWith("src/App.tsx")
                ? "export function App() { return <SiteHeader logo={SITE.logo} />; }\n"
                : "",
    ),
  });
  const designerDeps = (over: Partial<SiteDirectEditDeps> = {}, design: NonNullable<SiteDirectEditDeps["logo"]["design"]> = vi.fn(async () => ({ spec: SPEC, ms: 20, reason: null }))) => {
    const logo = {
      configured: vi.fn(async () => true),
      estimate: vi.fn(async () => 0.08),
      afford: vi.fn(async () => "ok" as const),
      generate: vi.fn(async () => ({ ok: true as const, url: "https://vendor.example/logo.svg", cost_usd: 0.08, model: "recraft" })),
      download: vi.fn(async () => new TextEncoder().encode(SVG)),
      design,
    };
    const d = deps({
      logoAi: vi.fn(async () => true),
      logo,
      logoPreviews: fakePreviews(),
      change: { sandboxFor: vi.fn(async () => sandbox()) } as unknown as SiteDirectEditDeps["change"],
      designContext: vi.fn(async () => ({ business: "Photography: calm family portraits", industry: "Photography", mood: "calm, warm", audience: "young families", positioning: "calm family portraits" })),
      ...over,
    });
    return { d, logo, design };
  };
  type Body = { preview: { id: string; free: boolean; design?: { type: string; rationale: string; concept: string } }; logo?: { src: string; design?: { type: string } } };

  it("a preview asks the designer with the founder's words, the Theme colours and the site's brief, then draws the designed mark and says why", async () => {
    const { d, logo, design } = designerDeps();
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "something with a bird", colors: { primary: "#112233", accent: "#445566" } } }, d);
    expect(out.status).toBe(200);
    expect(design).toHaveBeenCalledWith({
      site_name: "Acme",
      business: "Photography: calm family portraits",
      direction: "something with a bird",
      industry: "Photography",
      mood: "calm, warm",
      audience: "young families",
      positioning: "calm family portraits",
      primary: "#112233",
      accent: "#445566",
    });
    const req = (logo.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { prompt: string };
    expect(req.prompt).toContain("A pictorial mark: a heron whose neck forms the letter S.");
    expect(req.prompt).not.toContain("something with a bird");
    expect((out.body as Body).preview.design).toEqual({ type: "pictorial", rationale: "Customers already know the bird.", concept: "Patience and precision" });
  });

  it("a missing brief or a failing designer never blocks the preview: the founder's words are drawn as before, with no rationale", async () => {
    const noBrief = designerDeps({ designContext: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect((await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "an angular fox" } }, noBrief.d)).status).toBe(200);
    expect(noBrief.design).toHaveBeenCalledWith(expect.objectContaining({ site_name: "Acme", business: "Acme", industry: null, direction: "an angular fox" }));

    const broken = designerDeps({}, vi.fn(async () => Promise.reject(new Error("model down"))));
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "an angular fox" } }, broken.d);
    expect(out.status).toBe(200);
    expect((out.body as Body).preview.design).toBeUndefined();
    const req = (broken.logo.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { prompt: string };
    expect(req.prompt).toContain("Founder direction: an angular fox");
    expect(broken.logo.generate).toHaveBeenCalledTimes(1);
  });

  it("logs why the designer fell back, without the model's text", async () => {
    loggedEvents.length = 0;
    const { d } = designerDeps({}, vi.fn(async () => ({ spec: { ...SPEC, source: "heuristic" as const }, ms: 6001, reason: "timeout: aborted after 6000ms with secret model text" })));
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "an angular fox" } }, d);
    expect(out.status).toBe(200);
    await vi.waitFor(() => expect(loggedEvents.some((e) => e.code === "site_logo.design_fallback")).toBe(true));
    const ev = loggedEvents.find((e) => e.code === "site_logo.design_fallback")!;
    expect(ev.meta).toEqual({ design_reason: "timeout", design_ms: 6001, design_source: "heuristic" });
    const { LOG_META_KEYS } = await vi.importActual<typeof import("@/services/logging/logEvent")>("@/services/logging/logEvent");
    for (const k of Object.keys(ev.meta ?? {})) expect(LOG_META_KEYS as readonly string[]).toContain(k);
  });

  it("without a designer wired, a preview behaves exactly as before", async () => {
    const { d, logo } = designerDeps({});
    delete (logo as { design?: unknown }).design;
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "logo_preview", description: "an angular fox" } }, d);
    expect(out.status).toBe(200);
    expect((out.body as Body).preview.design).toBeUndefined();
    expect(d.designContext).not.toHaveBeenCalled();
  });

  it("a direct logo change designs inside the lease and answers with the chosen type", async () => {
    const { d, design } = designerDeps({
      run: vi.fn(async (input: { plan: (sandbox: unknown) => Promise<{ reason: string } | { files: unknown[]; label: string }> }): Promise<DirectChangeResult> => {
        const plan = await input.plan(sandbox());
        if ("reason" in plan) return { ok: false, reason: plan.reason } as DirectChangeResult;
        return { ok: true, commit_sha: "d".repeat(40), conductor_run_id: "run-2", files: [] };
      }) as unknown as SiteDirectEditDeps["run"],
    });
    const out = await post({ app_id: `site:${SITE}`, op: { kind: "logo", description: "something with a bird" } }, d);
    expect(out.status).toBe(200);
    expect(design).toHaveBeenCalledTimes(1);
    expect((out.body as Body).logo).toMatchObject({ design: { type: "pictorial" } });
  });
});

it("live logo requests design immediately without paid model enrichment", async () => {
  const design = await realLogoGenerationDeps().design!({ site_name: "Acme Bakery", business: "Bakery", direction: "No mascot, a badge instead" });
  expect(design).toMatchObject({ reason: null, spec: { type: "emblem", source: "founder" } });
});
