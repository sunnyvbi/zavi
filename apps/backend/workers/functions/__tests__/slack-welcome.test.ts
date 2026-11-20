
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: vi.fn(),
}));
vi.mock("@/services/slack/outbox", () => ({
  enqueueSlackOutbox: vi.fn(),
}));
vi.mock("../../client", () => ({
  inngest: { createFunction: (c: unknown, t: unknown, f: unknown) => ({ c, t, f }) },
}));
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: vi.fn(async () => ({ enforced: true, agentMin: undefined, proTenants: [] })),
  resolveTenantTier: vi.fn(async () => "free"),
}));
vi.mock("@/services/agents/visibility", () => ({
  isAgentSchedulable: vi.fn(async () => true),
}));

const db = vi.hoisted(() => ({
  row: null as null | { tenant_id: string; team_id: string; team_name: string | null },
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: db.row, error: null }),
        update: (patch: Record<string, unknown>) => {
          db.updates.push(patch);
          return chain;
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === "staff_audit_log") db.audits.push(row);
          return { error: null };
        },
        then: (res: (v: { error: null }) => void) => res({ error: null }),
      };
      return chain;
    },
  }),
}));

import { slackFetch } from "@/services/tools/slack/_client";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import { resolveTenantTier } from "@/services/agents/entitlement";
import { DEFAULT_TIER_AGENT_MIN } from "@/services/billing/tiers";
import {
  installerDmText,
  sendInstallerDm,
  slackWelcomeFn,
  welcomeDmIdempotencyKey,
  welcomeTeammates,
} from "../slack-welcome";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;
const mockedEnqueue = enqueueSlackOutbox as unknown as ReturnType<typeof vi.fn>;

const T1 = "00000000-0000-0000-0000-000000000001";
const TEAM = "T123";

describe("installerDmText — installer DM copy", () => {
  it("names Zavi, says how to use it, links the dashboard, and mentions /invite", () => {
    const t = installerDmText("Acme");
    expect(t).toContain("Zavi");
    expect(t).toContain("Acme");
    expect(t).toContain("@-mention");
    expect(t).toContain("/invite @Zavi");
    expect(t).toContain("https://www.zaviagent.com/workspace");
  });

  it("works without a team name (no dangling 'to')", () => {
    expect(installerDmText()).toContain("You just connected me.");
  });

  it("contains no em-dashes (house style)", () => {
    expect(installerDmText("Acme")).not.toContain("—");
  });
});

describe("welcomeDmIdempotencyKey", () => {
  it("is stable for the same tenant+team (welcome_sent_at claim already guarantees at-most-once)", () => {
    expect(welcomeDmIdempotencyKey(T1, TEAM)).toBe(`${T1}:${TEAM}:welcome_dm`);
  });
});

describe("sendInstallerDm — opens an IM then ENQUEUES the intro onto the durable outbox (Phase B1)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedEnqueue.mockReset();
  });

  it("conversations.open with the installer id, then enqueueSlackOutbox with the intro text (no direct chat.postMessage)", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, channel: { id: "D999" } });
    mockedEnqueue.mockResolvedValueOnce(1);

    const ok = await sendInstallerDm(T1, TEAM, "Uinstaller", "Acme");
    expect(ok).toBe(true);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(T1, "conversations.open", { users: "Uinstaller" }, TEAM);

    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    const arg = mockedEnqueue.mock.calls[0][0];
    expect(arg.tenant_id).toBe(T1);
    expect(arg.team_id).toBe(TEAM);
    expect(arg.channel_id).toBe("D999");
    expect(arg.kind).toBe("welcome_dm");
    expect(arg.body).toContain("Zavi");
    expect(arg.idempotency_key).toBe(welcomeDmIdempotencyKey(T1, TEAM));
  });

  it("returns false (no enqueue) when conversations.open yields no channel id", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, channel: {} });
    const ok = await sendInstallerDm(T1, TEAM, "Uinstaller");
    expect(ok).toBe(false);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("returns false (fail-open, no throw) when the outbox enqueue itself fails", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, channel: { id: "D999" } });
    mockedEnqueue.mockResolvedValueOnce(null);

    const ok = await sendInstallerDm(T1, TEAM, "Uinstaller");
    expect(ok).toBe(false);
  });
});

describe("installer DM names only teammates the plan can run (gap 16, 2026-10-28)", () => {
  it("lists the teammates it is given and none it is not", () => {
    const t = installerDmText("Acme", ["support-lead", "ops", "research"]);
    expect(t).toContain("(support-lead, ops, research and more)");
    expect(t).not.toContain("engineer");
    expect(t).not.toContain("performance-marketer");
  });

  it("no teammates: no empty parentheses", () => {
    expect(installerDmText("Acme", [])).toContain("I work with a team of AI teammates shaped by");
  });

  const cfg = { enforced: false, agentMin: { ...DEFAULT_TIER_AGENT_MIN }, proTenants: [] as string[] };
  const show = async (_tenant: string, _slug: string) => true;

  it("welcomeTeammates keeps what the plan allows, even with the gate switch off", async () => {
    const labels = await welcomeTeammates(T1, {
      loadConfig: async () => cfg, resolveTier: async () => "free", visible: show,
    });
    expect(labels).toEqual(["support-lead", "growth-lead", "ops", "pm", "qa", "research"]);
    const starter = await welcomeTeammates(T1, {
      loadConfig: async () => cfg, resolveTier: async () => "starter", visible: show,
    });
    expect(starter).toContain("performance-marketer");
    expect(starter).not.toContain("engineer");
  });

  it("drops teammates the tenant cannot see", async () => {
    const labels = await welcomeTeammates(T1, {
      loadConfig: async () => cfg, resolveTier: async () => "pro",
      visible: async (_tenant: string, slug: string) => slug !== "qa",
    });
    expect(labels).toContain("engineer");
    expect(labels).not.toContain("qa");
  });

  it("an unreadable config (deferred) or a read error names nobody", async () => {
    expect(await welcomeTeammates(T1, {
      loadConfig: async () => ({ ...cfg, deferred: true }), resolveTier: async () => "pro", visible: show,
    })).toEqual([]);
    expect(await welcomeTeammates(T1, {
      loadConfig: async () => cfg, resolveTier: async () => { throw new Error("db down"); }, visible: show,
    })).toEqual([]);
    expect(await welcomeTeammates(T1, {
      loadConfig: async () => cfg, resolveTier: async () => "pro",
      visible: async () => { throw new Error("visibility read failed"); },
    })).toEqual([]);
  });
});

describe("slackWelcomeFn marks the welcome sent only after the DM is queued", () => {
  const handler = (slackWelcomeFn as unknown as { f: (ctx: unknown) => Promise<unknown> }).f;
  const step = { run: async (_name: string, fn: () => unknown) => fn() };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const event = { data: { tenant_id: T1, team_id: TEAM, installer_slack_user_id: "Uinstaller" } };

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedEnqueue.mockReset();
    db.row = { tenant_id: T1, team_id: TEAM, team_name: "Acme" };
    db.updates = [];
    db.audits = [];
  });

  it("a failed conversations.open throws (Inngest retries) and leaves welcome_sent_at unset", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("slack 500"));
    await expect(handler({ event, step, logger })).rejects.toThrow("slack 500");
    expect(db.updates).toEqual([]);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("an outbox enqueue failure also throws and stamps nothing", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, channel: { id: "D999" } });
    mockedEnqueue.mockResolvedValueOnce(null);
    await expect(handler({ event, step, logger })).rejects.toThrow(/not queued/);
    expect(db.updates).toEqual([]);
  });

  it("success: DM queued with plan-filtered teammates, THEN welcome_sent_at is stamped", async () => {
    (resolveTenantTier as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce("free");
    mockedFetch.mockResolvedValueOnce({ ok: true, channel: { id: "D999" } });
    mockedEnqueue.mockResolvedValueOnce(1);
    const out = await handler({ event, step, logger });
    expect(out).toMatchObject({ outcome: "ok", dm_queued: true });
    expect(mockedEnqueue.mock.calls[0][0].body).toContain("(support-lead, growth-lead, ops, pm, qa, research and more)");
    expect(mockedEnqueue.mock.calls[0][0].body).not.toContain("engineer");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toHaveProperty("welcome_sent_at");
  });

  it("already welcomed (no unstamped row): sends nothing", async () => {
    db.row = null;
    expect(await handler({ event, step, logger })).toEqual({ outcome: "already_sent_or_no_row" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("no installer id: sends nothing and stays unstamped for a later connect", async () => {
    const out = await handler({ event: { data: { tenant_id: T1, team_id: TEAM } }, step, logger });
    expect(out).toEqual({ outcome: "no_installer" });
    expect(db.updates).toEqual([]);
  });
});
