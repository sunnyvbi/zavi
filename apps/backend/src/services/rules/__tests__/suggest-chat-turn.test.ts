import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => ({ run: null as unknown, msg: null as unknown }));
const propose = vi.hoisted(() => vi.fn());
const inserts = vi.hoisted(() => [] as unknown[]);

vi.mock("../propose", () => ({ proposeRule: (...a: unknown[]) => propose(...a) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const row = table === "agent_runs" ? rows.run : rows.msg;
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
        insert: (r: unknown) => {
          inserts.push(r);
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  }),
}));

import { suggestRuleFromChatTurn } from "../suggest";

const RULE = { rule_id: "r1", text: "never post on weekends", scope_kind: "all", scope_slug: null };

function runWith(payload: Record<string, unknown>) {
  return { id: "run1", agent_slug: "fundraising", trigger: "chat", payload: { thread_id: "th1", user_message_id: "m1", ...payload } };
}

beforeEach(() => {
  propose.mockReset();
  propose.mockResolvedValue(RULE);
  inserts.length = 0;
  rows.msg = { id: "m1", body: "From now on, never post on weekends.", sender_role: "user" };
});

describe("suggestRuleFromChatTurn", () => {
  it("offers a rule card for a founder's own 'never do X' turn", async () => {
    rows.run = runWith({});
    expect(await suggestRuleFromChatTurn("t1", "run1")).toEqual(RULE);
    expect(propose).toHaveBeenCalledOnce();
    expect(inserts).toHaveLength(1);
  });

  it("skips a turn the app wrote for the founder", async () => {
    rows.run = runWith({ message_origin: "app_action" });
    rows.msg = { id: "m1", body: "I'm raising an Angel round. Merge into my list; never replace it.", sender_role: "user" };
    expect(await suggestRuleFromChatTurn("t1", "run1")).toBeNull();
    expect(propose).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});
