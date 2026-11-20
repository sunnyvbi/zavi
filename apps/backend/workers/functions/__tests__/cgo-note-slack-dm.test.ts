import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
let run: Record<string, unknown> | null;
let note: Record<string, unknown> | null;
const outboxUpdates: Array<{ patch: Record<string, unknown>; where: Array<[string, unknown]> }> = [];
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const where: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        is: () => q,
        update: (patch: Record<string, unknown>) => ({
          eq: (c: string, v: unknown) => {
            where.push([c, v]);
            return {
              eq: async (c2: string, v2: unknown) => {
                where.push([c2, v2]);
                if (table === "slack_outbox") outboxUpdates.push({ patch, where });
                return { error: null };
              },
            };
          },
        }),
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "agent_runs" ? run : table === "tenants" ? { display_name: "Acme Rentals", slug: "acme" } : note,
          error: null,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/growth/goal-owner", () => ({
  enqueueGoalOwnerRun: vi.fn(),
  isNoteVisible: (n: { changed?: string[] | null; need?: string[] | null; would_change?: string[] | null; items?: unknown[] | null }) =>
    Array.isArray(n.items) && n.items.length > 0 ? true : (n.changed?.length ?? 0) + (n.need?.length ?? 0) + (n.would_change?.length ?? 0) > 0,
}));
vi.mock("@/services/growth/goal-attention", () => ({ sendGoalAttention: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
let ownerEmail: string | null;
vi.mock("@/email/sendAuthEmail", () => ({ resolveTenantOwnerEmail: async () => ownerEmail, sgSend: vi.fn() }));
let workspace: { team_id: string; label: string; reason: string } | null;
vi.mock("@/services/slack/resolve-target-workspace", () => ({ resolveTargetSlackWorkspace: async () => workspace }));
vi.mock("@/services/web-base", () => ({
  webBaseUrl: () => "https://www.zaviagent.com",
  channelActionUrl: (slug: string, id: string, tenant?: string | null) =>
    `https://www.zaviagent.com/workspace?tab=channels&channel=${slug}&action=${id}${tenant ? `&company=${tenant}` : ""}`,
}));

class ExpectedToolError extends Error {
  constructor(public readonly code: string, message?: string, public readonly meta?: Record<string, unknown>) {
    super(message ?? code);
  }
}
const slackErr = (e: string) => new ExpectedToolError("slack_api_error", `Slack API x not ok: ${e}`, { slack_error: e });
vi.mock("@/services/tools/types", () => ({ ExpectedToolError }));
const slackCalls: Array<[string, Record<string, unknown>]> = [];
let slackImpl: (method: string) => unknown;
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: async (_t: string, method: string, body: Record<string, unknown>, team?: string) => {
    slackCalls.push([method, { ...body, team }]);
    return slackImpl(method);
  },
}));
const enqueue = vi.fn(async (_a: Record<string, unknown>) => 1 as number | null);
vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: (a: Record<string, unknown>) => enqueue(a) }));

import { sendNoteSlackDmForRun } from "../cgo-goal-owner";

beforeEach(() => {
  run = { tenant_id: T, agent_slug: "cgo", payload: { autopilot: true } };
  note = { kind: "alarm", changed: ["Paused Reddit. Ignored for 9 days."], would_change: null, need: [], next_review_at: null };
  ownerEmail = "owner@acme.test";
  workspace = { team_id: "T-CGO", label: "Acme", reason: "agent_default" };
  slackCalls.length = 0;
  slackImpl = (m) => (m === "users.lookupByEmail" ? { user: { id: "U1" } } : { channel: { id: "D1" } });
  enqueue.mockClear();
  enqueue.mockResolvedValue(1);
});

describe("sendNoteSlackDmForRun", () => {
  it("finds the owner by email, opens a DM, and queues the note once per review", async () => {
    expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: true });
    expect(slackCalls).toEqual([
      ["users.lookupByEmail", { email: "owner@acme.test", team: "T-CGO" }],
      ["conversations.open", { users: "U1", team: "T-CGO" }],
    ]);
    const a = enqueue.mock.calls[0][0];
    expect(a).toMatchObject({ tenant_id: T, channel_id: "D1", team_id: "T-CGO", kind: "cgo_note", run_id: "run-1", idempotency_key: "cgo_note_dm:run-1" });
    expect(outboxUpdates.at(-1)).toEqual({
      patch: { recipient_slack_user: "U1" },
      where: [
        ["tenant_id", T],
        ["idempotency_key", "cgo_note_dm:run-1"],
      ],
    });
    expect(String(a.body)).toContain("• Paused Reddit. Ignored for 9 days.");
    expect(String(a.body).startsWith("*Acme Rentals: your head of growth update*")).toBe(true);
    expect(String(a.body)).toContain(`<https://www.zaviagent.com/workspace?tab=growth-strategy&company=${T}|Open Growth Strategy>`);
  });

  it("sends nothing for a review the founder does not see", async () => {
    note = { kind: "alarm", changed: [], would_change: null, need: [], next_review_at: null };
    expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: false, reason: "not_visible" });
    expect(slackCalls).toHaveLength(0);
  });

  it("no Slack workspace, or the owner is not in it: no DM, not an error", async () => {
    workspace = null;
    expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: false, reason: "no_slack" });
    workspace = { team_id: "T-CGO", label: "Acme", reason: "primary" };
    slackImpl = () => {
      throw new ExpectedToolError("slack_not_connected");
    };
    expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: false, reason: "no_slack" });
    for (const e of ["users_not_found", "missing_scope"]) {
      slackImpl = () => {
        throw slackErr(e);
      };
      expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: false, reason: "no_slack_member" });
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a rate limit, a Slack-side error or an outage throws so the step retries", async () => {
    for (const e of ["ratelimited", "internal_error", "fatal_error"]) {
      slackImpl = () => {
        throw slackErr(e);
      };
      await expect(sendNoteSlackDmForRun("run-1")).rejects.toThrow(e);
    }
    slackImpl = () => {
      throw new ExpectedToolError("slack_http", "HTTP 503");
    };
    await expect(sendNoteSlackDmForRun("run-1")).rejects.toThrow();
  });

  it("a failed enqueue throws so the step retries (the key keeps it to one DM)", async () => {
    enqueue.mockResolvedValueOnce(null);
    await expect(sendNoteSlackDmForRun("run-1")).rejects.toThrow(/enqueue failed/);
  });

  it("a note built from items is sent in sections, with the card link opening that company", async () => {
    note = {
      kind: "alarm",
      changed: [],
      would_change: null,
      need: [],
      next_review_at: null,
      headline: "Google refused one change; nothing for you to do.",
      items: [
        { section: "needs_you", text: "Count sign-ups", action_id: "a1", channel_slug: "google_ads" },
        { section: "blocked", text: "Create YT", reason: "Google Ads refused this change. We've been alerted; nothing for you to do", action_id: "b1", channel_slug: "youtube_ads" },
      ],
    };
    expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: true });
    const body = String(enqueue.mock.calls[0][0].body);
    expect(body).toContain("*Needs you*");
    expect(body).toContain("*Blocked on Zavi*");
    expect(body).toContain(`https://www.zaviagent.com/workspace?tab=channels&channel=google_ads&action=a1&company=${T}|Open`);
    expect(body).not.toContain("This was a mistake");
  });

  it("ignores a run that is not cgo's", async () => {
    run = { tenant_id: T, agent_slug: "operator" };
    expect(await sendNoteSlackDmForRun("run-1")).toEqual({ sent: false, reason: "not_a_cgo_run" });
  });
});
