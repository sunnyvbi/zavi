
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { deriveVoiceSessionAuthoritative } from "../tenant-derive";

const SESSION = "11111111-1111-4111-8111-111111111111";

const PERSISTED_ROW = {
  id: SESSION,
  tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  user_id: "user-real-001",
  agent_slug: "performance-marketer",
  thread_id: "thread-real-001",
  status: "active" as const,
};

function mockSessionsClient(result: {
  data?: Record<string, unknown> | null;
  error?: unknown;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown as SupabaseClient, spies: { from, select, eq, maybeSingle } };
}

describe("deriveVoiceSessionAuthoritative — C8 trust boundary", () => {
  it("returns the authoritative tuple from the persisted voice_sessions row", async () => {
    const { client } = mockSessionsClient({ data: PERSISTED_ROW });
    const out = await deriveVoiceSessionAuthoritative(client, SESSION);
    expect(out).toEqual({
      sessionId: SESSION,
      tenantId: "73db45ff-457e-4541-bc8f-bdb625390204",
      userId: "user-real-001",
      agentSlug: "performance-marketer",
      threadId: "thread-real-001",
      status: "active",
    });
  });

  it("looks up by session_id only — never by any caller-supplied tenant", async () => {
    const { client, spies } = mockSessionsClient({ data: PERSISTED_ROW });
    await deriveVoiceSessionAuthoritative(client, SESSION);
    expect(spies.from).toHaveBeenCalledWith("voice_sessions");
    expect(spies.eq).toHaveBeenCalledTimes(1);
    expect(spies.eq).toHaveBeenCalledWith("id", SESSION);
  });

  it("CANNOT be spoofed: a sidecar lying about tenant_id is ignored", async () => {
    const ATTACKER_CLAIMED_TENANT = "ffffffff-dead-beef-cafe-000000000000";
    const { client } = mockSessionsClient({ data: PERSISTED_ROW });

    const out = await deriveVoiceSessionAuthoritative(client, SESSION);

    expect(out).not.toBeNull();
    expect(out!.tenantId).toBe(PERSISTED_ROW.tenant_id);
    expect(out!.tenantId).not.toBe(ATTACKER_CLAIMED_TENANT);
    expect(out!.userId).toBe(PERSISTED_ROW.user_id);
  });

  it("returns null when the session row does not exist (deleted / bogus id)", async () => {
    const { client } = mockSessionsClient({ data: null });
    const out = await deriveVoiceSessionAuthoritative(client, "no-such-session");
    expect(out).toBeNull();
  });

  it("throws on a DB read error (caller fails closed, does not assume a tenant)", async () => {
    const { client } = mockSessionsClient({ error: { code: "PGRST500" } });
    await expect(
      deriveVoiceSessionAuthoritative(client, SESSION),
    ).rejects.toMatchObject({ code: "PGRST500" });
  });

  it("carries through every authoritative field needed downstream (no field dropped)", async () => {
    const ended = { ...PERSISTED_ROW, status: "ended" as const };
    const { client } = mockSessionsClient({ data: ended });
    const out = await deriveVoiceSessionAuthoritative(client, SESSION);
    expect(out).toMatchObject({
      sessionId: ended.id,
      tenantId: ended.tenant_id,
      userId: ended.user_id,
      agentSlug: ended.agent_slug,
      threadId: ended.thread_id,
      status: "ended",
    });
  });

  it("preserves the reaped lifecycle status (callbacks for a reaped session are distinguishable)", async () => {
    const reaped = { ...PERSISTED_ROW, status: "reaped" as const };
    const { client } = mockSessionsClient({ data: reaped });
    const out = await deriveVoiceSessionAuthoritative(client, SESSION);
    expect(out!.status).toBe("reaped");
  });
});
