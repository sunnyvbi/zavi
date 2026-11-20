
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", display_name: "Acme" };

const getBoolSettingMock = vi.fn(async () => false);
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...args: unknown[]) => getBoolSettingMock(...(args as [])),
}));

const isFleetHaltedMock = vi.fn(async () => false);
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => isFleetHaltedMock(),
}));

const enqueueAgentRunMock = vi.fn(async () => ({ run_id: "run-1" }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...args: unknown[]) => enqueueAgentRunMock(...(args as [])),
}));

const resolveRepoFullNameMock = vi.fn(async () => "rravi149/acme");
vi.mock("@/services/agents/repo-resolver", () => ({
  resolveRepoFullName: (...args: unknown[]) => resolveRepoFullNameMock(...(args as [])),
}));

vi.mock("@/agents/research/persist-snapshot", () => ({
  mondayUtc: () => "2026-06-08",
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: vi.fn() }),
}));

vi.mock("../client", () => ({
  inngest: { createFunction: vi.fn((..._args: unknown[]) => ({ id: "engineer-audit-weekly" })) },
}));

import { runForTenant, ENGINEER_AUDIT_SOURCE } from "../engineer-audit-weekly";

beforeAll(() => {
  process.env.PRAXIS_DISABLE_CRON_STOP = "1";
});
afterAll(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

beforeEach(() => {
  vi.clearAllMocks();
  getBoolSettingMock.mockResolvedValue(false);
  isFleetHaltedMock.mockResolvedValue(false);
  enqueueAgentRunMock.mockResolvedValue({ run_id: "run-1" });
  resolveRepoFullNameMock.mockResolvedValue("rravi149/acme");
});

describe("runForTenant", () => {
  it("skips a flag-off tenant without enqueueing", async () => {
    getBoolSettingMock.mockResolvedValue(false);
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("skipped");
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("respects an active fleet halt (no enqueue)", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    isFleetHaltedMock.mockResolvedValue(true);
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toContain("fleet halt");
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("skips a tenant with no connected github repo (no enqueue)", async () => {
    getBoolSettingMock.mockResolvedValue(true);
    resolveRepoFullNameMock.mockRejectedValue(new Error("no repo"));
    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toContain("no connected github repo");
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("enabled + connected repo → enqueues a read-only engineer cron audit", async () => {
    getBoolSettingMock.mockResolvedValue(true);

    const outcome = await runForTenant(TENANT);
    expect(outcome.status).toBe("enqueued");
    expect(enqueueAgentRunMock).toHaveBeenCalledTimes(1);

    const input = (enqueueAgentRunMock.mock.calls[0] as unknown[])[0] as {
      tenant_id: string;
      agent_slug: string;
      trigger: string;
      cron_dedupe_key: string;
      payload: { source: string; cto_chat_intent: string; repo_hint: string; ask: string };
    };
    expect(input.tenant_id).toBe(TENANT.id);
    expect(input.agent_slug).toBe("engineer");
    expect(input.trigger).toBe("cron");
    expect(input.cron_dedupe_key).toContain(TENANT.id);
    expect(input.cron_dedupe_key).toContain("2026-06-08");
    expect(input.payload.source).toBe(ENGINEER_AUDIT_SOURCE);
    expect(input.payload.cto_chat_intent).toBe("info");
    expect(input.payload.repo_hint).toBe("rravi149/acme");
    expect(input.payload.ask.toLowerCase()).toContain("secret");
    expect(input.payload.ask.toLowerCase()).toContain("billing");
    expect(input.payload.ask.toLowerCase()).toContain("never echo the raw secret");
  });
});
