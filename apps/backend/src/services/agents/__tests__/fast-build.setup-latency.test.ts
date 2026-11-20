import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startFastBuild, type FastBuildDeps } from "@/services/agents/fast-build";
import type { FastBuildContext, StarterFiles } from "@/services/sites/contract";
import type { ConductorNode } from "@/services/agents/conductor";
import type { DesignBrief, DesignBriefResult } from "@/services/sites/design-brief";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { brandPreset } from "@/services/sites/design-directions";
import { renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { fakeRepo, fakeStore, fakeSupabase, type FakeRepo, type FakeStore, type FakeSupabase } from "@/services/sites/__tests__/site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";

function ctx(over: Partial<FastBuildContext> = {}): FastBuildContext {
  return {
    tenant_id: T1,
    conductor_run_id: "run-1",
    company_name: "Studio Co",
    site_name: "Paws and Suds",
    idea: "A booking site for a dog groomer",
    max_usd: 50,
    started_by_user_id: "u1",
    owner_email: "owner@example.com",
    first_build_free: false,
    ...over,
  };
}

const STYLED: StarterFiles = {
  files: {
    "package.json": "{}",
    "src/index.css": TEMPLATE_FILES["src/index.css"],
    "src/theme.css": TEMPLATE_FILES["src/theme.css"],
    "index.html": TEMPLATE_FILES["index.html"],
  },
  manifest_json: '{"schemaVersion":1,"collections":{}}',
};

function brief(primary: string): DesignBrief {
  return {
    industry: "pet grooming",
    mood: "friendly",
    mode: "light",
    colors: {
      background: "#ffffff",
      foreground: "#111111",
      muted: "#eeeeee",
      "muted-foreground": "#555555",
      primary,
      "primary-foreground": "#ffffff",
      border: "#dddddd",
    },
    fonts: { heading: "Fraunces", body: "DM Sans" },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

let store: FakeStore;
let repo: FakeRepo;
let sb: FakeSupabase;
let events: string[];
let graphs: Array<{ conductor_run_id: string; goal_graph: ConductorNode[] }>;
let unhandled: unknown[];
const onUnhandled = (e: unknown) => {
  unhandled.push(e);
};

function pooled() {
  return {
    enabledFor: vi.fn(async () => true),
    starter: vi.fn(async () => ({ starterFiles: () => STYLED })),
    initStatic: vi.fn(async (_t: string, s: string) => {
      events.push("initStatic");
      const site = store.sites.get(s);
      if (site) site.backend_mode = "static";
    }),
  };
}

function deps(over: Partial<FastBuildDeps> = {}): Partial<FastBuildDeps> {
  return {
    store,
    repo,
    supabase: sb,
    starter: null,
    pooled: pooled(),
    updateConductorRunStatus: async (p) => {
      events.push("active");
      graphs.push(p);
    },
    ensureGithubConnector: vi.fn(async () => {
      events.push("connector");
    }),
    requestTick: vi.fn(async () => {
      events.push("tick");
    }),
    alert: async () => undefined,
    sleep: async () => undefined,
    publishOnRequest: async () => false,
    designBrief: async () => ({ brief: null, reason: "test_default" }),
    designStore: null,
    ...over,
  };
}

beforeEach(() => {
  store = fakeStore();
  repo = fakeRepo();
  sb = fakeSupabase(store);
  events = [];
  graphs = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

describe("startFastBuild: the design brief and setting reads start before the site exists", () => {
  it("asks for the brief (with the site's name) and the setting reads while the site read is still pending, and the seed still waits for the brief", async () => {
    const siteRead = deferred<void>();
    const getByRun = store.getByRun.bind(store);
    store.getByRun = async (t, r) => {
      events.push("getByRun");
      await siteRead.promise;
      return getByRun(t, r);
    };
    const briefGate = deferred<DesignBriefResult>();
    const designBrief = vi.fn((_input: { idea: string; name?: string | null }) => {
      events.push("brief");
      return briefGate.promise;
    });
    const autoSiteOwner = vi.fn(async () => true);
    const publishOnRequest = vi.fn(async () => false);
    const seeded: Array<Record<string, string>> = [];
    repo.seed = async (_t: string, _r: string, files: Record<string, string>) => {
      events.push("seed");
      seeded.push(files);
      return "a".repeat(40);
    };
    const run = startFastBuild(ctx(), deps({ designBrief, autoSiteOwner, publishOnRequest }));
    await flush();
    expect(designBrief).toHaveBeenCalledTimes(1);
    expect(designBrief).toHaveBeenCalledWith({ idea: ctx().idea, name: "Paws and Suds" });
    expect(autoSiteOwner).toHaveBeenCalledWith(T1);
    expect(publishOnRequest).toHaveBeenCalledWith(T1);
    expect([...events].sort()).toEqual(["brief", "getByRun"]);
    siteRead.resolve();
    await flush(10);
    expect(events).toContain("initStatic");
    expect(events).not.toContain("seed");
    briefGate.resolve({ brief: brief("#b4532a") });
    const r = await run;
    expect(r.kind).toBe("started");
    expect(designBrief).toHaveBeenCalledTimes(1);
    const stored = graphs[0].goal_graph[1].payload.design_brief as DesignBrief;
    expect(stored).toMatchObject(brief("#b4532a"));
    expect(seeded[0]["src/theme.css"]).toBe(renderThemeCss(brandPreset(stored)));
  });

  it("a site whose stored name differs from the predicted one gets a brief for its REAL name, which is what is seeded and stored", async () => {
    const create = store.getOrCreateForRun.bind(store);
    store.getOrCreateForRun = async (input) => ({ ...(await create(input)), name: "Paws & Suds Co" });
    const designBrief = vi.fn(async (input: { idea: string; name?: string | null }) => ({
      brief: brief(input.name === "Paws & Suds Co" ? "#b4532a" : "#2563eb"),
    }));
    const seeded: Array<Record<string, string>> = [];
    repo.seed = async (_t: string, _r: string, files: Record<string, string>) => {
      seeded.push(files);
      return "a".repeat(40);
    };
    const r = await startFastBuild(ctx(), deps({ designBrief }));
    expect(r.kind).toBe("started");
    expect(designBrief.mock.calls.map((c) => c[0].name)).toEqual(["Paws and Suds", "Paws & Suds Co"]);
    const stored = graphs[0].goal_graph[1].payload.design_brief as DesignBrief;
    expect(stored).toMatchObject(brief("#b4532a"));
    expect(seeded[0]["src/theme.css"]).toBe(renderThemeCss(brandPreset(stored)));
  });

  it("a stored name that differs only in spacing or case reuses the first brief instead of paying for a second", async () => {
    const create = store.getOrCreateForRun.bind(store);
    store.getOrCreateForRun = async (input) => ({ ...(await create(input)), name: " paws  and SUDS " });
    const designBrief = vi.fn(async () => ({ brief: brief("#b4532a") }));
    const r = await startFastBuild(ctx(), deps({ designBrief }));
    expect(r.kind).toBe("started");
    expect(designBrief).toHaveBeenCalledTimes(1);
    expect(graphs[0].goal_graph[1].payload.design_brief).toMatchObject(brief("#b4532a"));
  });

  it("the default brief call is capped at 20 seconds", async () => {
    const { DESIGN_BRIEF_TIMEOUT_MS, sameBriefName } = await import("../fast-build");
    expect(DESIGN_BRIEF_TIMEOUT_MS).toBe(20_000);
    expect(sameBriefName("Paws & Suds Co", "Paws and Suds")).toBe(false);
    expect(sameBriefName(null, "")).toBe(true);
  });

  it("a Retry predicts its existing site's name and asks for the brief once", async () => {
    await startFastBuild(ctx({ site_name: null }), deps({ updateConductorRunStatus: async () => { throw new Error("db down"); } }));
    const [site] = [...store.sites.values()];
    expect(site.name).toBeNull();
    const designBrief = vi.fn(async () => ({ brief: null, reason: "x" }) as DesignBriefResult);
    const r = await startFastBuild(ctx({ site_name: null }), deps({ designBrief }));
    expect(r.kind).toBe("started");
    expect(designBrief).toHaveBeenCalledTimes(1);
    expect(designBrief).toHaveBeenCalledWith({ idea: ctx().idea, name: null });
  });

  it("a setup refused before any site exists, with a brief that rejects, leaves no unhandled rejection", async () => {
    const designBrief = vi.fn(async () => {
      throw new Error("model down");
    });
    const p = pooled();
    p.enabledFor.mockResolvedValue(false as never);
    const r = await startFastBuild(ctx(), deps({ designBrief, pooled: p }));
    expect(r).toMatchObject({ kind: "setup_failed", reason: "provisioning_failed:backend" });
    expect(designBrief).toHaveBeenCalledTimes(1);
    await flush(10);
    expect(unhandled).toEqual([]);
  });

  it("a site read that fails, with a brief that rejects later, leaves no unhandled rejection", async () => {
    const late = deferred<DesignBriefResult>();
    store.getByRun = async () => {
      throw new Error("db down");
    };
    const r = await startFastBuild(ctx(), deps({ designBrief: () => late.promise }));
    expect(r).toMatchObject({ kind: "setup_failed", reason: "site_row_failed" });
    late.reject(new Error("model down"));
    await flush(10);
    expect(unhandled).toEqual([]);
  });
});

describe("startFastBuild: the conductor is kicked as soon as the run is active", () => {
  it("sends the tick right after the active write, before the connector row is written, and returns only once both are done", async () => {
    const connector = deferred<void>();
    const ensureGithubConnector = vi.fn(async () => {
      events.push("connector:start");
      await connector.promise;
      events.push("connector");
    });
    const requestTick = vi.fn(async () => {
      events.push("tick");
    });
    let settled = false;
    const run = startFastBuild(ctx(), deps({ ensureGithubConnector, requestTick })).then((r) => {
      settled = true;
      return r;
    });
    await flush(20);
    expect(requestTick).toHaveBeenCalledWith("run-1");
    expect(events.indexOf("tick")).toBeGreaterThan(events.indexOf("active"));
    expect(events).not.toContain("connector");
    expect(settled).toBe(false);
    connector.resolve();
    const r = await run;
    expect(r.kind).toBe("started");
    expect(ensureGithubConnector).toHaveBeenCalledWith(T1, expect.stringMatching(/^praxis-built\//), "main");
    expect(requestTick).toHaveBeenCalledTimes(1);
  });

  it("a failed tick request never fails the build or skips the connector row", async () => {
    const requestTick = vi.fn(async () => {
      throw new Error("inngest down");
    });
    const ensureGithubConnector = vi.fn(async () => undefined);
    const r = await startFastBuild(ctx(), deps({ requestTick, ensureGithubConnector }));
    expect(r.kind).toBe("started");
    expect(ensureGithubConnector).toHaveBeenCalledTimes(1);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("never kicks a run whose setup failed or whose active write was refused", async () => {
    const requestTick = vi.fn(async () => undefined);
    repo.failCreate = true;
    expect((await startFastBuild(ctx(), deps({ requestTick }))).kind).toBe("setup_failed");
    repo.failCreate = false;
    store = fakeStore();
    const stopped = Object.assign(new Error("stopped"), { name: "RunNoLongerProvisioning" });
    await expect(
      startFastBuild(ctx(), deps({ requestTick, updateConductorRunStatus: async () => { throw stopped; } })),
    ).rejects.toBe(stopped);
    store = fakeStore();
    expect(
      (await startFastBuild(ctx(), deps({ requestTick, updateConductorRunStatus: async () => { throw new Error("db down"); } }))).kind,
    ).toBe("setup_failed");
    expect(requestTick).not.toHaveBeenCalled();
  });
});

describe("startFastBuild: seed reuse and timing", () => {
  it("seeds the branch the repo reported, so the seed does not look the repo up again", async () => {
    repo.ensureRepo = async (name: string) => ({ full_name: `praxis-built/${name}`, default_branch: "trunk", repo_url: `https://github.com/praxis-built/${name}` });
    const seedOpts: unknown[] = [];
    repo.seed = (async (_t: string, _r: string, _f: Record<string, string>, opts?: unknown) => {
      seedOpts.push(opts);
      return "a".repeat(40);
    }) as FakeRepo["seed"];
    const r = await startFastBuild(ctx(), deps());
    expect(r.kind).toBe("started");
    expect(seedOpts).toEqual([{ default_branch: "trunk" }]);
  });

  it("reports how long the brief, the repo and the seed took", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ensureRepo = repo.ensureRepo.bind(repo);
    repo.ensureRepo = async (name: string) => {
      await wait(30);
      return ensureRepo(name);
    };
    repo.seed = async () => {
      await wait(40);
      return "a".repeat(40);
    };
    const r = await startFastBuild(
      ctx(),
      deps({
        designBrief: async () => {
          await wait(60);
          return { brief: null, reason: "x" };
        },
      }),
    );
    expect(r.kind).toBe("started");
    if (r.kind !== "started") return;
    expect(r.timing?.brief_ms).toBeGreaterThanOrEqual(55);
    expect(r.timing?.repo_ms).toBeGreaterThanOrEqual(25);
    expect(r.timing?.repo_ms).toBeLessThan(55);
    expect(r.timing?.seed_ms).toBeGreaterThanOrEqual(35);
  });
});
