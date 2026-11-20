import { describe, it, expect, vi, beforeEach } from "vitest";

const slackFetch = vi.fn();
const tables: Record<string, Record<string, unknown> | null> = {};
const filters: Array<{ table: string; col: string; v: unknown }> = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(),
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, v: unknown) => {
        filters.push({ table, col, v });
        return q;
      };
      q.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
      return q;
    },
  }),
}));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: (...a: unknown[]) => slackFetch(...a) }));
vi.mock("@/services/slack/resolve-zavi-channel", () => ({ resolveZaviChannel: vi.fn(async () => "C_ZAVI") }));

import { refreshApprovalCard } from "../approval-post-target";

const MOVED = "2099-03-04T17:00:00Z";

beforeEach(() => {
  slackFetch.mockReset().mockResolvedValue({ ok: true });
  filters.length = 0;
  tables.dispatch_notice_refs = { slack_channel_id: "C1", slack_ts: "1752.100", slack_team_id: "T1" };
  tables.decisions = {
    id: "d1",
    decision_class: "social.publish.v2",
    status: "proposed",
    body: { channel: "x", payload: { text: "Stop reconciling payouts weekly." }, scheduled_at: MOVED },
  };
  tables.decision_classes = { click_allowlistable: false, dispatch_handler: "social.publish.v2" };
});

describe("refreshApprovalCard", () => {
  it("re-renders the posted card with the new time via chat.update on the tenant's connection", async () => {
    expect(await refreshApprovalCard({ tenant_id: "t1", decision_id: "d1" })).toBe(true);
    expect(slackFetch).toHaveBeenCalledTimes(1);
    const [tid, method, args, team] = slackFetch.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect([tid, method, team]).toEqual(["t1", "chat.update", "T1"]);
    expect(args).toMatchObject({ channel: "C1", ts: "1752.100" });
    expect(typeof args.blocks).toBe("string");
    expect(args.blocks as string).toContain(MOVED);
    expect(filters).toContainEqual({ table: "decisions", col: "tenant_id", v: "t1" });
  });

  it("a Slack failure is tolerated: false, never a throw", async () => {
    slackFetch.mockRejectedValueOnce(new Error("slack down"));
    await expect(refreshApprovalCard({ tenant_id: "t1", decision_id: "d1" })).resolves.toBe(false);
    slackFetch.mockResolvedValueOnce({ ok: false, error: "message_not_found" });
    await expect(refreshApprovalCard({ tenant_id: "t1", decision_id: "d1" })).resolves.toBe(false);
  });

  it("does nothing without a posted card, or once the decision is decided", async () => {
    tables.dispatch_notice_refs = null;
    expect(await refreshApprovalCard({ tenant_id: "t1", decision_id: "d1" })).toBe(false);
    tables.dispatch_notice_refs = { slack_channel_id: "C1", slack_ts: "1752.100", slack_team_id: null };
    tables.decisions = { ...(tables.decisions as Record<string, unknown>), status: "approved" };
    expect(await refreshApprovalCard({ tenant_id: "t1", decision_id: "d1" })).toBe(false);
    expect(slackFetch).not.toHaveBeenCalled();
  });
});
