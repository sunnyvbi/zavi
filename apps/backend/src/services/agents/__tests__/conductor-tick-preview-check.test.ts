import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RUN = "8059134e-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 8, 29, 10, 0, 7);

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  ready: vi.fn(async () => ({ posted: true, thread_id: "t" })),
  preview: vi.fn(),
  thumbnail: vi.fn(async () => ({ status: "saved" })),
  ledger: vi.fn(async () => undefined),
  kind: "build_app" as string,
  useReal: false,
  run: { status: "active" as string, goal_graph: [] as unknown[] },
  driverDeps: { repairConfig: { enabled: false } } as Record<string, unknown>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      const rows = () => {
        if (eqs.some(([k]) => k === "__parked")) return [];
        const wantActive = eqs.some(([k, v]) => k === "status" && v === "active");
        if (wantActive && h.run.status !== "active") return [];
        return [{ id: RUN, tenant_id: "tnt", kind: h.kind }];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (k: string, v: unknown) => (eqs.push([k, v]), builder),
        order: () => builder,
        not: () => builder,
        contains: () => (eqs.push(["__parked", true]), builder),
        limit: () => Promise.resolve({ data: rows(), error: null }),
        maybeSingle: () => Promise.resolve({ data: { goal_graph: h.run.goal_graph }, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/services/agents/conductor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conductor")>();
  return {
    ...actual,
    conductorTick: (...a: Parameters<typeof actual.conductorTick>) =>
      h.useReal ? actual.conductorTick(...a) : h.tick(...a),
  };
});

vi.mock("@/services/agents/conductor-driver", () => ({
  realConductorTickDeps: h.driverDeps,
  isConductorEnabled: async () => true,
  resolveConductorRepairEnabled: async () => false,
}));

vi.mock("@/services/agents/continue-build", () => ({
  expireStalePausedBuilds: vi.fn(async () => 0),
  resumeStrandedSiteRepublishes: vi.fn(async () => 0),
}));
vi.mock("@/services/agents/conductor-ledger", () => ({
  appendConductorAction: h.ledger,
  isLoggableTick: () => false,
}));
vi.mock("@/services/agents/conductor-observability", () => ({
  logBuildTick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/agents/cron-stopped", () => ({
  isWorkerCronStopped: () => false,
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
}));
vi.mock("@/services/build/build-live-email", () => ({
  maybeSendBuildLiveEmail: vi.fn(async () => {}),
}));
vi.mock("@/services/build/build-ready-message", () => ({
  postBuildReadyMessage: h.ready,
}));
vi.mock("@/services/sites/preview-check", () => ({
  runPreviewCheck: h.preview,
}));
vi.mock("@/services/sites/site-thumbnail-capture", () => ({
  captureBuildThumbnail: h.thumbnail,
}));


import { conductorTickRequestedFn } from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";

type Handler = (ctx: {
  event?: unknown;
  logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void };
}) => Promise<Record<string, unknown>>;

const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const logger = { error: () => {}, info: () => {}, warn: () => {} };
const kick = { name: "conductor/tick.requested", data: { conductor_run_id: RUN } };

beforeEach(() => {
  vi.setSystemTime(T0);
  h.run = { status: "active", goal_graph: [] };
  h.kind = "build_app";
  h.tick.mockReset();
  h.ready.mockClear();
  h.ledger.mockClear();
  h.preview.mockReset();
  h.preview.mockResolvedValue({ status: "disabled" });

  vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conductor tick starts the preview check", () => {
  it("calls runPreviewCheck once with the tenant and run when a build run completes done, after the ready message", async () => {
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    await eventFn({ event: kick, logger });

    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview).toHaveBeenCalledWith({ tenantId: "tnt", runId: RUN });
    expect(h.ready.mock.invocationCallOrder[0]).toBeLessThan(h.preview.mock.invocationCallOrder[0]);
  });

  it("asks for the site's Artifacts thumbnail with a durable event, one id per run", async () => {
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    await eventFn({ event: kick, logger });
    expect(inngest.send).toHaveBeenCalledWith({ id: `site-thumbnail-${RUN}`, name: "site/thumbnail.requested", data: { tenant_id: "tnt", run_id: RUN } });
  });

  it("a failed thumbnail request never breaks the tick", async () => {
    (inngest.send as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("inngest down"));
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    await eventFn({ event: kick, logger });
    expect(h.ledger).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ action: "completed", final: "failed" }],
    [{ action: "completed", final: "paused" }],
    [{ action: "completed", final: "halted" }],
    [{ action: "waiting", in_flight: 1 }],
    [{ action: "dispatched", node_id: "n" }],
  ])("does not call it on %j", async (result) => {
    h.tick.mockResolvedValue(result);
    await eventFn({ event: kick, logger });

    expect(h.preview).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalledWith(expect.objectContaining({ name: "site/thumbnail.requested" }));
  });

  it.each(["company_goal", "growth_goal", "refine_app"])("does not call it for a %s run that completes done", async (kind) => {
    h.kind = kind;
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    await eventFn({ event: kick, logger });

    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("a rejected preview check does not break the tick: the ledger still records it and nothing goes unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      h.preview.mockRejectedValue(new Error("e2b down"));
      h.tick.mockResolvedValue({ action: "completed", final: "done" });
      const out = await eventFn({ event: kick, logger });
      await new Promise((r) => setTimeout(r, 0));

      expect(h.preview).toHaveBeenCalledTimes(1);
      expect(h.ledger).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(out)).not.toContain("e2b down");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the tick does not wait for the preview check (it can take twenty minutes)", async () => {
    h.preview.mockReturnValue(new Promise(() => undefined));
    h.tick.mockResolvedValue({ action: "completed", final: "done" });
    const out = await Promise.race([
      eventFn({ event: kick, logger }).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("blocked"), 200)),
    ]);

    expect(out).toBe("returned");
    expect(h.ledger).toHaveBeenCalledTimes(1);
  });
});
