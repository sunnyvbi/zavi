import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConductorNode } from "@/services/agents/conductor";
import type { FastBuildContext, SiteRow } from "@/services/sites/contract";
import type { FastBuildDeps } from "@/services/agents/fast-build";
import {
  fakeRepo,
  fakeStore,
  fakeSupabase,
  STARTER,
  type FakeStore,
} from "@/services/sites/__tests__/site-fakes";
import { siteLabel } from "@/services/sites/label";

const NEEDS_DEDICATED = { files: { "package.json": "{}" }, manifest_json: '{"schemaVersion":1,"capabilities":["payments"]}' };

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  writes: [] as { op: string; values: Record<string, unknown> }[],
  keepsOwnRepo: true as boolean | "throw",
  wired: [] as Array<Partial<FastBuildDeps>>,
}));

vi.mock("@/services/supabase", () => {
  function from(table: string) {
    if (table !== "connector_metadata") throw new Error(`unexpected table ${table}`);
    const filters: [string, unknown][] = [];
    const preds: ((r: Row) => boolean)[] = [];
    let pending: Row | null = null;
    const match = () => h.rows.filter((r) => filters.every(([k, v]) => r[k] === v) && preds.every((p) => p(r)));
    const applyUpdate = () => {
      h.writes.push({ op: "update", values: pending as Row });
      const hit = match();
      for (const r of hit) Object.assign(r, pending);
      return hit;
    };
    const q = {
      select: () => {
        if (pending) return { then: (resolve: (v: unknown) => void) => resolve({ data: applyUpdate(), error: null }) };
        return q;
      },
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return q;
      },
      is: (k: string, v: null) => {
        preds.push((r) => (r[k] ?? null) === v);
        return q;
      },
      filter: (k: string, _op: string, lit: string) => {
        preds.push((r) => Array.isArray(r[k]) && `{${(r[k] as string[]).map((x) => `"${x}"`).join(",")}}` === lit);
        return q;
      },
      maybeSingle: async () => ({ data: match()[0] ? { ...match()[0] } : null, error: null }),
      update: (values: Row) => {
        pending = values;
        return q;
      },
      upsert: async (values: Row) => {
        h.writes.push({ op: "upsert", values });
        h.rows.push({ ...values });
        return { error: null };
      },
      then: (resolve: (v: { error: null }) => void) => {
        if (pending) applyUpdate();
        resolve({ error: null });
      },
    };
    return q;
  }
  return { serviceClient: () => ({ from }) };
});

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string) => {
      if (key === "build_repo_follows_app") return true;
      if (key === "build_site_keeps_own_repo") {
        if (h.keepsOwnRepo === "throw") throw new Error("settings down");
        return h.keepsOwnRepo;
      }
      if (key === "build_auto_site_owner") return true;
      throw new Error(`unexpected setting ${key}`);
    }),
  };
});

vi.mock("@/services/agents/fast-build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/fast-build")>();
  return {
    ...actual,
    startFastBuild: vi.fn(async (_ctx: FastBuildContext, deps: Partial<FastBuildDeps>) => {
      h.wired.push(deps);
      return { kind: "setup_failed", reason: "captured", retryable: true };
    }),
  };
});

import { realStartProductBuildDeps } from "@/services/agents/start-product-build";

const T = "693dfbdb-0000-4000-8000-000000000000";

async function realWiredConnector(): Promise<NonNullable<FastBuildDeps["ensureGithubConnector"]>> {
  h.wired = [];
  await realStartProductBuildDeps.startFastBuild!({
    tenant_id: T,
    conductor_run_id: "probe",
    company_name: "Apna Tutor",
    idea: "probe",
    max_usd: 1,
    started_by_user_id: null,
    owner_email: null,
    first_build_free: false,
  });
  const fn = h.wired[0]?.ensureGithubConnector;
  if (!fn) throw new Error("the real wiring passed no ensureGithubConnector");
  return fn;
}

function namedStore(): FakeStore {
  const store = fakeStore();
  const base = store.getOrCreateForRun.bind(store);
  store.getOrCreateForRun = async (input) => {
    const row = await base(input);
    const label = siteLabel(input.company_name, input.tenant_id, row.id, input.site_name ?? null);
    const named: SiteRow = { ...row, label, hostname: `${label}.zaviagent.com`, name: input.site_name ?? null };
    store.sites.set(row.id, named);
    return { ...named };
  };
  return store;
}

function ctx(run: string, site_name: string): FastBuildContext {
  return {
    tenant_id: T,
    conductor_run_id: run,
    company_name: "Apna Tutor",
    site_name,
    idea: `A site for ${site_name}`,
    max_usd: 50,
    started_by_user_id: "u1",
    owner_email: null,
    first_build_free: false,
  };
}

async function buildTwoSites() {
  const { startFastBuild } = await vi.importActual<typeof import("@/services/agents/fast-build")>("@/services/agents/fast-build");
  const ensureGithubConnector = await realWiredConnector();
  const store = namedStore();
  const repo = fakeRepo();
  const sb = fakeSupabase(store);
  const graphs: Array<{ goal_graph: ConductorNode[] }> = [];
  const deps = (): Partial<FastBuildDeps> => ({
    store,
    repo,
    supabase: sb,
    starter: { starterFiles: () => STARTER },
    publisher: {} as never,
    deployHandler: {} as never,
    pooled: {
      enabledFor: async () => true,
      starter: async () => ({ starterFiles: () => NEEDS_DEDICATED }),
      initStatic: async () => undefined,
    },
    updateConductorRunStatus: async (p) => {
      graphs.push(p);
    },
    designBrief: async () => ({ brief: null, reason: "test_default" }),
    designStore: null,
    ensureGithubConnector,
  });
  const first = await startFastBuild(ctx("run-paws", "Paws and Suds"), deps());
  expect(first.kind).toBe("started");
  const siteA = [...store.sites.values()][0];
  const before = { ...siteA };
  const connectorAfterFirst = { ...h.rows[0] };
  const second = await startFastBuild(ctx("run-yoga", "Still Water Yoga"), deps());
  expect(second.kind).toBe("started");
  const siteB = [...store.sites.values()].find((s) => s.id !== siteA.id)!;
  return { store, sb, repo, before, siteA: store.sites.get(siteA.id)!, siteB, connectorAfterFirst, graphs };
}

beforeEach(() => {
  h.rows = [];
  h.writes = [];
  h.keepsOwnRepo = true;
});

describe("DEL-1323 B6/B33: building a second site leaves the first one alone", () => {
  it("the first site's repo, label, hostname and the workspace default repo are untouched by the second build", async () => {
    const { before, siteA, siteB, connectorAfterFirst, graphs } = await buildTwoSites();

    expect(siteA).toEqual(before);
    expect(siteA.label).toBe(siteLabel("Apna Tutor", T, siteA.id, "Paws and Suds"));
    expect(siteA.label.startsWith("paws-and-suds-")).toBe(true);
    expect(siteA.github_full_name).toBe(`praxis-built/${siteA.label}`);
    expect(siteB.label.startsWith("still-water-yoga-")).toBe(true);
    expect(siteB.github_full_name).toBe(`praxis-built/${siteB.label}`);
    expect(siteA.label).not.toContain("apna-tutor");

    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].default_repo_full_name).toBe(siteA.github_full_name);
    expect(h.rows[0].default_repo_full_name).toBe(connectorAfterFirst.default_repo_full_name);
    expect(h.rows[0].repo_full_names).toEqual([siteA.github_full_name, siteB.github_full_name]);
    expect(h.rows[0].repo_default_branches).toEqual({
      [siteA.github_full_name as string]: "main",
      [siteB.github_full_name as string]: "main",
    });
    expect(h.writes.map((w) => w.op)).toEqual(["upsert", "update"]);

    const buildNode = graphs[1].goal_graph.find((n) => (n.payload as { stage?: string }).stage === "build")!;
    expect((buildNode.payload as { company_name?: string }).company_name).toBe("Still Water Yoga");
  });

  it("with build_site_keeps_own_repo off, the second site takes over the workspace repo as before", async () => {
    h.keepsOwnRepo = false;
    const { siteB } = await buildTwoSites();
    expect(h.rows[0].default_repo_full_name).toBe(siteB.github_full_name);
    expect(h.rows[0].repo_full_names).toEqual([siteB.github_full_name]);
  });

  it("an unreadable setting keeps each site's own repo (the key's default)", async () => {
    h.keepsOwnRepo = "throw";
    const { siteA } = await buildTwoSites();
    expect(h.rows[0].default_repo_full_name).toBe(siteA.github_full_name);
  });
});

describe("DEL-1323 B1/B5: a second site never replaces the first and gets its own database", () => {
  it("site 2 gets a fresh Supabase project and repo while site 1 keeps its database, repo and record, and still resolves for edits", async () => {
    const { store, sb, repo, before, siteA, siteB } = await buildTwoSites();

    expect(siteB.id).not.toBe(siteA.id);
    expect(siteA).toEqual(before);

    expect(sb.calls.filter((c) => c === `ensure:${siteA.id}`)).toHaveLength(1);
    expect(sb.calls.filter((c) => c === `ensure:${siteB.id}`)).toHaveLength(1);
    const afterSecondStarted = sb.calls.slice(sb.calls.indexOf(`ensure:${siteB.id}`));
    expect(afterSecondStarted.some((c) => c.includes(siteA.id))).toBe(false);
    expect(sb.calls.some((c) => c.startsWith("teardown:") || c.startsWith("purge:"))).toBe(false);

    expect(sb.projects.get(siteA.id)).toBeTruthy();
    expect(sb.projects.get(siteB.id)).toBeTruthy();
    expect(sb.projects.get(siteB.id)).not.toBe(sb.projects.get(siteA.id));
    expect(store.providers.get(`${siteA.id}:supabase_project`)).toMatchObject({ state: "created" });
    expect(store.providers.get(`${siteB.id}:supabase_project`)).toMatchObject({ state: "created" });

    expect(siteB.github_full_name).not.toBe(siteA.github_full_name);
    expect(repo.repos.has(siteA.github_full_name!)).toBe(true);
    expect(repo.repos.has(siteB.github_full_name!)).toBe(true);
    expect(repo.deleted).toEqual([]);

    const forEdits = await store.getByRun(T, "run-paws");
    expect(forEdits?.id).toBe(siteA.id);
    expect(forEdits?.github_full_name).toBe(siteA.github_full_name);
    expect(forEdits?.hostname).toBe(siteA.hostname);
    expect((await store.getByRun(T, "run-yoga"))?.id).toBe(siteB.id);
  });
});
