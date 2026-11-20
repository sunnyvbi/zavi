
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called in this test");
  },
}));

import {
  tryInfraRetryRun,
  INFRA_RETRY_CAP,
  BOOT_REQUEUE_SETTLE_MS,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(cas: Resp) {
  const updates: Array<Record<string, unknown>> = [];
  function from() {
    const trace: Record<string, unknown> = { update: null, eq: [] };
    const b: Record<string, unknown> = {
      update(p: Record<string, unknown>) {
        trace.update = p;
        updates.push(trace);
        return b;
      },
      eq(c: string, v: unknown) {
        (trace.eq as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      select() {
        return b;
      },
      then(resolve: (r: Resp) => void) {
        resolve(cas);
      },
    };
    return b;
  }
  return { svc: { from } as never, updates };
}

const row = (over: Partial<InfraRetryRow> = {}): InfraRetryRow => ({
  id: "run-1",
  tenant_id: "t1",
  agent_slug: "engineer",
  status: "failed",
  error: "boot_reap: orphaned by container restart (worker died mid-run)",
  infra_retry_count: 0,
  last_progress_at: null,
  ...over,
});

describe("scan source — unchanged immediate re-fire", () => {
  it("boot_reap-failed row + eligible + count 0 → re-fired ONCE, same run_id, immediately", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ data: [{ id: "run-1" }], error: null });
    const ok = await tryInfraRetryRun(svc, { send } as never, row(), "scan");
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].id).toBe("run-1-infra-retry-1");
    expect(send.mock.calls[0][0].data.run_id).toBe("run-1");
  });

  it("money-path agent is NOT retried (E3 firewall)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ data: [{ id: "run-1" }], error: null });
    const ok = await tryInfraRetryRun(
      svc,
      { send } as never,
      row({ agent_slug: "performance-marketer" }),
      "scan",
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("count at cap is NOT retried (terminal stays terminal)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ data: [{ id: "run-1" }], error: null });
    const ok = await tryInfraRetryRun(
      svc,
      { send } as never,
      row({ infra_retry_count: INFRA_RETRY_CAP }),
      "scan",
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("non-boot_reap generic failure is NOT retried (behavior unchanged)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ data: [{ id: "run-1" }], error: null });
    const ok = await tryInfraRetryRun(
      svc,
      { send } as never,
      row({ error: "model exploded: validation error" }),
      "scan",
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("boot source — park now, dispatch deferred (deploy-window settle)", () => {
  it("eligible running orphan → CAS parks (queued, count+1) but does NOT send — the boot-reap settle timer owns the dispatch", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, updates } = makeSvc({ data: [{ id: "run-1" }], error: null });
    const ok = await tryInfraRetryRun(
      svc,
      { send } as never,
      row({ status: "running", error: null }),
      "boot",
    );
    expect(ok).toBe(true);
    expect(updates.length).toBe(1);
    expect((updates[0].update as Record<string, unknown>).status).toBe("queued");
    expect((updates[0].update as Record<string, unknown>).infra_retry_count).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("settle window is long enough to skip an adjacent boot (~2.5 min observed inter-boot gap)", () => {
    expect(BOOT_REQUEUE_SETTLE_MS).toBeGreaterThan(150_000);
  });
});
