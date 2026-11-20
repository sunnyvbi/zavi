import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; tenant_id: string; created_at: string }>,
  reads: [] as Array<{ tenant: string; table: string; after: string; limit: number }>,
  fail: false,
}));

vi.mock("@/services/tenant-client", () => {
  const generic: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "in", "order", "limit", "gt", "gte"]) generic[k] = () => generic;
  generic.maybeSingle = async () => ({ data: null, error: null });
  class StaleRevisionError extends Error {}
  return {
    asTenantId: (s: string) => s,
    tenantClient: (tenant: string) => ({
      from: (table: string) => {
        const read = { after: "" };
        const q = {
          select: () => q,
          gt: (k: string, v: string) => {
            if (k === "created_at") read.after = v;
            return q;
          },
          limit: async (n: number) => {
            db.reads.push({ tenant, table, after: read.after, limit: n });
            if (db.fail) return { data: null, error: { message: "boom" } };
            if (table !== "email_card_reservations") return { data: [], error: null };
            const hit = db.rows.filter((r) => r.tenant_id === tenant && read.after !== "" && Date.parse(r.created_at) > Date.parse(read.after));
            return { data: hit.slice(0, n).map((r) => ({ id: r.id })), error: null };
          },
        };
        return q;
      },
    }),
    tenantStorage: () => ({ from: () => ({}) }),
    tenantRpc: async () => ({ data: null, error: null }),
    globalClient: () => generic,
    applySecretListEditRpc: async () => ({ data: null, error: null }),
    StaleRevisionError,
  };
});

vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => [{ id: "8f0c3c1e-2b1a-4c55-9d1e-4b7f1b2a9c10", name: "Members", created_at: "2026-10-01T00:00:00Z", latest: null, active: { id: "v1", source_kind: "csv", contact_count: 40, sendable: 40, unsubscribed_or_bounced: 0 }, needs_consent: false }],
}));

vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/readiness")>()),
  checkBulkSender: async () => ({ ok: true }),
}));

import { topActionDef } from "@/services/channels/top-actions";
import { EMAIL_CARD_CAP_PER_TENANT_24H } from "@/services/tools/email/propose_campaign";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const INPUTS = { route: "zavi_list", list_id: "8f0c3c1e-2b1a-4c55-9d1e-4b7f1b2a9c10", brief: "Our spring sale starts Friday" };
const fill = (tenant: string, n: number, at: string) => {
  for (let i = 0; i < n; i++) db.rows.push({ id: `${tenant}-${at}-${i}`, tenant_id: tenant, created_at: at });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.rows = [];
  db.reads = [];
  db.fail = false;
});

describe("New email refuses before a paid run when the day's email card cap is already used", () => {
  it("refuses in plain words once this workspace has the cap's worth of email cards from the last 24 hours", async () => {
    const def = topActionDef("email_marketing", "new_email");
    expect(def?.precheck).toBeTypeOf("function");
    fill("t1", EMAIL_CARD_CAP_PER_TENANT_24H, "2026-10-28T02:00:00Z");
    const refusal = await def!.precheck!("t1", INPUTS);
    expect(refusal).toBe("Zavi already put the most emails it may up for approval in one day. Try again tomorrow.");
    expect(refusal).not.toMatch(/card|cap|reservation|tenant|24h/i);
    expect(db.reads).toEqual([{ tenant: "t1", table: "email_card_reservations", after: "2026-10-27T12:00:00.000Z", limit: EMAIL_CARD_CAP_PER_TENANT_24H }]);
  });

  it("lets the run start one card under the cap, with older cards outside the window, or with another workspace at the cap", async () => {
    const pre = topActionDef("email_marketing", "new_email")!.precheck!;
    fill("t1", EMAIL_CARD_CAP_PER_TENANT_24H - 1, "2026-10-28T02:00:00Z");
    fill("t1", 5, "2026-10-27T11:59:00Z");
    fill("t2", EMAIL_CARD_CAP_PER_TENANT_24H, "2026-10-28T02:00:00Z");
    expect(await pre("t1", INPUTS)).toBeNull();
    fill("t1", 1, "2026-10-28T11:59:00Z");
    expect(await pre("t1", INPUTS)).not.toBeNull();
  });

  it("does not block the run when the count cannot be read; the tool still enforces the cap", async () => {
    db.fail = true;
    expect(await topActionDef("email_marketing", "new_email")!.precheck!("t1", INPUTS)).toBeNull();
  });
});
