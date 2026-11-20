import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  autopilot: true,
  lists: [] as Array<{ id?: string; active: unknown; needs_consent: boolean }>,
  tools: new Set<string>(),
  seen: [] as string[],
  paused: false,
}));

vi.mock("@/services/growth/channel-autorun", () => ({
  readAutopilotState: async (tenantId: string) => {
    state.seen.push(`autopilot:${tenantId}`);
    return { enabled: state.autopilot, on_at: null };
  },
}));
vi.mock("@/services/comms/bulk-outbound/lists", () => ({
  listSummaries: async (tenantId: string) => {
    state.seen.push(`lists:${tenantId}`);
    return state.lists;
  },
}));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: async () => state.paused }));
vi.mock("@/services/email-cards/variants", async (orig) => ({
  ...(await orig<typeof import("@/services/email-cards/variants")>()),
  readTestListKeys: async () => new Set<string>(),
}));
vi.mock("@/services/email-test-lists/lists", () => ({
  liveToolCaller: async () => null,
  readToolLists: async (tenantId: string, tool: string) => {
    state.seen.push(`read-tool-lists:${tenantId}:${tool}`);
    return { status: "complete", lists: [{ id: "a1", name: "Customers", member_count: 10 }], error: null };
  },
}));
vi.mock("@/services/connectors/email-campaign/account", () => ({
  resolveEmailTool: async (tenantId: string, tool: string) => {
    state.seen.push(`tool:${tenantId}:${tool}`);
    if (!state.tools.has(tool)) throw new Error("not connected");
    return { tool };
  },
}));

vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/readiness")>()),
  checkBulkSender: async () => ({ ok: true }),
}));

import { readPlan } from "../api";
import { plannedForCard } from "@/services/email-cards/cards";

const T = "tenant-northwind-clinic";
const deps = {
  rpc: (async () => ({ ok: true, role: "owner", next_plan_at: "2026-10-26T15:00:00.000Z", items: [], holds: [], released: [] })) as never,
  zone: async () => "America/Chicago",
};

describe("readPlan weekly_eligible", () => {
  beforeEach(() => {
    state.autopilot = true;
    state.lists = [];
    state.tools = new Set();
    state.seen = [];
    state.paused = false;
  });

  it("is false with Autopilot on, no list and no email tool, while the next plan label is still set", async () => {
    const out = await readPlan(T, "user-1", deps);
    expect(out).toMatchObject({ ok: true, autopilot_on: true, weekly_eligible: false, weekly_block: "no_list" });
    expect((out as { next_plan_label: string | null }).next_plan_label).toBeTruthy();
    expect(state.seen).toEqual(expect.arrayContaining([`lists:${T}`, `tool:${T}:mailchimp`, `tool:${T}:klaviyo`, `tool:${T}:sendgrid`]));
    expect(state.seen.every((s) => s.includes(T))).toBe(true);
  });

  it("is false when the only list still needs consent or is not active", async () => {
    state.lists = [
      { active: { id: "v1" }, needs_consent: true },
      { active: null, needs_consent: false },
    ];
    expect(await readPlan(T, "user-1", deps)).toMatchObject({ weekly_eligible: false });
  });

  it("is true with an active consented Zavi list", async () => {
    state.lists = [{ id: "list-1", active: { id: "v1", sendable: 3 }, needs_consent: false }];
    expect(await readPlan(T, "user-1", deps)).toMatchObject({ autopilot_on: true, weekly_eligible: true, weekly_block: null });
  });

  it("is true with a connected email tool and no list", async () => {
    state.tools = new Set(["sendgrid"]);
    expect(await readPlan(T, "user-1", deps)).toMatchObject({ weekly_eligible: true });
  });

  it("never reads the lists live from a connected email tool on a page read", async () => {
    state.tools = new Set(["mailchimp", "klaviyo", "sendgrid"]);
    for (let i = 0; i < 3; i++) expect(await readPlan(T, "user-1", deps)).toMatchObject({ weekly_eligible: true, weekly_block: null });
    expect(state.seen.filter((s) => s.startsWith("read-tool-lists:"))).toEqual([]);
    expect(state.seen.filter((s) => s.startsWith("tool:"))).toEqual([`tool:${T}:mailchimp`, `tool:${T}:mailchimp`, `tool:${T}:mailchimp`]);
  });

  it("the weekly planning check still reads the tool lists live", async () => {
    state.tools = new Set(["sendgrid"]);
    const { weeklyBlock } = await import("../live");
    expect(await weeklyBlock(T)).toBeNull();
    expect(state.seen).toContain(`read-tool-lists:${T}:sendgrid`);
  });

  it("is false and names the pause while email is paused, even with a consented list", async () => {
    state.paused = true;
    state.lists = [{ id: "list-1", active: { id: "v1", sendable: 3 }, needs_consent: false }];
    expect(await readPlan(T, "user-1", deps)).toMatchObject({ autopilot_on: true, weekly_eligible: false, weekly_block: "paused" });
  });

  it("is false with Autopilot off even with a consented list", async () => {
    state.autopilot = false;
    state.lists = [{ active: { id: "v1" }, needs_consent: false }];
    expect(await readPlan(T, "user-1", deps)).toMatchObject({ autopilot_on: false, weekly_eligible: false });
  });
});

describe("readPlan time zone", () => {
  it("says the zone was read when it was", async () => {
    expect(await readPlan(T, "user-1", deps)).toMatchObject({ timezone: "America/Chicago", timezone_unread: false });
  });

  it("flags a zone it could not read instead of passing UTC off as the workspace's zone", async () => {
    const out = await readPlan(T, "user-1", { ...deps, zone: async () => { throw new Error("db down"); } });
    expect(out).toMatchObject({ ok: true, timezone_unread: true });
    expect((out as { next_plan_label: string | null }).next_plan_label).toBeTruthy();
  });
});

describe("a planned send refused at its time reads as a sentence on both surfaces", () => {
  const CODE = /[a-z]+_[a-z_]+/;
  const cases: Array<[string, RegExp]> = [
    ["list_send_in_flight", /Another email to this list is still going out/],
    ["email_paused", /Email is paused for this workspace/],
    ["paused", /^Email was paused at its planned time, so it did not go out\. Resume email in Email campaigns settings/],
    ["zz_unheard_of_refusal", /^This email did not go out at its planned time\.$/],
  ];
  const raw = (status_reason: string) => ({
    id: "plan-1",
    route: "zavi_list",
    list_id: "L1",
    list_name: "Northwind Clinic patients",
    planned_at: "2026-10-27T15:00:00.000Z",
    timezone: "America/Chicago",
    angle: "Flu shots are in",
    why: null,
    source: "email_agent",
    status: "skipped",
    status_reason,
    content_version: 1,
    schedule_gen: 2,
    card: { rail: "decisions", id: "card-1" },
    vetoed: false,
    scheduled: null,
    unattended: true,
    sent_at: null,
    hold: null,
  });

  it.each(cases)("Coming up: %s", async (code, words) => {
    const out = await readPlan(T, "user-1", { ...deps, rpc: (async () => ({ ok: true, role: "owner", items: [raw(code)], holds: [], released: [] })) as never });
    const item = (out as { items: Array<{ reason: string | null; status_reason: string }> }).items[0];
    expect(item.status_reason).toBe(code);
    expect(item.reason).toMatch(words);
    expect(item.reason).not.toMatch(CODE);
  });

  it.each(cases)("the planned card: %s", async (code, words) => {
    const out = await plannedForCard(T, "decisions", "card-1", { rpc: (async () => raw(code)) as never });
    expect(out?.reason).toMatch(words);
    expect(out?.reason).not.toMatch(CODE);
  });

  it("a prototype key is not a sentence either", async () => {
    const out = await plannedForCard(T, "decisions", "card-1", { rpc: (async () => raw("constructor")) as never });
    expect(out?.reason).toBe("This email did not go out at its planned time.");
  });
});

describe("readPlan blocked_fix", () => {
  const items = [
    { status: "blocked", status_reason: "draft_blocked:channel_card_already_done", route: "sendgrid", planned_at: "2026-10-26T15:00:00.000Z", timezone: "UTC" },
    { status: "blocked", status_reason: "draft_blocked:email_campaign_body_invalid", route: "sendgrid", planned_at: "2026-10-26T15:00:00.000Z", timezone: "UTC" },
    { status: "blocked", status_reason: "draft_blocked:email_audience_missing", route: "mailchimp", planned_at: "2026-10-26T15:00:00.000Z", timezone: "UTC" },
    { status: "skipped", status_reason: "draft_blocked:email_campaign_body_invalid", route: "sendgrid", planned_at: "2026-10-26T15:00:00.000Z", timezone: "UTC" },
  ];

  it("names the way forward only for an item still blocked on a refusal the founder can act on from the row", async () => {
    const out = (await readPlan(T, "user-1", { ...deps, rpc: (async () => ({ ok: true, role: "owner", items, holds: [], released: [] })) as never })) as { items: Array<{ blocked_fix: string | null }> };
    expect(out.items.map((i) => i.blocked_fix)).toEqual(["change_topic", "draft_now", null, null]);
  });
});
