import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { SiteRow } from "@/services/sites/contract";
import type { SiteDesignRow, SiteDesignStore } from "@/services/sites/site-design-store";

const mocks = vi.hoisted(() => ({
  auth: { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", access_token: "tok" } as
    | { tenant_id: string; user_id: string; access_token: string }
    | null,
  writer: true,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: unknown, res: Response) => {
    if (!mocks.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return mocks.auth;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, _roles: unknown, res: Response) => {
    if (mocks.writer) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("the route must read through its injected deps");
  },
}));

import { makeGetSiteDesign, makePostSiteDesignDirection, type SiteDesignRouteDeps, type SiteDesignView } from "../site-design";
import { applyDirectionToFiles, brandPreset, designDirections, directionInThemeCss, fallbackDesignBrief, withCompleteLook } from "@/services/sites/design-directions";
import { THEME_CSS_PATH, getThemePreset, renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import type { DesignBrief } from "@/services/sites/design-brief";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "33333333-3333-4333-8333-333333333333";

const BRIEF: DesignBrief = withCompleteLook(
  {
    industry: "photography",
    mood: "quiet bold modern",
    mode: "light",
    colors: {
      background: "#ffffff",
      foreground: "#111111",
      muted: "#f2f2f2",
      "muted-foreground": "#555555",
      primary: "#111111",
      "primary-foreground": "#ffffff",
      border: "#e5e5e5",
    },
    fonts: { heading: "Archivo", body: "Figtree" },
    audience: "Couples planning a wedding",
    facts: ["Weddings and portraits"],
    plan: {
      tone: "calm",
      primary_action: { label: "Send an enquiry", steps: "Fill the form" },
      pages: [{ path: "/", title: "Home", sections: [{ name: "Hero", headline: "Photographs that feel like the day did" }, { name: "Gallery", headline: "Recent weddings" }] }],
    },
    look: { base: "studio", layout: "minimal", alternates: ["luxe", "editorial"] },
    source: "model",
  },
  "",
);

function site(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: SITE_ID,
    tenant_id: TENANT,
    root_conductor_run_id: RUN,
    started_by_user_id: null,
    owner_email: null,
    label: "ana",
    hostname: "ana.zaviagent.com",
    github_full_name: "Praxis-build/ana-1",
    supabase_project_ref: null,
    supabase_url: null,
    status: "building",
    live_url: null,
    desired_sha: null,
    live_sha: null,
    live_deploy_id: null,
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: null,
    created_at: "2026-10-07T00:00:00Z",
    updated_at: "2026-10-07T00:00:00Z",
    ...over,
  } as SiteRow;
}

function designRow(over: Partial<SiteDesignRow> = {}): SiteDesignRow {
  const brief = over.brief ?? BRIEF;
  return {
    site_id: SITE_ID,
    tenant_id: TENANT,
    conductor_run_id: RUN,
    brief,
    directions: designDirections(brief),
    theme_mode: "theme_css",
    chosen_direction: "brand",
    chosen_at: null,
    applied_direction: "brand",
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
    ...over,
  };
}

type Graph = Array<{ status: string; payload: Record<string, unknown> }>;

function parkedGraph(siteId = SITE_ID): Graph {
  return [
    { status: "done", payload: { stage: "provision", site_id: siteId } },
    { status: "pending", payload: { stage: "build", fast_single_pass: true, site_id: siteId, await_look: true } },
  ];
}

function harness(
  over: { buildStatus?: string; runStatus?: string; siteRow?: SiteRow; row?: SiteDesignRow | null; graph?: Graph; waits?: boolean; chooseError?: Error } = {},
) {
  let current = over.row === undefined ? designRow() : over.row;
  const store = {
    get: vi.fn(async () => current),
    createIfAbsent: vi.fn(),
    choose: vi.fn(async (_t: string, _s: string, direction: string) => {
      if (over.chooseError) throw over.chooseError;
      current = current && !current.sealed_at ? { ...current, chosen_direction: direction, chosen_at: "2026-10-07T01:00:00Z" } : null;
      return current;
    }),
    markApplied: vi.fn(),
    recordFidelity: vi.fn(),
  } as unknown as SiteDesignStore & { choose: ReturnType<typeof vi.fn> };
  const applyLive = vi.fn();
  const waitsForLook = vi.fn(async () => over.waits ?? true);
  const kick = vi.fn(async () => true);
  const pickParked = vi.fn(async (input: { tenant_id: string; conductor_run_id: string; direction: string; user_id: string }) => {
    if (!current || current.sealed_at) return { state: "sealed" };
    current = { ...current, chosen_direction: input.direction, chosen_at: "2026-10-07T01:00:00Z" };
    return { state: "picked" };
  });
  const deps: SiteDesignRouteDeps = {
    loadRun: vi.fn(async (_tok: string, _tenant: string, id: string) =>
      id === RUN
        ? {
            id: RUN,
            status: over.runStatus ?? "active",
            goal_graph: over.graph ?? [
              { status: "done", payload: { stage: "provision", site_id: SITE_ID } },
              { status: over.buildStatus ?? "dispatched", payload: { stage: "build", fast_single_pass: true, site_id: SITE_ID } },
            ],
          }
        : null,
    ),
    loadSite: vi.fn(async (_tenant: string, id: string) => (id === SITE_ID ? (over.siteRow ?? site()) : null)),
    store,
    applyLive,
    waitsForLook,
    kick,
    pickParked,
  };
  return { deps, store, applyLive, waitsForLook, kick, pickParked, current: () => current, get: makeGetSiteDesign(() => deps), post: makePostSiteDesignDirection(() => deps) };
}

async function call(handler: (req: Request, res: Response) => Promise<void>, req: { body?: unknown; query?: unknown }) {
  let status = 200;
  let json: unknown = null;
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      json = b;
      return res;
    },
  } as unknown as Response;
  await handler(req as Request, res);
  return { status, json: json as { design?: SiteDesignView; started?: boolean; error?: { code: string; reason?: string } } };
}

beforeEach(() => {
  mocks.auth = { tenant_id: TENANT, user_id: "u1", access_token: "tok" };
  mocks.writer = true;
});

describe("GET /api/workspace/autopilot/site-design", () => {
  it("shows the looks (recommended first, with swatches and fonts), the plan and the pick while the build runs", async () => {
    const h = harness();
    const r = await call(h.get, { query: { run_id: RUN } });
    expect(r.status).toBe(200);
    const d = r.json.design!;
    expect(d.looks.map((l) => l.id)).toEqual(["brand", "editorial", "luxe"]);
    expect(d.looks[0].recommended).toBe(true);
    expect(d.looks[0].fonts).toEqual({ display: "Archivo", body: "Figtree" });
    expect(d.looks[0].swatches.primary).toBe("#111111");
    expect(d.chosen).toBe("brand");
    expect(d.locked).toBeNull();
    expect(d.plan.sections).toEqual([
      { id: "hero", name: "Hero", headline: "Photographs that feel like the day did" },
      { id: "gallery", name: "Gallery", headline: "Recent weddings" },
    ]);
    expect(d.plan.main_action).toBe("Send an enquiry");
    expect(d.checklist).toBeNull();
  });

  it("answers 404 for a run with no brief, another run's brief, or a bad id", async () => {
    expect((await call(harness({ row: null }).get, { query: { run_id: RUN } })).status).toBe(404);
    expect((await call(harness({ row: designRow({ conductor_run_id: "44444444-4444-4444-8444-444444444444" }) }).get, { query: { run_id: RUN } })).status).toBe(404);
    expect((await call(harness().get, { query: { run_id: "44444444-4444-4444-8444-444444444444" } })).status).toBe(404);
    expect((await call(harness().get, { query: { run_id: "nope" } })).status).toBe(400);
  });

  it("says why the looks are locked once the build is done or the site cannot switch", async () => {
    expect((await call(harness({ buildStatus: "done" }).get, { query: { run_id: RUN } })).json.design!.locked).toBe("built");
    expect((await call(harness({ row: designRow({ theme_mode: "index_css" }) }).get, { query: { run_id: RUN } })).json.design!.locked).toBe("unsupported");
  });
});

describe("POST /api/workspace/autopilot/site-design/direction", () => {
  it("saves the pick and restyles the live preview without a model call or a charge", async () => {
    const h = harness();
    const r = await call(h.post, { body: { run_id: RUN, direction: "luxe" } });
    expect(r.status).toBe(200);
    expect(r.json.design!.chosen).toBe("luxe");
    expect(h.store.choose).toHaveBeenCalledWith(TENANT, SITE_ID, "luxe", "u1");
    expect(h.applyLive).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, direction_id: "luxe" }));
  });

  it("once the build's push sealed the look, a pick is refused, even one racing the seal", async () => {
    const sealed = harness({ row: designRow({ sealed_at: "2026-10-07T00:00:00Z" }) });
    expect((await call(sealed.get, { query: { run_id: RUN } })).json.design!.locked).toBe("built");
    expect((await call(sealed.post, { body: { run_id: RUN, direction: "luxe" } })).json.error).toMatchObject({ code: "look_locked", reason: "built" });
    expect(sealed.store.choose).not.toHaveBeenCalled();

    const racing = harness();
    racing.store.choose.mockResolvedValueOnce(null);
    const r = await call(racing.post, { body: { run_id: RUN, direction: "luxe" } });
    expect(r.status).toBe(409);
    expect(racing.applyLive).not.toHaveBeenCalled();
  });

  it("re-picking the look the founder already picked is a no-op", async () => {
    const h = harness({ row: designRow({ chosen_direction: "luxe", chosen_at: "2026-10-07T00:30:00Z" }) });
    const r = await call(h.post, { body: { run_id: RUN, direction: "luxe" } });
    expect(r.status).toBe(200);
    expect(r.json.started).toBe(true);
    expect(h.store.choose).not.toHaveBeenCalled();
    expect(h.applyLive).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it("refuses a look the build did not offer, a locked build, a site that already went live, and a member", async () => {
    expect((await call(harness().post, { body: { run_id: RUN, direction: "midnight" } })).json.error!.code).toBe("unknown_look");
    const built = await call(harness({ buildStatus: "done" }).post, { body: { run_id: RUN, direction: "luxe" } });
    expect(built.status).toBe(409);
    expect(built.json.error).toMatchObject({ code: "look_locked", reason: "built" });
    const live = await call(harness({ siteRow: site({ live_sha: "a".repeat(40) }) }).post, { body: { run_id: RUN, direction: "luxe" } });
    expect(live.json.error).toMatchObject({ code: "look_locked", reason: "live" });
    mocks.writer = false;
    const h = harness();
    expect((await call(h.post, { body: { run_id: RUN, direction: "luxe" } })).status).toBe(403);
    expect(h.store.choose).not.toHaveBeenCalled();
  });
});

describe("GET site-design: awaiting_pick", () => {
  const get = async (h: ReturnType<typeof harness>) => call(h.get, { query: { run_id: RUN } });
  const provision = { status: "done", payload: { stage: "provision", site_id: SITE_ID } };
  const buildNode = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    payload: { stage: "build", fast_single_pass: true, site_id: SITE_ID, ...extra },
  });
  const OTHER = "44444444-4444-4444-8444-444444444444";

  it("is true while the build is parked on this site's look and nothing is picked", async () => {
    const h = harness({ graph: parkedGraph() });
    const d = (await get(h)).json.design!;
    expect(d.awaiting_pick).toBe(true);
    expect(d.locked).toBeNull();
  });

  it("a parked build with a wait stamp says when it starts on its own: 60 seconds after the stamp", async () => {
    const graph = parkedGraph();
    graph[1]!.payload.await_look_parked_at = "2026-10-30T10:00:00.000Z";
    const d = (await get(harness({ graph }))).json.design!;
    expect(d.awaiting_pick).toBe(true);
    expect(d.auto_start_at).toBe("2026-10-30T10:01:00.000Z");
  });

  it("no start time before the conductor stamps the wait, and none once a pick is saved", async () => {
    expect((await get(harness({ graph: parkedGraph() }))).json.design!.auto_start_at).toBeNull();
    const graph = parkedGraph();
    graph[1]!.payload.await_look_parked_at = "2026-10-30T10:00:00.000Z";
    const picked = harness({ graph, row: designRow({ chosen_at: "2026-10-30T10:00:20.000Z", chosen_direction: "luxe" }) });
    const d = (await get(picked)).json.design!;
    expect(d.awaiting_pick).toBe(false);
    expect(d.auto_start_at).toBeNull();
  });

  it("stays true for a parked build when the tenant's flag was turned off mid-session (the conductor still waits)", async () => {
    const h = harness({ graph: parkedGraph(), waits: false });
    expect((await get(h)).json.design!.awaiting_pick).toBe(true);
    expect(h.waitsForLook).not.toHaveBeenCalled();
  });

  it("is true before the build parks when the flag is on: no build node yet, or the build node still pending", async () => {
    const none = harness({ graph: [provision] });
    expect((await get(none)).json.design!.awaiting_pick).toBe(true);
    expect(none.waitsForLook).toHaveBeenCalledWith(TENANT);
    expect((await get(harness({ graph: [provision, buildNode("pending")] }))).json.design!.awaiting_pick).toBe(true);
  });

  it("is false before the build parks when the flag is off", async () => {
    expect((await get(harness({ graph: [provision], waits: false }))).json.design!.awaiting_pick).toBe(false);
    expect((await get(harness({ graph: [provision, buildNode("pending")], waits: false }))).json.design!.awaiting_pick).toBe(false);
  });

  it("is false with the flag on once a build node runs or ran without the marker (legacy run, flag off at start, a fix pass)", async () => {
    for (const status of ["dispatched", "done", "failed"]) {
      const h = harness({ graph: [provision, buildNode(status)] });
      expect((await get(h)).json.design!.awaiting_pick).toBe(false);
      expect(h.waitsForLook).not.toHaveBeenCalled();
    }
    const fixPass = harness({ graph: [provision, { status: "dispatched", payload: { stage: "build", site_id: SITE_ID } }, buildNode("pending")] });
    expect((await get(fixPass)).json.design!.awaiting_pick).toBe(false);
  });

  it("is false when the parked marker names another site, flag on or off", async () => {
    for (const waits of [true, false]) {
      const h = harness({ graph: [provision, buildNode("pending", { await_look: true, site_id: OTHER })], waits });
      expect((await get(h)).json.design!.awaiting_pick).toBe(false);
    }
  });

  it("is false once the founder picked (chosen_at set), parked or not, flag on or off", async () => {
    for (const graph of [parkedGraph(), [provision]]) {
      for (const waits of [true, false]) {
        const h = harness({ graph, waits, row: designRow({ chosen_at: "2026-10-07T00:30:00Z" }) });
        expect((await get(h)).json.design!.awaiting_pick).toBe(false);
      }
    }
  });

  it("is false for a site whose look cannot switch live, and for a sealed look, even parked", async () => {
    for (const graph of [parkedGraph(), [provision]]) {
      for (const theme_mode of ["index_css", "none"] as const) {
        const d = (await get(harness({ graph, row: designRow({ theme_mode }) }))).json.design!;
        expect(d.awaiting_pick).toBe(false);
        expect(d.locked).toBe("unsupported");
      }
      expect((await get(harness({ graph, row: designRow({ sealed_at: "2026-10-07T00:30:00Z" }) }))).json.design!.awaiting_pick).toBe(false);
    }
  });

  it("is false when the design brief left fewer than two websites to pick from, even parked", async () => {
    for (const graph of [parkedGraph(), [provision]]) {
      for (const directions of [[], designDirections(BRIEF).slice(0, 1)]) {
        const d = (await get(harness({ graph, row: designRow({ directions }) }))).json.design!;
        expect(d.awaiting_pick).toBe(false);
      }
    }
  });

  it("carries no countdown while parked, even for a run whose old wait stamp is long past", async () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const graph = [provision, buildNode("pending", { await_look: true, await_look_since: since })];
    const d = (await get(harness({ graph }))).json.design! as unknown as Record<string, unknown>;
    expect(d.awaiting_pick).toBe(true);
    expect(d).not.toHaveProperty("look_deadline_at");
    expect(d).not.toHaveProperty("look_deadline_in_ms");
    expect(d).not.toHaveProperty("look_wait_s");
  });

  it("is false before the build parks when the run or site already ended", async () => {
    expect((await get(harness({ graph: [provision], runStatus: "failed" }))).json.design!.awaiting_pick).toBe(false);
    expect((await get(harness({ graph: [provision], siteRow: site({ status: "failed" as SiteRow["status"] }) }))).json.design!.awaiting_pick).toBe(false);
    expect((await get(harness({ graph: [provision], siteRow: site({ live_sha: "a".repeat(40) }) }))).json.design!.awaiting_pick).toBe(false);
  });

  it("answers 404 with no design row and never reads the flag", async () => {
    const h = harness({ graph: parkedGraph(), row: null });
    expect((await get(h)).status).toBe(404);
    expect(h.waitsForLook).not.toHaveBeenCalled();
  });
});

describe("GET site-design: picked", () => {
  it("is false until the founder's pick is saved, then true, even for the default look", async () => {
    for (const direction of ["brand", "luxe"]) {
      const h = harness({ graph: parkedGraph() });
      const before = (await call(h.get, { query: { run_id: RUN } })).json.design!;
      expect(before.picked).toBe(false);
      expect(before.chosen).toBe("brand");
      const posted = await call(h.post, { body: { run_id: RUN, direction } });
      expect(posted.json.design!.picked).toBe(true);
      const after = (await call(h.get, { query: { run_id: RUN } })).json.design!;
      expect(after.picked).toBe(true);
      expect(after.chosen).toBe(direction);
    }
  });
});

describe("GET site-design: each look's theme_css", () => {
  const starter = {
    [THEME_CSS_PATH]: renderThemeCss(getThemePreset("clean")!),
    "src/index.css": "@import './theme.css';\n:root { --primary: 0 0 0; }",
    "index.html": "<!doctype html><html><head></head><body></body></html>",
  };

  it("is exactly what applyDirectionToFiles writes into theme.css for that look, the brand look in the brief's own palette", async () => {
    const d = (await call(harness().get, { query: { run_id: RUN } })).json.design!;
    const directions = designDirections(BRIEF);
    expect(d.looks.map((l) => l.id)).toEqual(directions.map((x) => x.id));
    for (const direction of directions) {
      const written = applyDirectionToFiles(starter, BRIEF, direction)[THEME_CSS_PATH];
      expect(d.looks.find((l) => l.id === direction.id)!.layout).toBe(direction.layout);
      const css = d.looks.find((l) => l.id === direction.id)!.theme_css;
      expect(css).toBe(written);
      expect(directionInThemeCss(css!)).toBe(direction.id);
    }
    const brand = d.looks.find((l) => l.id === "brand")!.theme_css!;
    expect(brand).toBe(renderThemeCss(brandPreset(BRIEF)));
    expect(brand).toContain("--primary: 17 17 17;");
    expect(brand).toContain("--background: 255 255 255;");
    expect(brand).not.toBe(renderThemeCss(getThemePreset("studio")!));
    expect(new Set(d.looks.map((l) => l.theme_css)).size).toBe(3);
  });

  it("is null for every look when the site has no theme.css to write", async () => {
    for (const theme_mode of ["index_css", "none"] as const) {
      const d = (await call(harness({ row: designRow({ theme_mode }) }).get, { query: { run_id: RUN } })).json.design!;
      expect(d.looks.length).toBe(3);
      expect(d.looks.map((l) => l.theme_css)).toEqual([null, null, null]);
    }
  });
});

describe("GET site-design: preview", () => {
  it("is the site's name over the plan's home page, the same on every look and on the design", async () => {
    const h = harness({ siteRow: site({ name: "Ana Lens" }) });
    const d = (await call(h.get, { query: { run_id: RUN } })).json.design!;
    const expected = {
      name: "Ana Lens",
      eyebrow: "Couples planning a wedding",
      headline: "Photographs that feel like the day did",
      subtitle: "Fill the form",
      primary_action: "Send an enquiry",
      sections: [{ title: "Gallery", body: "Recent weddings" }],
    };
    expect(d.preview).toEqual(expected);
    for (const l of d.looks) expect(l.preview).toEqual(expected);
  });

  it("falls back to the site's label without a chosen name; without a plan the design has none but every look draws a sample", async () => {
    expect((await call(harness().get, { query: { run_id: RUN } })).json.design!.preview!.name).toBe("ana");
    const noPlan = harness({ row: designRow({ brief: { ...BRIEF, plan: undefined } }) });
    const d = (await call(noPlan.get, { query: { run_id: RUN } })).json.design!;
    expect(d.preview).toBeNull();
    expect(d.looks.map((l) => l.preview?.name)).toEqual(["ana", "ana", "ana"]);
    expect(d.looks.every((l) => l.preview!.eyebrow === "Couples planning a wedding" && l.preview!.sections.length === 1)).toBe(true);
  });

  it("passes hostile text through unmodified (the web escapes it)", async () => {
    const name = `<img src=x onerror="alert(1)">&amp;'`;
    const audience = `</title><script>alert("a")</script>`;
    const positioning = `"><svg onload=alert(1)> & 'quotes'`;
    const brief: DesignBrief = {
      ...BRIEF,
      audience,
      positioning,
      plan: {
        tone: "calm",
        primary_action: { label: "Book & pay 'now'", steps: "Fill the form" },
        pages: [{ path: "/", title: "Home", sections: [{ name: "Hero", headline: "Tom & Jerry's ; DROP TABLE" }, { name: "R&D 'lab'", headline: "100% &lt;real&gt;" }] }],
      },
    };
    const h = harness({ siteRow: site({ name }), row: designRow({ brief }) });
    const p = (await call(h.get, { query: { run_id: RUN } })).json.design!.preview!;
    expect(p).toEqual({
      name,
      eyebrow: audience,
      headline: "Tom & Jerry's ; DROP TABLE",
      subtitle: positioning,
      primary_action: "Book & pay 'now'",
      sections: [{ title: "R&D 'lab'", body: "100% &lt;real&gt;" }],
    });
  });
});

describe("GET site-design: each look shows its own structure", () => {
  const PLANNED: DesignBrief = withCompleteLook(
    {
      ...BRIEF,
      look: { base: "trust", layout: "split", alternates: ["clean", "luxe"] },
      plan: {
        tone: "calm",
        primary_action: { label: "Send an enquiry", steps: "Fill the form" },
        pages: [
          {
            path: "/",
            title: "Home",
            sections: [
              { name: "Hero", headline: "Photographs that feel like the day did", component: "Hero", variant: "split", image: { subject: "couple at dusk", role: "hero" } },
              { name: "Packages", headline: "Three ways to book", component: "Features", variant: "cards" },
              { name: "Kind words", headline: "Couples on their day", component: "Testimonials", variant: "cards" },
              { name: "Book", headline: "Hold your date", component: "CTA" },
            ],
          },
        ],
      },
    },
    "",
  );

  it("previews each look's hero, section variants and order, and the plan list follows the build's structure", async () => {
    const h = harness({ siteRow: site({ name: "Ana Lens" }), row: designRow({ brief: PLANNED }) });
    const d = (await call(h.get, { query: { run_id: RUN } })).json.design!;
    const shapes = d.looks.map((l) => JSON.stringify([l.layout, l.preview!.hero_variant, l.preview!.sections.map((s) => [s.title, s.kind, s.variant])]));
    expect(new Set(shapes).size).toBe(d.looks.length);
    expect(new Set(d.looks.map((l) => l.layout)).size).toBe(d.looks.length);
    expect(d.structure).toBeNull();
    const second = d.looks[1]!;
    const started = harness({ siteRow: site({ name: "Ana Lens" }), row: designRow({ brief: PLANNED, build_direction: second.id, chosen_direction: "brand" }) });
    const after = (await call(started.get, { query: { run_id: RUN } })).json.design!;
    expect(after.structure).toBe(second.id);
    expect(after.preview).toEqual(second.preview);
    expect(after.plan.sections.map((s) => s.name)).toEqual(second.preview!.sections.length ? ["Hero", ...second.preview!.sections.map((s) => s.title)] : []);
  });

  it("a request that already set the look never asks for a pick, and says what set it", async () => {
    const graph = [{ status: "done", payload: { stage: "provision", site_id: SITE_ID } }];
    for (const given of ["idea", "references", "template"] as const) {
      const h = harness({ graph, row: designRow({ brief: { ...BRIEF, look_given: given } }) });
      const d = (await call(h.get, { query: { run_id: RUN } })).json.design!;
      expect(d.awaiting_pick).toBe(false);
      expect(d.look_given).toBe(given);
      expect(d.locked).toBeNull();
    }
    expect((await call(harness({ graph }).get, { query: { run_id: RUN } })).json.design!.look_given).toBeNull();
  });
});

describe("POST site-design/direction: starting the parked build", () => {
  const post = (h: ReturnType<typeof harness>, direction: string) => call(h.post, { body: { run_id: RUN, direction } });

  it("a parked pick is saved in one database step with its wait check, then kicks the run once and says started", async () => {
    const h = harness({ graph: parkedGraph() });
    const r = await post(h, "luxe");
    expect(r.status).toBe(200);
    expect(r.json.started).toBe(true);
    expect(r.json.design!.chosen).toBe("luxe");
    expect(h.pickParked).toHaveBeenCalledWith({ tenant_id: TENANT, conductor_run_id: RUN, direction: "luxe", user_id: "u1" });
    expect(h.store.choose).not.toHaveBeenCalled();
    expect(h.kick).toHaveBeenCalledTimes(1);
    expect(h.kick).toHaveBeenCalledWith(RUN);
    expect(h.pickParked.mock.invocationCallOrder[0]).toBeLessThan(h.kick.mock.invocationCallOrder[0]!);
    expect(h.applyLive).toHaveBeenCalledTimes(1);
  });

  it("picking the recommended look the row already defaults to still records the pick and starts the build", async () => {
    const h = harness({ graph: parkedGraph() });
    const r = await post(h, "brand");
    expect(r.status).toBe(200);
    expect(r.json.started).toBe(true);
    expect(h.pickParked).toHaveBeenCalledTimes(1);
    expect(h.current()!.chosen_at).not.toBeNull();
    expect(h.kick).toHaveBeenCalledTimes(1);
  });

  it("a repeated parked pick kicks again; a pick whose write lands after the wait is refused and starts nothing", async () => {
    const h = harness({ graph: parkedGraph() });
    expect((await post(h, "luxe")).status).toBe(200);
    expect((await post(h, "luxe")).status).toBe(200);
    expect(h.kick).toHaveBeenCalledTimes(2);
    for (const state of ["expired", "ended", "not_found"]) {
      const late = harness({ graph: parkedGraph() });
      late.pickParked.mockResolvedValueOnce({ state });
      const r = await post(late, "luxe");
      expect(r.status).toBe(409);
      expect(r.json.error).toMatchObject({ code: "look_timed_out", reason: "ended" });
      expect(r.json.started).toBeUndefined();
      expect(late.kick).not.toHaveBeenCalled();
      expect(late.applyLive).not.toHaveBeenCalled();
      expect(late.store.choose).not.toHaveBeenCalled();
    }
  });

  it("a database error on the parked pick never claims a start; a sealed look is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failing = harness({ graph: parkedGraph() });
      failing.pickParked.mockRejectedValueOnce(new Error("db down"));
      const r = await post(failing, "luxe");
      expect(r.status).toBe(503);
      expect(r.json.started).toBeUndefined();
      expect(failing.kick).not.toHaveBeenCalled();
      const sealed = harness({ graph: parkedGraph() });
      sealed.pickParked.mockResolvedValueOnce({ state: "sealed" });
      expect((await post(sealed, "luxe")).json.error).toMatchObject({ code: "look_locked", reason: "built" });
      expect(sealed.kick).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("a build that moved on since the read ('not_parked') falls back to a normal pick", async () => {
    const h = harness({ graph: parkedGraph() });
    h.pickParked.mockResolvedValueOnce({ state: "not_parked" });
    const r = await post(h, "luxe");
    expect(r.status).toBe(200);
    expect(h.store.choose).toHaveBeenCalledTimes(1);
  });

  it("never kicks on 403, 400, 404 or 409", async () => {
    mocks.writer = false;
    const forbidden = harness({ graph: parkedGraph() });
    expect((await post(forbidden, "luxe")).status).toBe(403);
    mocks.writer = true;
    const unknown = harness({ graph: parkedGraph() });
    expect((await post(unknown, "midnight")).status).toBe(400);
    const missing = harness({ graph: parkedGraph(), row: null });
    expect((await post(missing, "luxe")).status).toBe(404);
    const sealed = harness({ graph: parkedGraph(), row: designRow({ sealed_at: "2026-10-07T00:30:00Z" }) });
    expect((await post(sealed, "luxe")).status).toBe(409);
    const unsupported = harness({ graph: parkedGraph(), row: designRow({ theme_mode: "index_css" }) });
    expect((await post(unsupported, "luxe")).json.error).toMatchObject({ code: "look_locked", reason: "unsupported" });
    const live = harness({ graph: parkedGraph(), siteRow: site({ live_sha: "a".repeat(40) }) });
    expect((await post(live, "luxe")).status).toBe(409);
    for (const h of [forbidden, unknown, missing, sealed, unsupported, live]) {
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.pickParked).not.toHaveBeenCalled();
    }
  });

  it("a mid-build switch (not parked) saves through the store, never the parked pick", async () => {
    const h = harness();
    const r = await post(h, "luxe");
    expect(r.status).toBe(200);
    expect(h.pickParked).not.toHaveBeenCalled();
    expect(h.store.choose).toHaveBeenCalledTimes(1);
    const racing = harness();
    racing.store.choose.mockResolvedValueOnce(null);
    expect((await post(racing, "editorial")).status).toBe(409);
    const broken = harness({ chooseError: new Error("db down") });
    const b = await post(broken, "luxe");
    expect(b.status).toBe(500);
    expect(b.json.started).toBeUndefined();
  });

  it("a failed kick still answers the saved pick as started (the parked-run cron picks it up)", async () => {
    const h = harness({ graph: parkedGraph() });
    h.kick.mockRejectedValueOnce(new Error("inngest down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await post(h, "luxe");
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json.started).toBe(true);
    expect(h.current()!.chosen_direction).toBe("luxe");
  });
});

describe("GET site-design: a brief with no plan still shows three real look samples", () => {
  const FALLBACK = fallbackDesignBrief({ idea: "a neighbourhood bakery selling sourdough and pastries" });

  it("a fallback brief awaiting a pick answers three looks, each with theme css and its own sample page in the site's name", async () => {
    expect(FALLBACK.plan).toBeUndefined();
    const h = harness({ siteRow: site({ name: "Crumb & Co" }), row: designRow({ brief: FALLBACK }), graph: parkedGraph() });
    const r = await call(h.get, { query: { run_id: RUN } });
    const d = r.json.design!;
    expect(d.awaiting_pick).toBe(true);
    expect(d.preview).toBeNull();
    expect(d.looks).toHaveLength(3);
    for (const l of d.looks) {
      expect(l.theme_css).toEqual(expect.stringContaining(":root"));
      expect(l.preview).not.toBeNull();
      expect(l.preview!.name).toBe("Crumb & Co");
      expect(l.preview!.headline).toContain("Crumb & Co");
      expect(l.preview!.primary_action).toBe("Get in touch");
      expect(l.preview!.eyebrow.length).toBeGreaterThan(0);
      expect(l.preview!.sections).toHaveLength(1);
      expect(l.preview!.sections[0]!.kind).toBeTruthy();
    }
    expect(new Set(d.looks.map((l) => l.preview!.hero_variant)).size).toBe(3);
    expect(new Set(d.looks.map((l) => `${l.preview!.sections[0]!.kind}:${l.preview!.sections[0]!.variant ?? ""}`)).size).toBe(3);
  });

  it("uses the brief's positioning, audience and plan action when it has them, and still draws without a site name", async () => {
    const brief: DesignBrief = {
      ...FALLBACK,
      audience: "Early risers on the high street",
      positioning: "Bread baked before sunrise",
      plan: { tone: "warm", primary_action: { label: "Order a loaf", steps: "Pick a loaf" }, pages: [{ path: "/menu", title: "Menu", sections: [{ name: "Menu", headline: "Today" }] }] },
    };
    const h = harness({ siteRow: site({ name: null, label: "  " }), row: designRow({ brief }) });
    const d = (await call(h.get, { query: { run_id: RUN } })).json.design!;
    expect(d.preview).toBeNull();
    for (const l of d.looks) {
      expect(l.preview).toMatchObject({ name: "Your business", eyebrow: "Early risers on the high street", headline: "Bread baked before sunrise", primary_action: "Order a loaf" });
    }
  });

  it("names the recommended look plainly instead of its title-cased mood, so the mood never shows twice", async () => {
    const h = harness({ siteRow: site({ name: "Crumb & Co" }), row: designRow({ brief: FALLBACK }), graph: parkedGraph() });
    const d = (await call(h.get, { query: { run_id: RUN } })).json.design!;
    const raw = designDirections(FALLBACK);
    expect(raw[0]!.mood.toLowerCase().startsWith(raw[0]!.label.toLowerCase())).toBe(true);
    expect(d.looks[0]!.recommended).toBe(true);
    expect(d.looks[0]!.label).toBe("Made for you");
    for (const l of d.looks) expect(l.mood.toLowerCase().startsWith(l.label.toLowerCase())).toBe(false);
    expect(d.looks.slice(1).map((l) => l.label)).toEqual(raw.slice(1).map((x) => x.label));
    expect(new Set(d.looks.map((l) => l.label)).size).toBe(3);
  });

  it("plainLookLabel keeps a real name and only replaces the recommended look's mood title", async () => {
    const { plainLookLabel } = await import("../site-design");
    expect(plainLookLabel({ label: "Crisp, Bright And Confident", mood: "Crisp, bright and confident", recommended: true })).toBe("Made for you");
    expect(plainLookLabel({ label: "Warm Rustic", mood: "warm rustic and welcoming. Bread daily", recommended: true })).toBe("Made for you");
    expect(plainLookLabel({ label: "Clean & modern", mood: "Crisp, bright and confident", recommended: true })).toBe("Clean & modern");
    expect(plainLookLabel({ label: "Warm editorial", mood: "Warm editorial vibes", recommended: false })).toBe("Warm editorial");
    expect(plainLookLabel({ label: "  ", mood: "", recommended: false })).toBe("Made for you");
  });

  it("every layout gets its own hero and section", async () => {
    const { sampleLookPreview } = await import("../site-design");
    const layouts = ["split", "centered", "editorial", "bold", "minimal"] as const;
    const shapes = layouts.map((layout) => {
      const p = sampleLookPreview(FALLBACK, { layout, mood: "Calm: quiet" }, "Crumb");
      return `${p.hero_variant}|${p.sections[0]!.kind}|${p.sections[0]!.variant ?? ""}`;
    });
    expect(new Set(shapes).size).toBe(layouts.length);
  });

  it("no layout's sample preview shows a testimonial or stats section the owner never gave", async () => {
    const { sampleLookPreview } = await import("../site-design");
    for (const layout of ["split", "centered", "editorial", "bold", "minimal"] as const) {
      const p = sampleLookPreview(FALLBACK, { layout, mood: "Calm: quiet" }, "Crumb");
      const s = p.sections[0]!;
      expect(["Testimonials", "Stats"]).not.toContain(s.kind);
      expect(`${s.title} ${s.body}`).not.toMatch(/kind words|in numbers|reviews|testimonial/i);
    }
  });
});
