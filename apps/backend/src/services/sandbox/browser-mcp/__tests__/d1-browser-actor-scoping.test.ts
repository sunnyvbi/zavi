import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildRunActor } from "@/services/agents/actor-envelope";
import type { BrowserToolCtx } from "@/services/sandbox/browser-mcp/types";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const noRpc = { rpc: vi.fn() } as unknown as SupabaseClient;

function browserUserIdFromActor(
  actor: { actor_user_id: string | null } | undefined,
): string | undefined {
  return actor?.actor_user_id ?? undefined;
}

describe("D1-P0 — browser ctx carries the initiating human", () => {
  it("QA#3 (linchpin) — a handoff child inherits the parent human → user_id is the initiator, NOT null", async () => {
    const parent = {
      actor_user_id: "user-op",
      actor_source: "chat" as const,
      resolved_tenant_member: true,
      provenance_label: "signed-in user",
    };
    const childActor = await buildRunActor(noRpc, "a2a", {
      tenant_id: TENANT,
      inherited_actor: parent,
    });
    expect(browserUserIdFromActor(childActor)).toBe("user-op");
  });

  it("QA#4 (fail-closed) — a system/cron run has no human → user_id is undefined", async () => {
    const cronActor = await buildRunActor(noRpc, "cron", { tenant_id: TENANT });
    expect(cronActor.actor_user_id).toBeNull();
    expect(browserUserIdFromActor(cronActor)).toBeUndefined();
  });

  it("QA#9 (single-member common case) — a chat run resolves the enqueuer", async () => {
    const chat = await buildRunActor(noRpc, "chat", {
      tenant_id: TENANT,
      enqueued_by: "user-sole",
    });
    expect(browserUserIdFromActor(chat)).toBe("user-sole");
  });

  it("a malformed/absent actor → user_id undefined (never throws, fail-closed)", () => {
    expect(browserUserIdFromActor(undefined)).toBeUndefined();
    expect(browserUserIdFromActor({ actor_user_id: null })).toBeUndefined();
  });

  it("BrowserToolCtx accepts the optional server-derived user_id (type contract)", () => {
    const ctx: BrowserToolCtx = {
      tenant_id: TENANT,
      run_id: "run-1",
      agent_slug: "browser-operator",
      repo_full_name: "",
      user_id: "user-op",
    };
    expect(ctx.user_id).toBe("user-op");
  });
});
