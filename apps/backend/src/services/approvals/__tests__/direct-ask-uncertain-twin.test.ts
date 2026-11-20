import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; channel_slug: string; exec_class: string | null; exec_status: string | null; status: string; title: string; exec_result: Record<string, unknown> | null };
const db = { rows: [] as Row[] };

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => ({ data: db.rows.find((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null }),
        then: (res: (x: { data: unknown[] }) => unknown) =>
          res({ data: table === "channel_action_events" ? [] : db.rows.filter((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v)) }),
      };
      return q;
    },
  }),
}));

import { directAskOutcome, directAskOutcomeLine } from "../envelope-door";

const CREATE = "chatgpt_ads.create_and_launch";
const T = "tenant-1";
const row = (over: Partial<Row>): Row => ({ id: "x", channel_slug: "chatgpt_ads", exec_class: CREATE, exec_status: null, status: "pending", title: "Create and launch Renters 1-Day", exec_result: null, ...over });

beforeEach(() => {
  db.rows = [];
});

describe("direct ask beside an uncertain create", () => {
  it("the kept older card (failed, partial) is never 'approved', and the line names it", async () => {
    db.rows = [row({ id: "old", exec_status: "failed", exec_result: { code: "exec_partial", bucket: "partial_risk" } })];
    const o = await directAskOutcome(T, "old");
    expect(o.approved).toBe(false);
    expect(o.uncertain).toEqual({ id: "old", title: "Create and launch Renters 1-Day" });
    const line = directAskOutcomeLine(o, "ChatGPT");
    expect(line).toContain("may have partly gone through");
    expect(line).toContain("did not start another one");
    expect(line).toContain("'Create and launch Renters 1-Day'");
  });

  it("a new card whose supersede refused beside an uncertain one says the same", async () => {
    db.rows = [
      row({ id: "new", title: "Create and launch Spring" }),
      row({ id: "old", exec_status: "failed", exec_result: { code: "exec_outcome_unknown" } }),
    ];
    const o = await directAskOutcome(T, "new");
    expect(o.uncertain?.id).toBe("old");
    expect(directAskOutcomeLine(o, "ChatGPT")).toContain("may have partly gone through");
  });

  it("a launch Zavi archived (chatgpt_ads_launch_undone) blocks nothing", async () => {
    db.rows = [
      row({ id: "new", exec_status: "queued" }),
      row({ id: "old", status: "stale", exec_status: "failed", exec_result: { code: "chatgpt_ads_launch_undone", bucket: "blocked_on_us" } }),
    ];
    const o = await directAskOutcome(T, "new");
    expect(o.uncertain).toBeNull();
    expect(o.approved).toBe(true);
    expect(directAskOutcomeLine(o, "ChatGPT")).toBeNull();
  });

  it("an interrupted or lease-expired open create counts as uncertain too", async () => {
    for (const exec_result of [{ interrupted: true }, { lease_expired: true }]) {
      db.rows = [row({ id: "new" }), row({ id: "old", exec_status: "failed", exec_result })];
      expect((await directAskOutcome(T, "new")).uncertain?.id).toBe("old");
    }
  });
});
