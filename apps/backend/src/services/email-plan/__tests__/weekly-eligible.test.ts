import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Audience } from "@/services/connectors/email-campaign/providers";

type Summary = { id: string; active: { sendable: number } | null; needs_consent: boolean };
type Read = { status: "complete" | "partial" | "unreadable" | "not_connected"; lists: Audience[]; error: string | null };

const h = vi.hoisted(() => ({
  autopilot: true,
  paused: false as boolean | Error,
  marks: new Set<string>(),
  summaries: [] as Summary[],
  connected: new Set<string>(),
  reads: {} as Record<string, Read | Error>,
  readCalls: [] as string[],
  idle: false,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async () => {
    throw new Error("unexpected live rpc");
  }),
  tenantClient: () => {
    throw new Error("unexpected client");
  },
  staffCrossTenantClient: () => {
    throw new Error("unexpected cross-tenant read");
  },
}));
vi.mock("@/services/growth/tenant-idle", () => ({ tenantIsIdle: async () => h.idle }));
vi.mock("@/services/growth/channel-autorun", () => ({ readAutopilotState: async () => ({ enabled: h.autopilot }) }));
vi.mock("@/services/email-cards/pause", () => ({
  emailSendPaused: async () => {
    if (h.paused instanceof Error) throw h.paused;
    return h.paused;
  },
}));
vi.mock("@/services/email-cards/variants", async (orig) => ({
  ...(await orig<typeof import("@/services/email-cards/variants")>()),
  readTestListKeys: async () => h.marks,
}));
vi.mock("@/services/comms/bulk-outbound/lists", () => ({ listSummaries: async () => h.summaries }));
vi.mock("@/services/connectors/email-campaign/account", () => ({
  resolveEmailTool: async (_t: string, tool: string) => {
    if (!h.connected.has(tool)) throw new Error("not connected");
    return { tool };
  },
}));
vi.mock("@/services/email-test-lists/lists", () => ({
  liveToolCaller: async () => null,
  readToolLists: async (_t: string, tool: string, _deps: unknown, stopWhen?: (l: Audience[]) => boolean) => {
    h.readCalls.push(tool);
    const r = h.reads[tool] ?? { status: "not_connected", lists: [], error: null };
    if (r instanceof Error) throw r;
    if (stopWhen && r.status === "complete" && stopWhen(r.lists)) return { ...r, status: "partial" };
    return r;
  },
}));

vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/readiness")>()),
  checkBulkSender: async () => ({ ok: true }),
}));

import { weeklyEligible } from "../live";

const T = "11111111-1111-4111-8111-111111111111";
const LIST = "AAAAAAAA-0000-4000-8000-000000000001";
const good: Summary = { id: LIST, active: { sendable: 40 }, needs_consent: false };
const aud = (id: string): Audience => ({ id, name: id, member_count: 10 });

beforeEach(() => {
  h.autopilot = true;
  h.paused = false;
  h.marks = new Set();
  h.summaries = [];
  h.connected = new Set();
  h.reads = {};
  h.readCalls = [];
  h.idle = false;
});

describe("weeklyEligible: only a workspace that can really be emailed gets the paid weekly plan run", () => {
  it("a consented Zavi list with people on it is eligible", async () => {
    h.summaries = [good];
    expect(await weeklyEligible(T)).toBe(true);
  });

  it("nobody used the workspace for 7 days: no weekly run, and the page's block reason stays unchanged", async () => {
    h.summaries = [good];
    h.idle = true;
    expect(await weeklyEligible(T)).toBe(false);
    const { weeklyBlock } = await import("../live");
    expect(await weeklyBlock(T)).toBeNull();
  });

  it("email paused: not eligible even with a good list and a connected tool", async () => {
    h.paused = true;
    h.summaries = [good];
    h.connected = new Set(["mailchimp"]);
    h.reads = { mailchimp: { status: "complete", lists: [aud("m1")], error: null } };
    expect(await weeklyEligible(T)).toBe(false);
  });

  it("a pause that cannot be read fails closed", async () => {
    h.paused = new Error("email_send_paused failed");
    h.summaries = [good];
    await expect(weeklyEligible(T)).rejects.toThrow();
  });

  it("a Zavi list marked as a test list does not count (mark stored lowercase, id uppercase)", async () => {
    h.summaries = [good];
    h.marks = new Set([`zavi_list:${LIST.toLowerCase()}`]);
    expect(await weeklyEligible(T)).toBe(false);
  });

  it("an empty or fully blocked Zavi list does not count", async () => {
    h.summaries = [{ id: "l-empty", active: { sendable: 0 }, needs_consent: false }];
    expect(await weeklyEligible(T)).toBe(false);
  });

  it("a list still waiting on consent does not count", async () => {
    h.summaries = [{ ...good, needs_consent: true }];
    expect(await weeklyEligible(T)).toBe(false);
  });

  it("a connected tool whose every list is marked as a test is not eligible", async () => {
    h.connected = new Set(["klaviyo"]);
    h.reads = { klaviyo: { status: "complete", lists: [aud("k1"), aud("k2")], error: null } };
    h.marks = new Set(["klaviyo:k1", "klaviyo:k2"]);
    expect(await weeklyEligible(T)).toBe(false);
    expect(h.readCalls).toEqual(["klaviyo"]);
  });

  it("a connected tool with no lists at all is not eligible", async () => {
    h.connected = new Set(["sendgrid"]);
    h.reads = { sendgrid: { status: "complete", lists: [], error: null } };
    expect(await weeklyEligible(T)).toBe(false);
  });

  it("a connected tool with one real list next to test lists is eligible", async () => {
    h.connected = new Set(["klaviyo"]);
    h.reads = { klaviyo: { status: "complete", lists: [aud("k1"), aud("k2")], error: null } };
    h.marks = new Set(["klaviyo:k1"]);
    expect(await weeklyEligible(T)).toBe(true);
  });

  it.each([
    ["unreadable", { status: "unreadable", lists: [], error: "timeout" }],
    ["partial with no real list seen", { status: "partial", lists: [], error: "page 2 failed" }],
    ["a read that threw", new Error("composio down")],
  ] as const)("a tool read that proves nothing is a retry, never a paid run: %s", async (_name, read) => {
    h.connected = new Set(["mailchimp"]);
    h.reads = { mailchimp: read as Read | Error };
    expect(await weeklyEligible(T)).toBe("retry");
  });

  it("a partial read that already shows a real list is eligible", async () => {
    h.connected = new Set(["mailchimp"]);
    h.reads = { mailchimp: { status: "partial", lists: [aud("L1")], error: "page 2 failed" } };
    expect(await weeklyEligible(T)).toBe(true);
  });

  it("one tool unreadable, another with a real list: eligible", async () => {
    h.connected = new Set(["mailchimp", "klaviyo"]);
    h.reads = { mailchimp: { status: "unreadable", lists: [], error: "timeout" }, klaviyo: { status: "complete", lists: [aud("K1")], error: null } };
    expect(await weeklyEligible(T)).toBe(true);
  });

  it("a test-marked Zavi list does not hide a real tool list", async () => {
    h.summaries = [good];
    h.marks = new Set([`zavi_list:${LIST.toLowerCase()}`]);
    h.connected = new Set(["mailchimp"]);
    h.reads = { mailchimp: { status: "complete", lists: [aud("m1")], error: null } };
    expect(await weeklyEligible(T)).toBe(true);
  });

  it("Autopilot off is never eligible", async () => {
    h.autopilot = false;
    h.summaries = [good];
    expect(await weeklyEligible(T)).toBe(false);
  });
});
