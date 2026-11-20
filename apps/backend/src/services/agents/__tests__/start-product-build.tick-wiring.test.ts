import { describe, it, expect, vi } from "vitest";
import type { FastBuildContext } from "@/services/sites/contract";

const h = vi.hoisted(() => ({
  send: vi.fn(async (_e: unknown) => ({ ids: ["e1"] })),
  sagaDeps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/../workers/client", () => ({ inngest: { send: h.send } }));

vi.mock("@/services/agents/fast-build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/fast-build")>();
  return {
    ...actual,
    startFastBuild: vi.fn(async (ctx: FastBuildContext, partial: Record<string, unknown>) => {
      h.sagaDeps.push(partial);
      return { kind: "setup_failed" as const, reason: `stub:${ctx.conductor_run_id}`, retryable: true };
    }),
  };
});

import { realStartProductBuildDeps } from "@/services/agents/start-product-build";
import { CONDUCTOR_TICK_REQUESTED } from "@/services/agents/conductor-kick";

describe("the real site saga kicks the conductor itself", () => {
  it("hands the saga a tick requester that sends this run's conductor tick event and swallows a send failure", async () => {
    await realStartProductBuildDeps.startFastBuild({
      tenant_id: "t1",
      conductor_run_id: "11111111-1111-4111-8111-111111111111",
      company_name: "Acme",
      idea: "x",
      max_usd: 50,
      started_by_user_id: null,
      owner_email: null,
      first_build_free: false,
    });
    const requestTick = h.sagaDeps[0].requestTick as (id: string) => Promise<unknown>;
    expect(typeof requestTick).toBe("function");
    await expect(requestTick("11111111-1111-4111-8111-111111111111")).resolves.toBe(true);
    expect(h.send).toHaveBeenCalledWith({
      name: CONDUCTOR_TICK_REQUESTED,
      data: { conductor_run_id: "11111111-1111-4111-8111-111111111111" },
    });
    h.send.mockRejectedValueOnce(new Error("inngest down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(requestTick("11111111-1111-4111-8111-111111111111")).resolves.toBe(false);
  });
});
