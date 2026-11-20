import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { startFastBuild, type FastBuildDeps } from "@/services/agents/fast-build";
import { getSiteTemplate } from "@/services/sites/site-templates";
import { retrySiteSetup, startProductBuild, type StartProductBuildDeps } from "@/services/agents/start-product-build";
import { SITE_SETUP_MARKER_KEY } from "@/services/agents/site-setup-marker";
import type { ConductorNode } from "@/services/agents/conductor";
import type { StarterFiles } from "@/services/sites/contract";
import type { SiteDesignRow, SiteDesignStore } from "@/services/sites/site-design-store";
import { lookAwaitingSiteId } from "@/services/sites/look-wait";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { fakeRepo, fakeStore, fakeSupabase } from "@/services/sites/__tests__/site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
const BASE = { tenant_id: T1, company_name: "Studio Co", idea: "A booking site for a calm yoga studio", started_by_user_id: "u1" };

const THEME_STARTER: StarterFiles = {
  files: {
    "package.json": "{}",
    "src/index.css": TEMPLATE_FILES["src/index.css"],
    "src/theme.css": TEMPLATE_FILES["src/theme.css"],
    "index.html": TEMPLATE_FILES["index.html"],
  },
  manifest_json: '{"schemaVersion":1,"collections":{}}',
};

function memoryDesignStore(): SiteDesignStore {
  const rows = new Map<string, SiteDesignRow>();
  const unused = async () => {
    throw new Error("not used");
  };
  return {
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

let graphs: ConductorNode[][];
let waitsForLook: Mock<[tenant_id: string], Promise<boolean>>;
let flagOn: boolean;

function fastDeps(): Partial<FastBuildDeps> {
  const store = fakeStore();
  return {
    store,
    repo: fakeRepo(),
    supabase: fakeSupabase(store),
    starter: { starterFiles: () => THEME_STARTER },
    pooled: {
      enabledFor: vi.fn(async () => true),
      starter: vi.fn(async () => ({ starterFiles: () => THEME_STARTER })),
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
    designStore: memoryDesignStore(),
    waitsForLook,
  };
}

function deps(over: Partial<StartProductBuildDeps> = {}): StartProductBuildDeps {
  const fd = fastDeps();
  return {
    checkSitePrereqs: vi.fn().mockResolvedValue({ ok: true }),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    assertBuildCredits: vi.fn().mockResolvedValue(undefined),
    resolveOwnerEmail: vi.fn().mockResolvedValue(null),
    resolveWorkspaceName: vi.fn().mockResolvedValue(null),
    resolveSiteName: vi.fn().mockResolvedValue("Calm Yoga"),
    startFastBuild: (ctx) => startFastBuild(ctx, fd),
    ...over,
  };
}

function buildWaits(): boolean {
  expect(graphs).toHaveLength(1);
  return lookAwaitingSiteId(graphs[0]) !== null;
}

beforeEach(() => {
  graphs = [];
  flagOn = true;
  waitsForLook = vi.fn(async (_tenant_id: string) => flagOn);
});

describe("only a build the founder started from the web build flow waits for the look pick", () => {
  it("web opt-in with the flag on: the build node is parked on the look", async () => {
    await startProductBuild({ ...BASE, await_look_pick: true }, deps());
    expect(buildWaits()).toBe(true);
    expect(waitsForLook).toHaveBeenCalledWith(T1);
  });

  it("no opt-in (chat tool, Slack, cron, mobile) with the flag on: the build runs at once and the flag is never read", async () => {
    await startProductBuild(BASE, deps());
    expect(buildWaits()).toBe(false);
    expect(graphs[0].some((n) => n.payload.await_look === true)).toBe(false);
    expect(waitsForLook).not.toHaveBeenCalled();
  });

  it("an opt-in that is not exactly true does not park the build", async () => {
    await startProductBuild({ ...BASE, await_look_pick: "true" as unknown as boolean }, deps());
    expect(buildWaits()).toBe(false);
  });

  it("web opt-in with the flag off: no marker", async () => {
    flagOn = false;
    await startProductBuild({ ...BASE, await_look_pick: true }, deps());
    expect(buildWaits()).toBe(false);
  });

  it("a failed web setup keeps the opt-in on its retry marker and the Retry parks the build", async () => {
    const failed = vi.fn().mockResolvedValue(undefined);
    await expect(
      startProductBuild(
        { ...BASE, await_look_pick: true },
        deps({
          updateConductorRunStatus: failed,
          startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "repo: boom", retryable: true }),
        }),
      ),
    ).rejects.toThrow();
    const goal_graph = failed.mock.calls.find((c) => c[0].status === "failed")![0].goal_graph as ConductorNode[];
    const marker = goal_graph.map((n) => n.payload[SITE_SETUP_MARKER_KEY]).find(Boolean) as Record<string, unknown>;
    expect(marker.await_look_pick).toBe(true);

    const r = await retrySiteSetup(
      T1,
      { id: "cr_1", updated_at: "2026-10-07T00:00:00Z", goal_graph },
      deps({ claimSiteSetupRetry: vi.fn().mockResolvedValue("resumed") }),
    );
    expect(r).toEqual({ ok: true, run_id: "cr_1" });
    expect(buildWaits()).toBe(true);
  });

  it("a picked template rides the setup as a snapshot, and a Retry builds from that same snapshot", async () => {
    const failed = vi.fn().mockResolvedValue(undefined);
    const template = getSiteTemplate("classes-and-events")!;
    await expect(
      startProductBuild(
        { ...BASE, await_look_pick: true, site_template: template },
        deps({
          updateConductorRunStatus: failed,
          startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "repo: boom", retryable: true }),
        }),
      ),
    ).rejects.toThrow();
    const goal_graph = failed.mock.calls.find((c) => c[0].status === "failed")![0].goal_graph as ConductorNode[];
    const marker = goal_graph.map((n) => n.payload[SITE_SETUP_MARKER_KEY]).find(Boolean) as Record<string, unknown>;
    expect(marker.site_template).toEqual(JSON.parse(JSON.stringify(template)));
    const startFast = vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "again", retryable: true });
    await retrySiteSetup(
      T1,
      { id: "cr_1", updated_at: "2026-10-07T00:00:00Z", goal_graph },
      deps({ claimSiteSetupRetry: vi.fn().mockResolvedValue("resumed"), startFastBuild: startFast, updateConductorRunStatus: vi.fn().mockResolvedValue(undefined) }),
    ).catch(() => undefined);
    expect(startFast.mock.calls[0]![0].site_template).toEqual(marker.site_template);
  });

  it("a failed non-web setup retries without waiting", async () => {
    const failed = vi.fn().mockResolvedValue(undefined);
    await expect(
      startProductBuild(
        BASE,
        deps({
          updateConductorRunStatus: failed,
          startFastBuild: vi.fn().mockResolvedValue({ kind: "setup_failed", reason: "repo: boom", retryable: true }),
        }),
      ),
    ).rejects.toThrow();
    const goal_graph = failed.mock.calls.find((c) => c[0].status === "failed")![0].goal_graph as ConductorNode[];
    await retrySiteSetup(
      T1,
      { id: "cr_1", updated_at: "2026-10-07T00:00:00Z", goal_graph },
      deps({ claimSiteSetupRetry: vi.fn().mockResolvedValue("resumed") }),
    );
    expect(buildWaits()).toBe(false);
  });
});
