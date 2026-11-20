import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ lists: [] as unknown[] | Error, listReads: 0 }));

vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "in", "order", "gt", "gte"]) q[k] = () => q;
  q.limit = async () => ({ data: [], error: null });
  q.maybeSingle = async () => ({ data: null, error: null });
  return { asTenantId: (s: string) => s, tenantClient: () => q, tenantRpc: async () => ({ data: null, error: null }), tenantStorage: () => ({ from: () => ({}) }), globalClient: () => q, applySecretListEditRpc: async () => ({ data: null, error: null }), StaleRevisionError: class extends Error {} };
});
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => {
    h.listReads += 1;
    if (h.lists instanceof Error) throw h.lists;
    return h.lists;
  },
}));

vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/readiness")>()),
  checkBulkSender: async () => ({ ok: true }),
}));

import { topActionDef } from "@/services/channels/top-actions";
import { LIST_GONE_SENTENCE } from "@/services/email-plan/messages";

const ID = "8f0c3c1e-2b1a-4c55-9d1e-4b7f1b2a9c10";
const def = topActionDef("email_marketing", "new_email")!;
const pick = (over: Record<string, unknown> = {}) => def.precheck!("t1", { route: "zavi_list", list_id: ID, brief: "Our spring sale starts Friday", ...over });
const list = (over: Record<string, unknown>) => ({ id: ID, name: "Imported leads", created_at: "2026-10-01T00:00:00Z", latest: null, active: { id: "v1", source_kind: "csv", contact_count: 40, sendable: 40, unsubscribed_or_bounced: 0 }, needs_consent: false, ...over });

beforeEach(() => {
  h.lists = [];
  h.listReads = 0;
});

describe("New email to a Zavi list Zavi cannot send to refuses before the paid run", () => {
  it("unconfirmed consent, no active version, nobody sendable, or a list that is gone: each refuses in founder words", async () => {
    h.lists = [list({ needs_consent: true })];
    expect(await pick()).toMatch(/agreed to hear from you/);
    h.lists = [list({ active: null })];
    expect(await pick()).toMatch(/agreed to hear from you/);
    h.lists = [list({ active: { id: "v1", source_kind: "csv", contact_count: 40, sendable: 0, unsubscribed_or_bounced: 40 } })];
    expect(await pick()).toMatch(/nobody on this list/);
    h.lists = [list({ id: "11111111-1111-4111-8111-111111111111" })];
    expect(await pick()).toBe(LIST_GONE_SENTENCE);
  });

  it("a confirmed list with people passes; a list read that fails stays open so the tool decides", async () => {
    h.lists = [list({})];
    expect(await pick()).toBeNull();
    h.lists = new Error("rpc down");
    expect(await pick()).toBeNull();
  });

  it("a tool route never reads Zavi's lists", async () => {
    h.lists = [list({ needs_consent: true })];
    expect(await pick({ route: "mailchimp", list_id: "a1b2c3" })).toBeNull();
    expect(h.listReads).toBe(0);
  });
});
