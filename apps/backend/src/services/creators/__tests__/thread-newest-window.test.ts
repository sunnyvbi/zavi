import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type FakeDb } from "./fake-supabase";

const holder = vi.hoisted(() => ({ db: null as unknown as { client: unknown } }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => holder.db.client,
  creatorAreaClient: () => holder.db.client,
  globalClient: () => holder.db.client,
  preTenantRpc: vi.fn(),
}));

import { listCreatorThreadMessages as listJobThreadMessages, type CreatorAreaOrderRow } from "../creator-area";
import { listCreatorThreadMessages as listInboxThreadMessages } from "../thread";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const OTHER_THREAD = "55555555-5555-4555-8555-555555555555";

function seed(count: number): FakeDb {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `m${i}`,
      tenant_id: TENANT,
      thread_id: THREAD,
      sender_kind: i % 2 === 0 ? "tenant" : "creator",
      body: `msg ${i}`,
      created_at: new Date(base + i * 60_000).toISOString(),
    });
  }
  rows.push({
    id: "other",
    tenant_id: TENANT,
    thread_id: OTHER_THREAD,
    sender_kind: "creator",
    body: "not this thread",
    created_at: new Date(base + count * 60_000 + 1).toISOString(),
  });
  const shuffled = rows.map((r, i) => ({ r, k: (i * 7919) % rows.length })).sort((a, b) => a.k - b.k).map((x) => x.r);
  return makeFakeDb({ creator_thread_messages: shuffled });
}

const order = {
  id: "o1",
  tenant_id: TENANT,
  human_member_id: MEMBER,
  thread_id: THREAD,
  status: "in_progress",
} as unknown as CreatorAreaOrderRow;

const ascending = (xs: Array<{ created_at: string }>) =>
  xs.every((m, i) => i === 0 || xs[i - 1].created_at < m.created_at);

describe("job thread on the creator's job page", () => {
  beforeEach(() => {
    holder.db = seed(130);
  });

  it("shows the newest 100 of 130 messages, oldest-first, ending on the latest", async () => {
    const out = await listJobThreadMessages(order);
    expect(out).toHaveLength(100);
    expect(out[out.length - 1].body).toBe("msg 129");
    expect(out[0].body).toBe("msg 30");
    expect(out.map((m) => m.body)).not.toContain("msg 29");
    expect(out.map((m) => m.body)).not.toContain("not this thread");
    expect(ascending(out)).toBe(true);
  });

  it("returns a short thread whole and in reading order", async () => {
    holder.db = seed(3);
    const out = await listJobThreadMessages(order);
    expect(out.map((m) => m.body)).toEqual(["msg 0", "msg 1", "msg 2"]);
  });
});

describe("thread in both inboxes", () => {
  beforeEach(() => {
    holder.db = seed(520);
  });

  it("shows the newest 500 of 520 messages, oldest-first, ending on the latest", async () => {
    const out = await listInboxThreadMessages({ tenant_id: TENANT, thread_id: THREAD } as never);
    expect(out).toHaveLength(500);
    expect(out[out.length - 1].body).toBe("msg 519");
    expect(out[0].body).toBe("msg 20");
    expect(out.map((m) => m.body)).not.toContain("msg 19");
    expect(out.map((m) => m.body)).not.toContain("not this thread");
    expect(ascending(out)).toBe(true);
  });

  it("returns a short thread whole and in reading order", async () => {
    holder.db = seed(3);
    const out = await listInboxThreadMessages({ tenant_id: TENANT, thread_id: THREAD } as never);
    expect(out.map((m) => m.body)).toEqual(["msg 0", "msg 1", "msg 2"]);
  });
});
