
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";

const rpcCalls: Array<{ tid: string; name: string; args: Record<string, unknown> }> = [];
let rpcImpl: (name: string, args: Record<string, unknown>) => {
  data?: unknown;
  error?: { message: string } | null;
} = () => ({ data: [], error: null });
let configBlob: Record<string, unknown> = {};
let configErrors = false;

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ tid, name, args });
    return rpcImpl(name, args);
  },
  globalClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            configErrors
              ? { data: null, error: { message: "boom" } }
              : { data: { blob: configBlob }, error: null },
        }),
      }),
    }),
  }),
}));

import {
  DbSteerSource,
  isBargeInEnabledForTenant,
  resolveSteerSourceForRun,
} from "../db-steer-source";

type AgentTrigger = Parameters<typeof resolveSteerSourceForRun>[0]["trigger"];

beforeEach(() => {
  rpcCalls.length = 0;
  rpcImpl = () => ({ data: [], error: null });
  configBlob = {};
  configErrors = false;
});

const ON = { agent_barge_in_enabled: true };

describe("isBargeInEnabledForTenant", () => {
  it("is OFF when the master key is absent (pre-Slice-8 state — inert)", async () => {
    expect(await isBargeInEnabledForTenant(TENANT)).toBe(false);
  });

  it("is ON when the master key is true", async () => {
    configBlob = { ...ON };
    expect(await isBargeInEnabledForTenant(TENANT)).toBe(true);
  });

  it("honours the per-tenant kill switch", async () => {
    configBlob = { ...ON, agent_barge_in_disabled_tenants: [OTHER_TENANT, TENANT] };
    expect(await isBargeInEnabledForTenant(TENANT)).toBe(false);
    configBlob = { ...ON, agent_barge_in_disabled_tenants: [OTHER_TENANT] };
    expect(await isBargeInEnabledForTenant(TENANT)).toBe(true);
  });

  it("soft-fails CLOSED on a config read error", async () => {
    configErrors = true;
    expect(await isBargeInEnabledForTenant(TENANT)).toBe(false);
  });
});

describe("resolveSteerSourceForRun (THE GATE)", () => {
  it("arms each of the 4 interactive surfaces when the flag is ON", async () => {
    configBlob = { ...ON };
    for (const trigger of ["chat", "slack", "email", "teams"] as AgentTrigger[]) {
      const src = await resolveSteerSourceForRun({
        runId: RUN,
        tenantId: TENANT,
        trigger,
      });
      expect(src, `trigger=${trigger}`).toBeInstanceOf(DbSteerSource);
    }
  });

  it("returns undefined for NON-interactive triggers even with the flag ON", async () => {
    configBlob = { ...ON };
    for (const trigger of [
      "cron",
      "manual",
      "a2a",
      "playbook",
      "webhook",
      "mcp",
      "handoff",
      "qa-weekly-execute",
    ] as AgentTrigger[]) {
      const src = await resolveSteerSourceForRun({
        runId: RUN,
        tenantId: TENANT,
        trigger,
      });
      expect(src, `trigger=${trigger}`).toBeUndefined();
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns undefined for a BATCH FAN-OUT CHILD (chat trigger, background work)", async () => {
    configBlob = { ...ON };
    const src = await resolveSteerSourceForRun({
      runId: RUN,
      tenantId: TENANT,
      trigger: "chat",
      batchId: "99999999-9999-9999-9999-999999999999",
    });
    expect(src).toBeUndefined();
    expect(rpcCalls).toHaveLength(0);
  });

  it("still arms a REAL chat turn (batchId null) — the guard is not over-broad", async () => {
    configBlob = { ...ON };
    const src = await resolveSteerSourceForRun({
      runId: RUN,
      tenantId: TENANT,
      trigger: "chat",
      batchId: null,
    });
    expect(src).toBeInstanceOf(DbSteerSource);
  });

  it("returns undefined when the flag is OFF (inert)", async () => {
    expect(
      await resolveSteerSourceForRun({ runId: RUN, tenantId: TENANT, trigger: "chat" }),
    ).toBeUndefined();
  });

  it("returns undefined for a SHADOW run (never consumes a real user's steer)", async () => {
    configBlob = { ...ON };
    expect(
      await resolveSteerSourceForRun({
        runId: RUN,
        tenantId: TENANT,
        trigger: "chat",
        isShadowRun: true,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the run/tenant identity is missing", async () => {
    configBlob = { ...ON };
    expect(
      await resolveSteerSourceForRun({ runId: "", tenantId: TENANT, trigger: "chat" }),
    ).toBeUndefined();
    expect(
      await resolveSteerSourceForRun({ runId: RUN, tenantId: "", trigger: "chat" }),
    ).toBeUndefined();
  });
});

describe("DbSteerSource.drain", () => {
  it("routes through tenantRpc (tenant INJECTED, not a caller arg) and maps rows", async () => {
    rpcImpl = () => ({
      data: [
        {
          id: "s1",
          seq: "7",
          body: "use the prod account",
          origin: "chat",
          author_user_id: "u1",
        },
      ],
      error: null,
    });
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    const out = await src.drain(3, 10);

    expect(rpcCalls[0].name).toBe("drain_agent_run_steers");
    expect(rpcCalls[0].tid).toBe(TENANT);
    expect(rpcCalls[0].args).toMatchObject({ p_run_id: RUN, p_after_seq: 3, p_max: 10 });
    expect(rpcCalls[0].args).not.toHaveProperty("p_tenant_id");

    expect(out).toEqual([
      { id: "s1", seq: 7, body: "use the prod account", origin: "chat", author_user_id: "u1" },
    ]);
    expect(typeof out[0].seq).toBe("number");
  });

  it("returns [] when nothing is pending", async () => {
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    expect(await src.drain(0, 10)).toEqual([]);
  });

  it("THROWS on an RPC error (supabase returns it as a VALUE, not a throw)", async () => {
    rpcImpl = () => ({ data: null, error: { message: "permission denied" } });
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    await expect(src.drain(0, 10)).rejects.toThrow(/permission denied/);
  });
});

describe("DbSteerSource.markDrained", () => {
  it("acks through the tenant-scoped RPC", async () => {
    rpcImpl = () => ({ data: 1, error: null });
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    await src.markDrained(["s1"], 2);
    expect(rpcCalls[0].name).toBe("mark_agent_run_steers_drained");
    expect(rpcCalls[0].tid).toBe(TENANT);
    expect(rpcCalls[0].args).toMatchObject({ p_ids: ["s1"], p_run_id: RUN });
    expect(rpcCalls[0].args).not.toHaveProperty("p_tenant_id");
  });

  it("is a no-op on an empty id list (no RPC round-trip)", async () => {
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    await src.markDrained([], 1);
    expect(rpcCalls).toHaveLength(0);
  });

  it("RETRIES a transient ack failure before giving up (shrinks the duplicate window)", async () => {
    let calls = 0;
    rpcImpl = () => {
      calls += 1;
      return calls < 3
        ? { data: null, error: { message: "deadlock detected" } }
        : { data: 1, error: null };
    };
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    await expect(src.markDrained(["s1"], 1)).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("throws after the retries are exhausted so the adapter can back off", async () => {
    rpcImpl = () => ({ data: null, error: { message: "deadlock" } });
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    await expect(src.markDrained(["s1"], 1)).rejects.toThrow(/deadlock/);
    expect(rpcCalls.length).toBe(3);
  });
});

describe("cross-tenant", () => {
  it("every RPC is scoped to the source's OWN tenant — there is no per-call tenant arg", async () => {
    const src = new DbSteerSource({ runId: RUN, tenantId: TENANT as never });
    await src.drain(0, 10);
    rpcImpl = () => ({ data: 1, error: null });
    await src.markDrained(["s1"], 1);
    for (const call of rpcCalls) {
      expect(call.tid).toBe(TENANT);
      expect(call.tid).not.toBe(OTHER_TENANT);
      expect(call.args).not.toHaveProperty("p_tenant_id");
    }
  });
});
