import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  ownerRow: { data: { user_id: "u-owner", created_at: "2026-01-01" } as unknown, error: null as unknown },
  user: { data: { user: { email: "founder@acme.com" } } as unknown, error: null as unknown },
  inbox: vi.fn(),
}));

vi.mock("@/email/sendAgentOwnedEmail", () => ({ resolveInboxIdentity: (...a: unknown[]) => db.inbox(...a) }));
vi.mock("@/services/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "order", "limit"]) chain[k] = () => chain;
  chain.maybeSingle = async () => db.ownerRow;
  return {
    serviceClient: () => ({
      from: () => chain,
      auth: { admin: { getUserById: async () => db.user } },
    }),
  };
});

import { resolveBulkReplyTo } from "../reply-to";

describe("where a reply to a Zavi-list email goes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.inbox.mockResolvedValue({ address: "acme@inbox.zaviagent.com" });
    db.ownerRow = { data: { user_id: "u-owner", created_at: "2026-01-01" }, error: null };
    db.user = { data: { user: { email: "founder@acme.com" } }, error: null };
  });

  it("goes to the founder, never the members-only Zavi inbox that drops a contact's reply", async () => {
    expect(await resolveBulkReplyTo("tenant-a")).toBe("founder@acme.com");
    expect(db.inbox).not.toHaveBeenCalled();
  });

  it("is null when the owner has no email, so replies go to the From address", async () => {
    db.user = { data: { user: { email: null } }, error: null };
    expect(await resolveBulkReplyTo("tenant-a")).toBeNull();
  });

  it("is null when the workspace has no owner row", async () => {
    db.ownerRow = { data: null, error: null };
    expect(await resolveBulkReplyTo("tenant-a")).toBeNull();
  });

  it("throws when reading the owner fails, so a passing outage is never sealed as no reply address", async () => {
    db.ownerRow = { data: null, error: { message: "connection reset" } };
    await expect(resolveBulkReplyTo("tenant-a")).rejects.toThrow();
  });

  it("throws when reading the owner's account fails", async () => {
    db.user = { data: { user: null }, error: { message: "upstream timeout" } };
    await expect(resolveBulkReplyTo("tenant-a")).rejects.toThrow();
  });
});
