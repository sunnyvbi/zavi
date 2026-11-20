import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rows: new Map<string, { enabled: boolean }>(), fail: false, queries: [] as string[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => {
        const eqs: Record<string, string> = {};
        const q = {
          eq: (col: string, val: string) => {
            eqs[col] = val;
            return q;
          },
          maybeSingle: async () => {
            m.queries.push(`${table}:${eqs.platform}`);
            if (m.fail) return { data: null, error: { message: "boom" } };
            return { data: m.rows.get(eqs.platform) ?? null, error: null };
          },
        };
        return q;
      },
    }),
  }),
}));
import { evaluateUnattended, isExecutableAdClass, adDirection, loadUnattendedFacts } from "../unattended-policy";
import { loadLinkedinPauseUnattended } from "../linkedin-unattended";

const action = { kind: "ad" as const, exec_class: "linkedin_ads.set_status", payload: { campaign_id: "1", account_id: "2", name: "c", status: "PAUSED" }, source: { table: "channel_actions" as const, id: "a", run_id: null } };

beforeEach(() => {
  m.rows.clear();
  m.fail = false;
  m.queries.length = 0;
});

describe("LinkedIn auto-pause opt-in", () => {
  it("a LinkedIn pause waits for a person when only Meta opted in", async () => {
    m.rows.set("meta_ads", { enabled: true });
    const facts = await loadUnattendedFacts("t1", action);
    expect(m.queries).toEqual(["tenant_ads_write_caps:linkedin_ads"]);
    const v = evaluateUnattended(action, facts);
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toEqual(["linkedin_autopause_off"]);
  });
  it("runs unattended once the linkedin_ads row is enabled", async () => {
    m.rows.set("linkedin_ads", { enabled: true });
    expect(evaluateUnattended(action, await loadUnattendedFacts("t1", action))).toEqual({ verdict: "allow", reasons: [] });
  });
  it("a disabled row, and an unreadable table, both wait for a person", async () => {
    m.rows.set("linkedin_ads", { enabled: false });
    expect(evaluateUnattended(action, await loadUnattendedFacts("t1", action)).reasons).toEqual(["linkedin_autopause_off"]);
    m.fail = true;
    expect(await loadLinkedinPauseUnattended("t1")).toEqual({ autoPause: null });
    expect(evaluateUnattended(action, { linkedinPause: { autoPause: null } }).reasons).toEqual(["linkedin_autopause_unreadable"]);
    expect(evaluateUnattended(action, {}).verdict).toBe("ask_founder");
  });
  it("the pause class is routed through the ad door as a spend-down change", () => {
    expect(isExecutableAdClass("linkedin_ads.set_status")).toBe(true);
    expect(adDirection("linkedin_ads.set_status", action.payload)).toBe("down");
  });
});
