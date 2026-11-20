import { describe, it, expect, vi } from "vitest";
import { loadSignupActivity, renderSignupFollowup, sendSignupFollowup, type SignupActivity } from "../signup-followup";

type Row = Record<string, unknown>;

function fakeClient(tables: Record<string, Row[]>, failing: string[] = []) {
  const builder = (table: string) => {
    const rows = tables[table] ?? [];
    const error = failing.includes(table) ? { message: "boom" } : null;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: error ? null : (rows[0] ?? null), error });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: error ? null : rows, error });
    return b;
  };
  return {
    from: builder,
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "f@acme.com" } } }) } },
  };
}

const TENANT = { id: "t1", slug: "acme", display_name: "Acme", created_at: "2026-09-28T21:00:00Z", kind: "real", deleted_at: null };

describe("loadSignupActivity", () => {
  it("counts what the founder did", async () => {
    const a = await loadSignupActivity(
      fakeClient({
        tenants: [TENANT],
        agent_thread_messages: [{ created_at: "2026-09-29T10:00:00Z" }, { created_at: "2026-09-29T09:00:00Z" }],
        agent_runs: [
          { agent_slug: "cgo", status: "success", actor_user_id: "u1", enqueued_at: "2026-09-29T11:00:00Z" },
          { agent_slug: "cgo", status: "dispatch_error", actor_user_id: "u1", enqueued_at: "2026-09-29T08:00:00Z" },
          { agent_slug: "seo-geo", status: "success", actor_user_id: "u1", enqueued_at: "2026-09-29T07:00:00Z" },
        ],
        tenant_credit_ledger: [
          { amount: 100, debited: null },
          { amount: 900, debited: "0.4" },
          { amount: 20, debited: 20 },
        ],
        connector_metadata: [{ slug: "slack" }],
        tenant_app_setting: [
          { key: "founder_alerts_sent", value: { first_chat_message: "x", "out_of_credits:2026-09-29": "y", junk: 1 } },
        ],
      }),
      TENANT,
      "u1",
    );
    expect(a).toMatchObject({
      name: "Acme",
      owner_email: "f@acme.com",
      chats: 2,
      runs: [
        { agent: "cgo", total: 2, failed: 1 },
        { agent: "seo-geo", total: 1, failed: 0 },
      ],
      credits_spent: 120,
      connectors: ["slack"],
      milestones: ["First chat message", "Ran out of credits"],
      last_seen: "2026-09-29T11:00:00Z",
    });
  });

  it("skips test, dogfood and deleted tenants", async () => {
    for (const t of [{ ...TENANT, kind: "test" }, { ...TENANT, slug: "upcar-ai" }, { ...TENANT, deleted_at: "2026-09-29" }]) {
      expect(await loadSignupActivity(fakeClient({}), t, null)).toBeNull();
    }
  });

  it("throws on a read error instead of reporting zero activity", async () => {
    await expect(
      loadSignupActivity(fakeClient({}, ["agent_runs"]), TENANT, null),
    ).rejects.toThrow(/runs read failed/);
  });
});

describe("renderSignupFollowup", () => {
  const idle: SignupActivity = {
    tenant_id: "t1",
    name: "Gane",
    owner_email: "x@gmail.com",
    created_at: "2026-09-28T21:00:00Z",
    chats: 0,
    runs: [],
    credits_spent: 0,
    connectors: [],
    milestones: [],
    last_seen: null,
  };

  it("says no activity plainly", () => {
    const { subject, text } = renderSignupFollowup(idle);
    expect(subject).toBe("Gane, 24h later: no activity (x@gmail.com)");
    expect(text).toContain("has done nothing since signing up");
    expect(text).toMatch(/Last seen\s+never/);
  });

  it("summarises activity", () => {
    const { subject, text } = renderSignupFollowup({
      ...idle,
      chats: 3,
      runs: [{ agent: "cgo", total: 2, failed: 1 }],
      connectors: [],
    });
    expect(subject).toBe("Gane, 24h later: 3 chats, 2 runs, no connectors (x@gmail.com)");
    expect(text).toContain("2: cgo ×2 (1 failed)");
  });
});

describe("sendSignupFollowup", () => {
  it("does nothing when founder alerts are muted", async () => {
    const sgSend = vi.fn();
    const out = await sendSignupFollowup(TENANT, "u1", {
      sgSend,
      serviceClient: () => fakeClient({ tenants: [TENANT] }),
      alertsEnabled: async () => false,
    });
    expect(out).toEqual({ sent: false, reason: "muted" });
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("sends for a real tenant", async () => {
    const sgSend = vi.fn(async () => {});
    const out = await sendSignupFollowup(TENANT, "u1", {
      sgSend,
      serviceClient: () => fakeClient({ tenants: [TENANT] }),
      alertsEnabled: async () => true,
    });
    expect(out).toEqual({ sent: true });
    expect(sgSend).toHaveBeenCalledTimes(1);
  });
});
