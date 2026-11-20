import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  reasons: [] as string[],
  tables: [] as string[],
  rolloutPossible: true,
  halted: false,
  handler: null as null | ((a: { step: { run: (n: string, f: () => unknown) => Promise<unknown> } }) => Promise<unknown>),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, f: typeof h.handler) => {
      h.handler = f;
      return { id: "stub" };
    },
  },
}));

vi.mock("@/services/tenant-client", () => ({
  fleetSweepClient: (reason: string) => {
    h.reasons.push(reason);
    return {
      from: (table: string) => {
        h.tables.push(table);
        return { select: async () => ({ data: [{ id: "t1", display_name: "One" }], error: null }) };
      },
    };
  },
}));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: async () => h.halted }));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => false }));
vi.mock("@/services/alerts/mention-alert-flag", () => ({
  isMentionAlertRolloutPossible: async () => h.rolloutPossible,
  isMentionAlertRolloutEnabled: async () => false,
  isMentionAlertOptedIn: async () => false,
}));
vi.mock("@/services/alerts/mention-alert-send", () => ({ sendTenantMentionAlert: vi.fn() }));

import { runMentionAlertForTenant } from "../mention-alert-send";

const step = { run: async (_name: string, fn: () => unknown) => fn() };

beforeEach(() => {
  h.reasons = [];
  h.tables = [];
  h.rolloutPossible = true;
  h.halted = false;
});

describe("mention-alert-send tenant scan", () => {
  it("does not touch the fleet at all while the rollout key is unset", async () => {
    h.rolloutPossible = false;
    expect(h.handler).toBeTypeOf("function");
    const out = (await h.handler!({ step })) as { rollout_off?: boolean };
    expect(out).toMatchObject({ rollout_off: true, sent: 0, skipped: 0 });
    expect(h.tables).toEqual([]);
    expect(h.reasons).toEqual([]);
  });

  it("reads the fleet through the named sweep escape, never a raw service client", async () => {
    const source = readFileSync(join(__dirname, "..", "mention-alert-send.ts"), "utf8");
    expect(source).not.toMatch(/from "@\/services\/supabase"/);

    expect(h.handler).toBeTypeOf("function");
    const out = (await h.handler!({ step })) as { tenants: number; sent: number; skipped: number };
    expect(h.reasons).toEqual(["mention-alert twice-daily cross-tenant opt-in scan"]);
    expect(h.tables).toEqual(["tenants"]);
    expect(out).toMatchObject({ tenants: 1, sent: 0, skipped: 1 });
  });
});

describe("runMentionAlertForTenant: the fleet halt", () => {
  it("stops a tenant whose turn comes after the halt was pulled", async () => {
    h.halted = true;
    const out = await runMentionAlertForTenant({ id: "t1", display_name: "One" });
    expect(out).toEqual({ status: "skipped", reason: "fleet_halt" });
  });

  it("does not skip when nothing is halted", async () => {
    h.halted = false;
    const out = (await runMentionAlertForTenant({ id: "t1", display_name: "One" })) as {
      reason?: string;
    };
    expect(out.reason).not.toBe("fleet_halt");
  });
});
