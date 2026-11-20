import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveSlackActor,
  systemActor,
  chatActor,
  buildRunActor,
  coerceInheritedActor,
  resolveEmailActor,
  resolveWhatsAppActor,
} from "@/services/agents/actor-envelope";

function fakeClient(rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("resolveSlackActor (Gap 5 Slice 0 — attribution-only)", () => {
  it("maps a verified tenant member → resolved + verified label", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "user-abc", error: null });
    const env = await resolveSlackActor(fakeClient(rpc), TENANT, "U123", "T999");
    expect(rpc).toHaveBeenCalledWith("resolve_slack_approver", {
      p_tenant_id: TENANT,
      p_team_id: "T999",
      p_slack_user_id: "U123",
    });
    expect(env).toMatchObject({
      actor_user_id: "user-abc",
      actor_source: "slack",
      slack_user_id: "U123",
      slack_team_id: "T999",
      resolved_tenant_member: true,
      provenance_label: "verified member",
    });
  });

  it("unmapped sender (RPC returns null) → still a VALID envelope, unverified, never throws/blocks", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const env = await resolveSlackActor(fakeClient(rpc), TENANT, "Uguest", "T999");
    expect(env).toMatchObject({
      actor_user_id: null,
      actor_source: "slack",
      slack_user_id: "Uguest",
      resolved_tenant_member: false,
      provenance_label: "unverified external",
    });
  });

  it("RPC error → fails ATTRIBUTION-open to the unverified envelope (not a security gate)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000" } });
    const env = await resolveSlackActor(fakeClient(rpc), TENANT, "U123", "T999");
    expect(env.actor_user_id).toBeNull();
    expect(env.resolved_tenant_member).toBe(false);
    expect(env.provenance_label).toBe("unverified external");
  });

  it("RPC throws → caught, still returns the unverified envelope", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network"));
    const env = await resolveSlackActor(fakeClient(rpc), TENANT, "U123", "T999");
    expect(env.actor_user_id).toBeNull();
    expect(env.resolved_tenant_member).toBe(false);
  });

  it("empty/whitespace slack_user_id → unverified WITHOUT calling the RPC", async () => {
    const rpc = vi.fn();
    const env = await resolveSlackActor(fakeClient(rpc), TENANT, "   ");
    expect(rpc).not.toHaveBeenCalled();
    expect(env.actor_user_id).toBeNull();
    expect(env.actor_source).toBe("slack");
    expect(env.slack_user_id).toBeUndefined();
  });

  it("missing tenant_id → unverified WITHOUT calling the RPC", async () => {
    const rpc = vi.fn();
    const env = await resolveSlackActor(fakeClient(rpc), "", "U123");
    expect(rpc).not.toHaveBeenCalled();
    expect(env.resolved_tenant_member).toBe(false);
  });
});

describe("systemActor", () => {
  it("cron → null human actor, scheduled label", () => {
    expect(systemActor("cron")).toEqual({
      actor_user_id: null,
      actor_source: "cron",
      resolved_tenant_member: false,
      provenance_label: "scheduled run",
    });
  });

  it("defaults to system source", () => {
    expect(systemActor().actor_source).toBe("system");
  });
});

describe("chatActor", () => {
  it("signed-in user → resolved chat actor", () => {
    expect(chatActor("user-1")).toEqual({
      actor_user_id: "user-1",
      actor_source: "chat",
      resolved_tenant_member: true,
      provenance_label: "signed-in user",
    });
  });
  it("no user id → unknown, null actor (defensive)", () => {
    expect(chatActor(null)).toMatchObject({
      actor_user_id: null,
      resolved_tenant_member: false,
      provenance_label: "unknown",
    });
  });
});

describe("buildRunActor (per-trigger dispatch)", () => {
  const noRpc = fakeClient(vi.fn());
  it("chat → chatActor(enqueued_by), no RPC", async () => {
    const rpc = vi.fn();
    const env = await buildRunActor(fakeClient(rpc), "chat", {
      tenant_id: TENANT,
      enqueued_by: "user-9",
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(env).toMatchObject({ actor_user_id: "user-9", actor_source: "chat" });
  });
  it("slack → resolves the sender via RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "user-x", error: null });
    const env = await buildRunActor(fakeClient(rpc), "slack", {
      tenant_id: TENANT,
      slack_user_id: "U1",
      slack_team_id: "T1",
    });
    expect(rpc).toHaveBeenCalledWith("resolve_slack_approver", {
      p_tenant_id: TENANT,
      p_team_id: "T1",
      p_slack_user_id: "U1",
    });
    expect(env).toMatchObject({ actor_user_id: "user-x", resolved_tenant_member: true });
  });
  it("cron → non-human cron actor, no RPC", async () => {
    const env = await buildRunActor(noRpc, "cron", { tenant_id: TENANT });
    expect(env).toMatchObject({ actor_user_id: null, actor_source: "cron", provenance_label: "scheduled run" });
  });
  it("a2a/other → non-human system actor, no RPC", async () => {
    const env = await buildRunActor(noRpc, "a2a", { tenant_id: TENANT });
    expect(env).toMatchObject({ actor_user_id: null, actor_source: "system" });
  });

  it("Slice 3 — a2a child with a valid inherited_actor ADOPTS it (human provenance survives handoff)", async () => {
    const parent = {
      actor_user_id: "user-parent",
      actor_source: "slack",
      slack_user_id: "U1",
      resolved_tenant_member: true,
      provenance_label: "verified member",
    };
    const env = await buildRunActor(noRpc, "a2a", { tenant_id: TENANT, inherited_actor: parent });
    expect(env).toMatchObject({
      actor_user_id: "user-parent",
      actor_source: "slack",
      resolved_tenant_member: true,
      provenance_label: "verified member",
    });
  });

  it("Slice 3 — a2a child with a MALFORMED inherited_actor falls back to system (trust boundary)", async () => {
    const env = await buildRunActor(noRpc, "a2a", {
      tenant_id: TENANT,
      inherited_actor: { actor_source: "not-a-source", actor_user_id: 42 },
    });
    expect(env).toMatchObject({ actor_user_id: null, actor_source: "system" });
  });

  it("Slice 3 — chat/slack triggers IGNORE inherited_actor (resolve fresh)", async () => {
    const rpc = vi.fn();
    const env = await buildRunActor(fakeClient(rpc), "chat", {
      tenant_id: TENANT,
      enqueued_by: "user-own",
      inherited_actor: { actor_user_id: "someone-else", actor_source: "slack", resolved_tenant_member: true, provenance_label: "x" },
    });
    expect(env.actor_user_id).toBe("user-own");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("coerceInheritedActor (trust boundary)", () => {
  it("accepts a well-formed envelope", () => {
    const ok = { actor_user_id: null, actor_source: "cron", resolved_tenant_member: false, provenance_label: "scheduled run" };
    expect(coerceInheritedActor(ok)).toEqual(ok);
  });
  it("rejects unknown source / bad types / non-objects", () => {
    expect(coerceInheritedActor(null)).toBeNull();
    expect(coerceInheritedActor("nope")).toBeNull();
    expect(coerceInheritedActor({ actor_source: "evil" })).toBeNull();
    expect(coerceInheritedActor({ actor_source: "chat", actor_user_id: 5, resolved_tenant_member: true, provenance_label: "x" })).toBeNull();
    expect(coerceInheritedActor({ actor_source: "chat", actor_user_id: null, resolved_tenant_member: "yes", provenance_label: "x" })).toBeNull();
  });
});

function tableClient(
  rows: Record<string, unknown>,
  rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> = async () => ({ data: null, error: null }),
) {
  const filters: Array<[string, string, unknown]> = [];
  const client = {
    rpc: vi.fn(rpc),
    from(table: string) {
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([table, col, val]);
          return q;
        },
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, filters, rpc: client.rpc };
}

describe("resolveEmailActor (email runs carry the sender when they are a verified member)", () => {
  const payload = { email: { email_message_id: "msg-1", from: "spoofed@evil.test" } };

  it("a DMARC-verified member's inbound email resolves to that member", async () => {
    const t = tableClient(
      { email_messages: { direction: "in", sender_verified_member: true, from_address: "Founder@Acme.com" } },
      async () => ({ data: "user-founder", error: null }),
    );
    expect(await resolveEmailActor(t.client, TENANT, payload)).toBe("user-founder");
    expect(t.filters).toContainEqual(["email_messages", "tenant_id", TENANT]);
    expect(t.rpc).toHaveBeenCalledWith("member_user_id_by_email", { p_tenant_id: TENANT, p_email: "Founder@Acme.com" });
  });

  it("an unverified or allowlisted sender stays null (no lookup)", async () => {
    const t = tableClient({ email_messages: { direction: "in", sender_verified_member: false, from_address: "x@y.z" } });
    expect(await resolveEmailActor(t.client, TENANT, payload)).toBeNull();
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it("a message not in this tenant, or an outbound one, stays null", async () => {
    expect(await resolveEmailActor(tableClient({}).client, TENANT, payload)).toBeNull();
    const out = tableClient({ email_messages: { direction: "out", sender_verified_member: true, from_address: "a@b.c" } });
    expect(await resolveEmailActor(out.client, TENANT, payload)).toBeNull();
  });

  it("no message id, or a throwing DB, stays null and never throws", async () => {
    expect(await resolveEmailActor(tableClient({}).client, TENANT, {})).toBeNull();
    const boom = { from: () => { throw new Error("db down"); } } as unknown as SupabaseClient;
    await expect(resolveEmailActor(boom, TENANT, payload)).resolves.toBeNull();
  });
});

describe("resolveWhatsAppActor (WhatsApp runs carry the member who bound the thread)", () => {
  const payload = { whatsapp: { phone_number_id: "pn-1", wa_id: "15550001", text: "hi" } };

  it("an enabled thread bound by a current member resolves to that member", async () => {
    const t = tableClient({
      whatsapp_threads: { bound_by_user_id: "user-wa", status: "enabled" },
      tenant_users: { user_id: "user-wa" },
    });
    expect(await resolveWhatsAppActor(t.client, TENANT, payload)).toBe("user-wa");
    expect(t.filters).toContainEqual(["whatsapp_threads", "tenant_id", TENANT]);
    expect(t.filters).toContainEqual(["tenant_users", "tenant_id", TENANT]);
  });

  it("a pending thread, or a binder who left the workspace, stays null", async () => {
    const pending = tableClient({ whatsapp_threads: { bound_by_user_id: "user-wa", status: "pending" }, tenant_users: { user_id: "user-wa" } });
    expect(await resolveWhatsAppActor(pending.client, TENANT, payload)).toBeNull();
    const left = tableClient({ whatsapp_threads: { bound_by_user_id: "user-wa", status: "enabled" } });
    expect(await resolveWhatsAppActor(left.client, TENANT, payload)).toBeNull();
  });

  it("a payload without a thread identity stays null", async () => {
    expect(await resolveWhatsAppActor(tableClient({}).client, TENANT, { whatsapp: { wa_id: "1" } })).toBeNull();
  });
});
