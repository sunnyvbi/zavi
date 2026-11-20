import { describe, it, expect, vi, beforeEach } from "vitest";
import { startFastBuild, type FastBuildDeps } from "@/services/agents/fast-build";
import { buildSiteGoalGraph } from "@/services/agents/product-pipeline";
import type { ConductorNode } from "@/services/agents/conductor";
import type { FastBuildContext, StarterFiles } from "@/services/sites/contract";
import type { SiteDesignRow, SiteDesignStore } from "@/services/sites/site-design-store";
import { lookAwaitingSiteId } from "@/services/sites/look-wait";
import { getSiteTemplate } from "@/services/sites/site-templates";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { fakeRepo, fakeStore, fakeSupabase, type FakeRepo, type FakeStore, type FakeSupabase } from "@/services/sites/__tests__/site-fakes";
import { contrast, parseDesignBrief } from "@/services/sites/design-brief";
import { presetBriefColors } from "@/services/sites/design-directions";
import { getThemePreset } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";

const T1 = "11111111-1111-4111-8111-111111111111";

const THEME_STARTER: StarterFiles = {
  files: {
    "package.json": "{}",
    "src/index.css": TEMPLATE_FILES["src/index.css"],
    "src/theme.css": TEMPLATE_FILES["src/theme.css"],
    "index.html": TEMPLATE_FILES["index.html"],
  },
  manifest_json: '{"schemaVersion":1,"collections":{}}',
};
const INDEX_CSS_STARTER: StarterFiles = {
  files: { "package.json": "{}", "src/index.css": ":root { --primary: 1 2 3; }", "index.html": "<html></html>" },
  manifest_json: '{"schemaVersion":1,"collections":{}}',
};
const BARE_STARTER: StarterFiles = {
  files: { "package.json": "{}" },
  manifest_json: '{"schemaVersion":1,"collections":{}}',
};

function memoryDesignStore(): SiteDesignStore & { rows: Map<string, SiteDesignRow> } {
  const rows = new Map<string, SiteDesignRow>();
  const unused = async () => {
    throw new Error("not used");
  };
  return {
    rows,
    async get(_t, site_id) {
      return rows.get(site_id) ?? null;
    },
    async createIfAbsent(r) {
      if (!rows.has(r.site_id)) {
        rows.set(r.site_id, {
          ...r,
          chosen_direction: "brand",
          chosen_at: null,
          applied_direction: r.theme_mode === "none" ? null : "brand",
          sealed_at: null,
          journey_fix_claimed_at: null,
          journey_fix_conductor_run_id: null,
          fidelity: null,
          updated_at: null,
        });
      }
      return rows.get(r.site_id)!;
    },
    choose: unused,
    markApplied: unused,
    seal: unused,
    claimJourneyFix: unused,
    releaseJourneyFix: unused,
    recordFidelity: unused,
  };
}

function ctx(over: Partial<FastBuildContext> = {}): FastBuildContext {
  return {
    tenant_id: T1,
    conductor_run_id: "run-1",
    company_name: "Studio Co",
    idea: "A booking site",
    max_usd: 50,
    started_by_user_id: "u1",
    owner_email: null,
    first_build_free: false,
    await_look_pick: true,
    ...over,
  };
}

let store: FakeStore;
let repo: FakeRepo;
let sb: FakeSupabase;
let graphs: ConductorNode[][];

beforeEach(() => {
  store = fakeStore();
  repo = fakeRepo();
  sb = fakeSupabase(store);
  graphs = [];
});

function deps(starter: StarterFiles, over: Partial<FastBuildDeps>): Partial<FastBuildDeps> {
  return {
    store,
    repo,
    supabase: sb,
    starter: { starterFiles: () => starter },
    pooled: {
      enabledFor: vi.fn(async () => true),
      starter: vi.fn(async () => ({ starterFiles: () => starter })),
      initStatic: vi.fn(async () => undefined),
    } as unknown as FastBuildDeps["pooled"],
    updateConductorRunStatus: async (p) => {
      graphs.push(p.goal_graph as ConductorNode[]);
    },
    ensureGithubConnector: vi.fn(async () => undefined),
    alert: async () => undefined,
    sleep: async () => undefined,
    publishOnRequest: async () => false,
    designBrief: async () => ({ brief: null, reason: "test_default" }),
    ...over,
  };
}

async function firstGraph(
  starter: StarterFiles,
  over: Partial<FastBuildDeps>,
  ctxOver: Partial<FastBuildContext> = {},
): Promise<ConductorNode[]> {
  const r = await startFastBuild(ctx(ctxOver), deps(starter, over));
  expect(r.kind).toBe("started");
  expect(graphs).toHaveLength(1);
  return graphs[0];
}

function marked(graph: ConductorNode[]): string[] {
  return graph.filter((n) => n.payload.await_look === true).map((n) => String(n.payload.stage));
}

describe("startFastBuild: the first build is marked to wait for the look", () => {
  it("flag on, a design store and a live-switchable theme: only the build node waits", async () => {
    const designStore = memoryDesignStore();
    const waitsForLook = vi.fn(async () => true);
    const graph = await firstGraph(THEME_STARTER, { designStore, waitsForLook });
    expect(marked(graph)).toEqual(["build"]);
    const [site] = [...store.sites.values()];
    expect(lookAwaitingSiteId(graph)).toBe(site.id);
    expect(designStore.rows.get(site.id)?.theme_mode).toBe("theme_css");
    expect(waitsForLook).toHaveBeenCalledWith(T1);
  });

  it("a caller that did not opt in (no web picker): no node waits and the flag is not read", async () => {
    const waitsForLook = vi.fn(async () => true);
    for (const ctxOver of [{ await_look_pick: undefined }, { await_look_pick: false }]) {
      store = fakeStore();
      repo = fakeRepo();
      sb = fakeSupabase(store);
      graphs = [];
      const graph = await firstGraph(THEME_STARTER, { designStore: memoryDesignStore(), waitsForLook }, ctxOver);
      expect(marked(graph)).toEqual([]);
      expect(lookAwaitingSiteId(graph)).toBeNull();
    }
    expect(waitsForLook).not.toHaveBeenCalled();
  });

  it("flag off: no node waits", async () => {
    const graph = await firstGraph(THEME_STARTER, { designStore: memoryDesignStore(), waitsForLook: async () => false });
    expect(marked(graph)).toEqual([]);
    expect(lookAwaitingSiteId(graph)).toBeNull();
  });

  it("no design store: no node waits", async () => {
    const graph = await firstGraph(THEME_STARTER, { designStore: null, waitsForLook: async () => true });
    expect(marked(graph)).toEqual([]);
  });

  it("a theme that cannot switch live (index.css tokens, or none): no node waits", async () => {
    for (const starter of [INDEX_CSS_STARTER, BARE_STARTER]) {
      store = fakeStore();
      repo = fakeRepo();
      sb = fakeSupabase(store);
      graphs = [];
      const designStore = memoryDesignStore();
      const graph = await firstGraph(starter, { designStore, waitsForLook: async () => true });
      expect(marked(graph)).toEqual([]);
      const [site] = [...store.sites.values()];
      expect(designStore.rows.get(site.id)?.theme_mode).not.toBe("theme_css");
    }
  });

  it("an idea that already says how the site should look starts right away, and the looks stay on offer", async () => {
    const designStore = memoryDesignStore();
    const idea = "A florist site, soft pastel pink with lots of white space, same-day delivery orders.";
    const designBrief: FastBuildDeps["designBrief"] = async () => ({
      brief: {
        industry: "florist",
        mood: "soft airy fresh",
        mode: "light",
        colors: { background: "#ffffff", foreground: "#1f1f1f", muted: "#f7f0f2", "muted-foreground": "#5a5a5a", primary: "#c2416b", "primary-foreground": "#ffffff", border: "#eadde1" },
        fonts: { heading: "DM Sans", body: "Inter" },
        direction_given: "soft pastel pink with lots of white space",
        look_given: "idea",
        source: "model",
      },
    });
    const graph = await firstGraph(THEME_STARTER, { designStore, waitsForLook: async () => true, designBrief }, { idea });
    expect(marked(graph)).toEqual([]);
    const [site] = [...store.sites.values()];
    expect(designStore.rows.get(site.id)?.directions.length).toBeGreaterThanOrEqual(2);
  });

  it("a timed-out brief still obeys explicit visual direction and starts right away", async () => {
    const designStore = memoryDesignStore();
    const idea = "A boxing gym website with a dark black background, red accents and bold typography";
    const graph = await firstGraph(
      THEME_STARTER,
      { designStore, waitsForLook: async () => true },
      { idea },
    );
    expect(marked(graph)).toEqual([]);
    const [site] = [...store.sites.values()];
    const row = designStore.rows.get(site.id)!;
    expect(row.brief).toMatchObject({
      look_given: "idea",
      mode: "dark",
      colors: { background: "#0a0a0a", primary: "#dc2626" },
    });
    expect(row.directions.length).toBeGreaterThanOrEqual(2);
  });

  it("reference images set the look: the build starts right away (recorded on the brief for the Build view)", async () => {
    const designStore = memoryDesignStore();
    const graph = await firstGraph(THEME_STARTER, { designStore, waitsForLook: async () => true }, { reference_images: ["https://example.com/ref.jpg"] });
    expect(marked(graph)).toEqual([]);
    const [site] = [...store.sites.values()];
    expect(designStore.rows.get(site.id)?.brief.look_given).toBe("references");
  });

  it("a starting template steers the brief and sets the look: the build starts right away in the template's layout", async () => {
    const designStore = memoryDesignStore();
    const template = getSiteTemplate("portfolio")!;
    const designBrief = vi.fn<Parameters<FastBuildDeps["designBrief"]>, ReturnType<FastBuildDeps["designBrief"]>>(async () => ({ brief: null, reason: "test_default" }));
    const graph = await firstGraph(THEME_STARTER, { designStore, waitsForLook: async () => true, designBrief }, { site_template: JSON.parse(JSON.stringify(template)) });
    expect(marked(graph)).toEqual([]);
    expect(designBrief.mock.calls[0]![0].templateLines).toContain(`the founder picked "${template.label}"`);
    const [site] = [...store.sites.values()];
    const row = designStore.rows.get(site.id)!;
    expect(row.brief.look_given).toBe("template");
    expect(row.brief.template).toEqual({ id: template.id, v: template.v });
    expect(row.directions[0]!.layout).toBe(template.look.layout);
  });

  it("a malformed template snapshot is ignored: the build asks for a look as usual", async () => {
    const designBrief = vi.fn<Parameters<FastBuildDeps["designBrief"]>, ReturnType<FastBuildDeps["designBrief"]>>(async () => ({ brief: null, reason: "test_default" }));
    const graph = await firstGraph(THEME_STARTER, { designStore: memoryDesignStore(), waitsForLook: async () => true, designBrief }, { site_template: { id: "portfolio" } });
    expect(marked(graph)).toEqual(["build"]);
    expect(designBrief.mock.calls[0]![0].templateLines).toBeUndefined();
  });

  it("a flag read that throws falls back to the setting's default: wait", async () => {
    const graph = await firstGraph(THEME_STARTER, {
      designStore: memoryDesignStore(),
      waitsForLook: async () => {
        throw new Error("settings down");
      },
    });
    expect(marked(graph)).toEqual(["build"]);
  });
});

describe("buildSiteGoalGraph await_look", () => {
  const input = { tenant_id: T1, company_name: "Acme", idea: "x", max_usd: 5 };
  const opts = {
    site_id: "s1",
    target: { github_full_name: "o/r", repo_url: "https://github.com/o/r", default_branch: "main" },
    seed_sha: "a".repeat(40),
    publish_on_request: false,
  };
  it("is carried only when asked for, and only on the build node", () => {
    expect(marked(buildSiteGoalGraph(input, { ...opts, await_look: true }) as unknown as ConductorNode[])).toEqual(["build"]);
    expect(marked(buildSiteGoalGraph(input, { ...opts, await_look: false }) as unknown as ConductorNode[])).toEqual([]);
    expect(marked(buildSiteGoalGraph(input, opts) as unknown as ConductorNode[])).toEqual([]);
  });
});

describe("startFastBuild: the recommended look follows the industry look rules", () => {
  const GYM_IDEA = "help me make gym website";
  const gymReply = `<brief_json>${JSON.stringify({
    industry: "Fitness",
    mood: "clean modern professional",
    mode: "light",
    colors: { background: "#ffffff", foreground: "#0f172a", muted: "#f1f5f9", "muted-foreground": "#64748b", primary: "#2563eb", "primary-foreground": "#ffffff", border: "#e2e8f0" },
    fonts: { heading: "Plus Jakarta Sans", body: "Inter" },
    look: { base: "clean", layout: "split", alternates: ["fresh", "trust"] },
    visual_intent: { given: false, quote: "" },
  })}</brief_json>`;
  const gymBrief: FastBuildDeps["designBrief"] = async (input) => ({ brief: parseDesignBrief(gymReply, { idea: input.idea })! });

  async function recommended(over: Partial<FastBuildDeps>) {
    const designStore = memoryDesignStore();
    await firstGraph(THEME_STARTER, { designStore, waitsForLook: async () => true, designBrief: gymBrief, ...over }, { idea: GYM_IDEA });
    const [site] = [...store.sites.values()];
    const row = designStore.rows.get(site.id)!;
    return { row, rec: row.directions.find((d) => d.recommended)! };
  }

  it("a gym idea the model styled as generic SaaS starts in a dark, energetic, bold look", async () => {
    const industryLookRules = vi.fn(async () => true);
    const { row, rec } = await recommended({ industryLookRules });
    expect(industryLookRules).toHaveBeenCalledWith(T1);
    expect(rec.id).toBe("brand");
    expect(rec.preset.colors.background).toBe(presetBriefColors(getThemePreset("midnight")!).background);
    expect(rec.preset.colors.primary).not.toBe("#2563eb");
    expect(["Bricolage Grotesque", "Archivo", "Space Grotesk", "Outfit"]).toContain(rec.preset.fonts.display);
    expect(rec.layout).toBe("bold");
    expect(row.brief.mode).toBe("dark");
    expect(contrast(row.brief.colors.foreground, row.brief.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(row.brief.colors["primary-foreground"], row.brief.colors.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it("flag off: the model's look is kept as it was", async () => {
    const { row, rec } = await recommended({ industryLookRules: async () => false });
    expect(rec.preset.colors.primary).toBe("#2563eb");
    expect(rec.preset.fonts).toEqual({ display: "Plus Jakarta Sans", body: "Inter" });
    expect(rec.layout).toBe("split");
    expect(row.brief.look!.base).toBe("clean");
  });

  it("a flag read that throws falls back to the setting's default: the rules apply", async () => {
    const { rec } = await recommended({
      industryLookRules: async () => {
        throw new Error("settings down");
      },
    });
    expect(rec.layout).toBe("bold");
    expect(rec.preset.colors.primary).not.toBe("#2563eb");
  });

  it("reference images set the look: the rules do not touch it", async () => {
    const designStore = memoryDesignStore();
    await firstGraph(
      THEME_STARTER,
      { designStore, waitsForLook: async () => true, designBrief: gymBrief, industryLookRules: async () => true },
      { idea: GYM_IDEA, reference_images: ["https://example.com/ref.jpg"] },
    );
    const [site] = [...store.sites.values()];
    expect(designStore.rows.get(site.id)!.directions.find((d) => d.recommended)!.preset.colors.primary).toBe("#2563eb");
  });
});
