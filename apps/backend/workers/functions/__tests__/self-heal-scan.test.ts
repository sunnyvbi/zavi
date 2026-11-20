
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(async (_input: { source: string; code?: string; msg: string }) => {}),
  serviceClientMock: vi.fn(),
}));
vi.mock("@/services/logging/alert", () => ({ alert: mocks.alert }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("../client", () => ({
  inngest: { createFunction: (_cfg: unknown, _trig: unknown, fn: unknown) => fn },
}));

import { runSelfHealScan } from "../self-heal-scan";

const SIG = "abc123def456ffffffffffffffffffffffffffff";

function installRpc(opts: {
  eligible: Array<{ signature: string; code_class: string; agent_slug: string; run_count: number; tenant_count: number }>;
  claimWins: boolean;
  eligibleError?: boolean;
}) {
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    rpc: async (name: string) => {
      if (name === "eligible_self_heal_signatures") {
        return opts.eligibleError
          ? { data: null, error: { message: "db down" } }
          : { data: opts.eligible, error: null };
      }
      if (name === "claim_self_heal_notify") {
        return { data: opts.claimWins ? [{ signature: SIG }] : [], error: null };
      }
      return { data: null, error: null };
    },
  }));
}

function reset() {
  delete process.env.SELF_HEAL_NOTIFY_ENABLED;
  mocks.alert.mockClear();
}
beforeEach(reset);
afterEach(reset);

const oneEligible = [{ signature: SIG, code_class: "parse_failed", agent_slug: "operator", run_count: 4, tenant_count: 3 }];

describe("runSelfHealScan", () => {
  it("flag OFF (default) → no-op, no DB call, no alert", async () => {
    installRpc({ eligible: oneEligible, claimWins: true });
    const res = await runSelfHealScan();
    expect(res).toEqual({ enabled: false, scanned: 0, notified: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("flag ON + eligible + claim wins → alerts once", async () => {
    process.env.SELF_HEAL_NOTIFY_ENABLED = "1";
    installRpc({ eligible: oneEligible, claimWins: true });
    const res = await runSelfHealScan();
    expect(res).toEqual({ enabled: true, scanned: 1, notified: 1 });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const payload = mocks.alert.mock.calls[0][0] as { source: string; code?: string; msg: string };
    expect(payload.source).toBe("self-heal-scan");
    expect(payload.code).toBe("platform_bug_recurred");
    expect(payload.msg).toContain(SIG.slice(0, 8));
    expect(payload.msg).not.toContain(SIG);
    expect(payload.msg).toContain("operator");
    expect(payload.msg).toContain("tenants=3");
  });

  it("dedup: claim returns nothing (cooldown / lost race) → NO alert", async () => {
    process.env.SELF_HEAL_NOTIFY_ENABLED = "1";
    installRpc({ eligible: oneEligible, claimWins: false });
    const res = await runSelfHealScan();
    expect(res).toEqual({ enabled: true, scanned: 1, notified: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("no eligible signatures → no alert", async () => {
    process.env.SELF_HEAL_NOTIFY_ENABLED = "1";
    installRpc({ eligible: [], claimWins: true });
    const res = await runSelfHealScan();
    expect(res).toEqual({ enabled: true, scanned: 0, notified: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("eligible read error → throws (Inngest retries), no alert", async () => {
    process.env.SELF_HEAL_NOTIFY_ENABLED = "1";
    installRpc({ eligible: [], claimWins: true, eligibleError: true });
    await expect(runSelfHealScan()).rejects.toThrow(/eligible_self_heal_signatures/);
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
