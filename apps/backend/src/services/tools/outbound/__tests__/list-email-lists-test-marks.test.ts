import { beforeEach, describe, expect, it, vi } from "vitest";

const SMALL_UNMARKED = "aaaaaaaa-1111-4111-8111-111111111111";
const SMALL_MARKED = "bbbbbbbb-2222-4222-8222-222222222222";
const LARGE_UNMARKED = "cccccccc-3333-4333-8333-333333333333";
const DISMISSED = "dddddddd-4444-4444-8444-444444444444";
const OTHER_ROUTE = "eeeeeeee-5555-4555-8555-555555555555";
const VERSION = "ffffffff-6666-4666-8666-666666666666";

const h = vi.hoisted(() => ({
  settings: { data: null as unknown, error: null as unknown },
  settingsThrow: false,
  rpcNames: [] as string[],
  ids: [] as string[],
}));

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantRpc: async (_tid: string, name: string) => {
    h.rpcNames.push(name);
    if (h.settingsThrow) throw new Error("network down");
    return h.settings;
  },
}));

vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/readiness")>()),
  checkBulkSender: async () => ({ ok: true as const, sender: { domain: "northwind.test", from_address: "hi@northwind.test", from_name: null }, postal_address: "400 Elm St" }),
}));

vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () =>
    h.ids.map((id, i) => {
      const people = id === LARGE_UNMARKED ? 4_000 : 2 + i;
      return {
        id,
        name: id === SMALL_MARKED ? "Newsletter" : `List ${i}`,
        created_at: "2026-10-07T00:00:00Z",
        latest: { id: VERSION, source_kind: "csv", source_label: "email", contact_count: people, created_at: "2026-10-07T00:00:00Z", consented: true },
        active: { id: VERSION, source_kind: "csv", contact_count: people, sendable: people, unsubscribed_or_bounced: 0 },
        needs_consent: false,
      };
    }),
}));

import { callOutboundTool } from "@/services/mcp/internal/outbound";
import { topActionFinalRefusal, topActionRetryPayload } from "@/services/channels/top-actions";

type Row = { id: string; people: number; can_be_emailed: number; ready_to_send: boolean; marked_test?: unknown };

const marks = (items: Array<{ item: unknown; status?: unknown }>) => {
  h.settings = { data: { fields: { email_test_lists: items } }, error: null };
};

async function read(): Promise<{ is_error: boolean; content: string; byId: Map<string, Row> }> {
  const out = await callOutboundTool({ tenant_id: "t-1" }, "list_email_lists", {});
  const rows = out.is_error ? [] : (JSON.parse(out.content) as { lists: Row[] }).lists;
  return { is_error: out.is_error, content: out.content, byId: new Map(rows.map((r) => [r.id.toLowerCase(), r])) };
}

describe("outbound__list_email_lists: the founder's test mark, per list", () => {
  beforeEach(() => {
    h.settings = { data: { fields: {} }, error: null };
    h.settingsThrow = false;
    h.rpcNames = [];
    h.ids = [SMALL_UNMARKED, SMALL_MARKED, LARGE_UNMARKED];
  });

  it("must catch: a small list nobody marked reads false, and only the marked list of the same size reads true", async () => {
    marks([{ item: `zavi_list:${SMALL_MARKED}`, status: "active" }]);
    const { byId, is_error } = await read();
    expect(is_error).toBe(false);
    expect(byId.get(SMALL_UNMARKED)).toMatchObject({ people: 2, ready_to_send: true, marked_test: false });
    expect(byId.get(SMALL_MARKED)).toMatchObject({ people: 3, ready_to_send: true, marked_test: true });
    expect(byId.get(LARGE_UNMARKED)).toMatchObject({ people: 4_000, marked_test: false });
    expect(h.rpcNames).toEqual(["get_channel_settings"]);
  });

  it("with nothing ticked under Test lists, no list reads as a test list, however small", async () => {
    const { byId } = await read();
    expect([...byId.values()].map((r) => r.marked_test)).toEqual([false, false, false]);
  });

  it("reads the zavi_list route only: the same id marked on a tool is not this list's mark", async () => {
    h.ids = [OTHER_ROUTE];
    marks([{ item: `mailchimp:${OTHER_ROUTE}`, status: "active" }, { item: OTHER_ROUTE, status: "active" }]);
    const { byId } = await read();
    expect(byId.get(OTHER_ROUTE)?.marked_test).toBe(false);
  });

  it("a removed mark is no mark; a paused mark still counts, the safe side", async () => {
    h.ids = [DISMISSED, SMALL_MARKED];
    marks([{ item: `zavi_list:${DISMISSED}`, status: "dismissed" }, { item: `zavi_list:${SMALL_MARKED}`, status: "paused" }]);
    const { byId } = await read();
    expect(byId.get(DISMISSED)?.marked_test).toBe(false);
    expect(byId.get(SMALL_MARKED)?.marked_test).toBe(true);
  });

  it("matches a list id in any case, as the send doors do", async () => {
    h.ids = [SMALL_MARKED.toUpperCase()];
    marks([{ item: `zavi_list:${SMALL_MARKED}`, status: "active" }]);
    const { byId } = await read();
    expect(byId.get(SMALL_MARKED)?.marked_test).toBe(true);
  });

  it.each([
    ["the settings read answers with an error", () => { h.settings = { data: null, error: { message: "boom" } }; }],
    ["the settings read throws", () => { h.settingsThrow = true; }],
  ])("must catch: when %s the tool returns no lists at all, never marked_test false", async (_name, arrange) => {
    arrange();
    const { is_error, content } = await read();
    expect(is_error).toBe(true);
    expect(JSON.parse(content)).toEqual({ error: "email_test_lists_unreadable", message: expect.stringMatching(/could not check/) });
    expect(content).not.toMatch(/marked_test/);
    expect(content).not.toContain(SMALL_UNMARKED);
  });

  it("a failed marks read is not a final refusal, so a founder's top action may try again", async () => {
    h.settingsThrow = true;
    const { content } = await read();
    const payload = { channel_slug: "email_marketing", top_action: { key: "new_email", by: "u1", inputs: { route: "zavi_list", list_id: SMALL_UNMARKED, brief: "Spring sale email" } } };
    const trace = [{ name: "mcp__server__outbound__list_email_lists", status: "tool_error", output_preview: content }];
    expect(topActionFinalRefusal(payload, trace)).toBeNull();
    expect(topActionRetryPayload(payload, trace)).not.toBeNull();
  });

  it("the new field does not hide a list that is not ready from the top action's stop", async () => {
    const empty = "12121212-7777-4777-8777-777777777777";
    h.ids = [empty];
    marks([{ item: `zavi_list:${empty}`, status: "active" }]);
    const out = await callOutboundTool({ tenant_id: "t-1" }, "list_email_lists", {});
    const parsed = JSON.parse(out.content) as { lists: Array<Record<string, unknown>> };
    parsed.lists[0].ready_to_send = false;
    const payload = { channel_slug: "email_marketing", top_action: { key: "new_email", by: "u1", inputs: { route: "zavi_list", list_id: empty, brief: "Spring sale email" } } };
    const trace = [{ name: "mcp__server__outbound__list_email_lists", status: "ok", output_preview: JSON.stringify(parsed) }];
    expect(topActionFinalRefusal(payload, trace)).toEqual({ code: "zavi_list_not_ready" });
  });
});
