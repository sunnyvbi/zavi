import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runsResult: vi.fn(),
  lastCalls: [] as Array<[string, unknown[]]>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      mocks.lastCalls.push(["from", [table]]);
      const api: Record<string, unknown> = {};
      const record =
        (name: string) =>
        (...args: unknown[]) => {
          mocks.lastCalls.push([name, args]);
          return api;
        };
      for (const m of ["select", "in", "eq"]) api[m] = record(m);
      api.or = (...args: unknown[]) => {
        mocks.lastCalls.push(["or", args]);
        return Promise.resolve(mocks.runsResult());
      };
      return api;
    },
  }),
}));

import {
  scrubBuildSessionBindingsPure,
  scrubForeignBuildSessions,
} from "../scrubBuildSessionBindings";
import { NON_REFINE_BUILD_FILTER } from "@/services/autopilot/build-liveness";

const MINE = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";

function buildTab(sessionId: string | null | undefined) {
  return { id: "tab-build", payload: { kind: "build", sessionId } };
}

describe("scrubBuildSessionBindingsPure", () => {
  it("nulls a build session from another workspace but keeps the tab", () => {
    const tabs = [buildTab(FOREIGN)];
    const [out] = scrubBuildSessionBindingsPure(tabs, new Set([MINE]));
    expect(out.payload.sessionId).toBeNull();
    expect(out.payload.kind).toBe("build");
    expect(out.id).toBe("tab-build");
  });

  it("keeps a session that belongs to the active workspace", () => {
    const tabs = [buildTab(MINE)];
    const out = scrubBuildSessionBindingsPure(tabs, new Set([MINE]));
    expect(out[0].payload.sessionId).toBe(MINE);
    expect(out[0]).toBe(tabs[0]);
  });

  it("leaves a fresh build tab untouched", () => {
    const tabs = [buildTab(null), buildTab(undefined), buildTab("")];
    const out = scrubBuildSessionBindingsPure(tabs, new Set());
    expect(out[0]).toBe(tabs[0]);
    expect(out[1]).toBe(tabs[1]);
    expect(out[2]).toBe(tabs[2]);
  });

  it("never touches a non-build tab carrying a sessionId-shaped payload", () => {
    const agent = { id: "a", payload: { kind: "agent", sessionId: FOREIGN } };
    const out = scrubBuildSessionBindingsPure([agent], new Set());
    expect(out[0]).toBe(agent);
    expect(out[0].payload.sessionId).toBe(FOREIGN);
  });

  it("handles a null payload defensively", () => {
    const weird = { id: "x", payload: null };
    const out = scrubBuildSessionBindingsPure([weird], new Set());
    expect(out[0]).toBe(weird);
  });
});

describe("scrubForeignBuildSessions", () => {
  beforeEach(() => {
    mocks.runsResult.mockReset();
    mocks.lastCalls.length = 0;
  });

  it("asks conductor_runs with the SAME predicate build-status 404s on", async () => {
    mocks.runsResult.mockReturnValue({ data: [{ id: MINE }], error: null });
    await scrubForeignBuildSessions([buildTab(MINE), buildTab(FOREIGN)], TENANT);
    const calls = Object.fromEntries(
      mocks.lastCalls.map(([name, args]) => [name, args]),
    );
    expect(mocks.lastCalls[0]).toEqual(["from", ["conductor_runs"]]);
    expect(calls.in).toEqual(["id", [MINE, FOREIGN]]);
    expect(mocks.lastCalls.filter(([n]) => n === "eq")).toEqual([
      ["eq", ["tenant_id", TENANT]],
      ["eq", ["kind", "build_app"]],
    ]);
    expect(calls.or).toEqual([NON_REFINE_BUILD_FILTER]);
  });

  it("scrubs the id the active tenant cannot read (the cross-workspace restore)", async () => {
    mocks.runsResult.mockReturnValue({ data: [], error: null });
    const out = await scrubForeignBuildSessions([buildTab(FOREIGN)], TENANT);
    expect(out[0].payload.sessionId).toBeNull();
  });

  it("fails OPEN on a query error rather than blanking every build tab", async () => {
    mocks.runsResult.mockReturnValue({ data: null, error: { message: "boom" } });
    const tabs = [buildTab(MINE)];
    const out = await scrubForeignBuildSessions(tabs, TENANT);
    expect(out[0]).toBe(tabs[0]);
    expect(out[0].payload.sessionId).toBe(MINE);
  });

  it("does not query at all when no build tab carries a session", async () => {
    const tabs = [buildTab(null), { id: "h", payload: { kind: "home" } }];
    const out = await scrubForeignBuildSessions(tabs, TENANT);
    expect(mocks.lastCalls).toEqual([]);
    expect(out).toBe(tabs);
  });

  it("skips the query when there is no active tenant", async () => {
    const tabs = [buildTab(FOREIGN)];
    const out = await scrubForeignBuildSessions(tabs, "");
    expect(mocks.lastCalls).toEqual([]);
    expect(out).toBe(tabs);
  });

  it("keeps a malformed session id out of the uuid filter so it cannot poison the whole scrub", async () => {
    mocks.runsResult.mockReturnValue({ data: [{ id: MINE }], error: null });
    const out = await scrubForeignBuildSessions(
      [buildTab("not-a-uuid"), buildTab(MINE), buildTab(FOREIGN)],
      TENANT,
    );
    const inCall = mocks.lastCalls.find(([n]) => n === "in");
    expect(inCall?.[1]).toEqual(["id", [MINE, FOREIGN]]);
    expect(out[0].payload.sessionId).toBeNull();
    expect(out[1].payload.sessionId).toBe(MINE);
    expect(out[2].payload.sessionId).toBeNull();
  });

  it("scrubs a lone malformed session id without a query", async () => {
    const out = await scrubForeignBuildSessions([buildTab("not-a-uuid")], TENANT);
    expect(mocks.lastCalls).toEqual([]);
    expect(out[0].payload.sessionId).toBeNull();
  });

  it("dedupes repeated session ids into one id filter", async () => {
    mocks.runsResult.mockReturnValue({ data: [], error: null });
    await scrubForeignBuildSessions(
      [buildTab(FOREIGN), buildTab(FOREIGN)],
      TENANT,
    );
    const inCall = mocks.lastCalls.find(([n]) => n === "in");
    expect(inCall?.[1]).toEqual(["id", [FOREIGN]]);
  });
});
