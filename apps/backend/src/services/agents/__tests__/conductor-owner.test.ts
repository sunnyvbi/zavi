import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ ownerOnly: true, settingReads: 0, queries: 0, conductors: [] as unknown[], error: null as { message: string } | null }));

vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => {
    h.settingReads += 1;
    return h.ownerOnly;
  },
}));

import { APP_SETTINGS } from "@/services/settings/registry";
import {
  conductorOwnerOf,
  conductorOwnerOnlyEnabled,
  dropForeignRuns,
  isOtherWorkersOwner,
  ownerOnlyMayApply,
  stampConductorOwner,
} from "../conductor-owner";

const svc = {
  from: () => {
    h.queries += 1;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.in = () => Promise.resolve({ data: h.conductors, error: h.error });
    return q;
  },
} as never;

const node = (payload: Record<string, unknown> | undefined) => ({ id: "n", payload });

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
  h.ownerOnly = true;
  h.settingReads = 0;
  h.queries = 0;
  h.error = null;
  h.conductors = [{ id: "c-active", status: "active", goal_graph: [{ id: "n", payload: { owner_worker: "canonical" } }] }];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stampConductorOwner", () => {
  it("stamps node 0 only, without mutating the input", () => {
    const g = [node({ stage: "build" }), node({ stage: "deploy" })];
    const out = stampConductorOwner(g);
    expect(out[0].payload).toEqual({ stage: "build", owner_worker: "canonical" });
    expect(out[1]).toBe(g[1]);
    expect(g[0].payload).toEqual({ stage: "build" });
  });

  it("keeps an existing owner unless asked to replace it", () => {
    const g = [node({ owner_worker: "dev:a" })];
    expect(conductorOwnerOf(stampConductorOwner(g))).toBe("dev:a");
    expect(conductorOwnerOf(stampConductorOwner(g, { replace: true }))).toBe("canonical");
  });

  it("copes with an empty graph and a node with no payload", () => {
    expect(stampConductorOwner([])).toEqual([]);
    expect(conductorOwnerOf(stampConductorOwner([node(undefined)]))).toBe("canonical");
  });
});

describe("isOtherWorkersOwner", () => {
  it("is false for an unstamped run and for the same worker", () => {
    expect(isOtherWorkersOwner(null)).toBe(false);
    expect(isOtherWorkersOwner("")).toBe(false);
    expect(isOtherWorkersOwner("canonical")).toBe(false);
    expect(isOtherWorkersOwner("dev:unknown")).toBe(true);
  });
});

describe("dropForeignRuns (a local dev backend)", () => {
  beforeEach(() => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
    vi.stubEnv("HOSTNAME", "laptop");
    h.conductors = [{ id: "c-active", status: "active", goal_graph: [{ id: "n", payload: { owner_worker: "dev:laptop" } }] }];
  });

  it("drops a run whose own worker or whose build's owner is another server", async () => {
    h.conductors = [{ id: "c-prod", status: "active", goal_graph: [{ id: "n", payload: { owner_worker: "canonical" } }] }];
    const rows = [{ id: "a", worker_id: "canonical" }, { id: "b", conductor_run_id: "c-prod" }, { id: "c", worker_id: "dev:laptop" }];
    expect((await dropForeignRuns(svc, rows)).map((r) => r.id)).toEqual(["c"]);
  });

  it("does not read the setting or the database for rows that carry no ownership signal", async () => {
    const rows = [{ id: "a" }, { id: "b", worker_id: null }];
    expect(await dropForeignRuns(svc, rows)).toEqual(rows);
    expect(h.settingReads).toBe(0);
    expect(h.queries).toBe(0);
  });

  it("fails closed for a conductor child when the conductor lookup errors", async () => {
    h.error = { message: "down" };
    const rows = [{ id: "a", conductor_run_id: "c-active" }, { id: "b" }];
    expect((await dropForeignRuns(svc, rows)).map((r) => r.id)).toEqual(["b"]);
  });

  it("with requireActiveConductor a child of a conductor row that is missing is dropped", async () => {
    const rows = [{ id: "a", conductor_run_id: "c-gone" }, { id: "b", conductor_run_id: "c-active" }];
    expect((await dropForeignRuns(svc, rows, { requireActiveConductor: true })).map((r) => r.id)).toEqual(["b"]);
    expect((await dropForeignRuns(svc, rows)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns every row untouched when conductor_owner_only is off", async () => {
    h.ownerOnly = false;
    const rows = [{ id: "a", worker_id: "dev:x" }];
    expect(await dropForeignRuns(svc, rows)).toEqual(rows);
    expect(h.queries).toBe(0);
  });
});

describe("a deployed server always advances every build", () => {
  it.each([
    ["prod / development container", { PRAXIS_CONTAINER_ROLE: "canonical", NODE_ENV: "production" }],
    ["canonical role alone", { PRAXIS_CONTAINER_ROLE: "canonical" }],
    ["the deploy probe", { PRAXIS_CONTAINER_ROLE: "probe" }],
    ["any NODE_ENV=production process", { NODE_ENV: "production", HOSTNAME: "box" }],
  ])("%s: owner-only never applies and the setting is never read", async (_label, env) => {
    expect(ownerOnlyMayApply(env as NodeJS.ProcessEnv)).toBe(false);
    h.ownerOnly = true;
    h.settingReads = 0;
    expect(await conductorOwnerOnlyEnabled(env as NodeJS.ProcessEnv)).toBe(false);
    expect(h.settingReads).toBe(0);
  });

  it("the canonical container keeps another server's runs and children", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    h.conductors = [{ id: "c-dev", status: "active", goal_graph: [{ id: "n", payload: { owner_worker: "dev:laptop" } }] }];
    const rows = [{ id: "a", worker_id: "dev:laptop" }, { id: "b", conductor_run_id: "c-dev" }];
    expect(await dropForeignRuns(svc, rows)).toEqual(rows);
    expect(h.settingReads).toBe(0);
    expect(h.queries).toBe(0);
  });

  it("a local dev backend applies it, and an unreadable setting keeps the laptop off other builds", async () => {
    const local = { NODE_ENV: "development", HOSTNAME: "laptop" } as NodeJS.ProcessEnv;
    expect(ownerOnlyMayApply(local)).toBe(true);
    h.ownerOnly = false;
    expect(await conductorOwnerOnlyEnabled(local)).toBe(false);
    h.ownerOnly = true;
    expect(await conductorOwnerOnlyEnabled(local)).toBe(true);
  });
});

describe("conductor_owner_only setting", () => {
  it("is a global switch that defaults ON", () => {
    expect(APP_SETTINGS.conductor_owner_only).toMatchObject({ type: "boolean", scope: "global", defaultValue: true });
  });
});
