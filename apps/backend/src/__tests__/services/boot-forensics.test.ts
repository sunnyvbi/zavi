
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import {
  recordBootForensics,
  recordShutdownSigterm,
  bootStormThreshold,
  bootStormBreakerEnabled,
} from "@/services/agents/boot-forensics";
import { logEvent } from "@/services/logging/logEvent";

const BOOT = "2026-06-10T14:30:00.000Z";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(opts: { prev?: Resp; boots?: Resp }) {
  const calls: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const trace: Record<string, unknown> = {
      table,
      eq: [] as Array<[string, unknown]>,
      gte: [] as Array<[string, unknown]>,
      in: null as null | [string, unknown[]],
      order: null as null | [string, unknown],
      limit: null as null | number,
      select: null as string | null,
    };
    calls.push(trace);
    const b: Record<string, unknown> = {
      select(c: string) {
        trace.select = c;
        return b;
      },
      eq(c: string, v: unknown) {
        (trace.eq as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      gte(c: string, v: unknown) {
        (trace.gte as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      in(c: string, v: unknown[]) {
        trace.in = [c, v];
        return b;
      },
      order(c: string, o: unknown) {
        trace.order = [c, o];
        return b;
      },
      limit(n: number) {
        trace.limit = n;
        return b;
      },
      then(resolve: (r: Resp) => void) {
        let r: Resp;
        if (trace.in) r = opts.prev ?? { data: [], error: null };
        else r = opts.boots ?? { data: [], error: null };
        resolve(r);
      },
    };
    return b;
  }
  return { svc: { from } as never, calls };
}

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ PRAXIS_CONTAINER_ROLE: "canonical", ...over }) as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.mocked(logEvent).mockClear();
});

describe("recordBootForensics: prev_shutdown_clean derivation", () => {
  it("latest forensic row is backend_shutdown_sigterm → clean=true", async () => {
    const { svc } = makeSvc({
      prev: { data: [{ code: "backend_shutdown_sigterm" }], error: null },
    });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.prev_shutdown_clean).toBe(true);
  });

  it("latest forensic row is backend_boot (previous process died undrained) → clean=false", async () => {
    const { svc } = makeSvc({
      prev: { data: [{ code: "backend_boot" }], error: null },
    });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.prev_shutdown_clean).toBe(false);
  });

  it("no prior forensic rows → null (first instrumented boot)", async () => {
    const { svc } = makeSvc({ prev: { data: [], error: null } });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.prev_shutdown_clean).toBeNull();
  });

  it("query error → null (fail-open, never throws)", async () => {
    const { svc } = makeSvc({ prev: { data: null, error: { message: "boom" } } });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.prev_shutdown_clean).toBeNull();
  });

  it("queries are scoped to this container's role (local dev can't pollute canonical)", async () => {
    const { svc, calls } = makeSvc({ prev: { data: [], error: null } });
    await recordBootForensics(BOOT, svc, env());
    for (const c of calls) {
      expect(c.eq).toContainEqual(["meta->>container_role", "canonical"]);
    }
  });
});

describe("recordBootForensics: split hosts keep separate histories", () => {
  it("the worker's storm window and shutdown marker are its own, not the API host's", async () => {
    const { svc, calls } = makeSvc({ prev: { data: [], error: null } });
    const f = await recordBootForensics(BOOT, svc, { ...env(), PRAXIS_ROLE: "worker" });
    expect(f.container_role).toBe("canonical:worker");
    for (const c of calls) {
      expect(c.eq).toContainEqual(["meta->>container_role", "canonical:worker"]);
    }
  });

  it("the clean-shutdown marker carries the same split role", async () => {
    vi.mocked(logEvent).mockClear();
    await recordShutdownSigterm({ ...env(), PRAXIS_ROLE: "api" });
    const call = vi.mocked(logEvent).mock.calls.find((c) => c[0].code === "backend_shutdown_sigterm");
    expect(call![0].meta).toMatchObject({ container_role: "canonical:api" });
  });
});

describe("recordBootForensics: boots_last_10m + storm breaker", () => {
  it("counts prior backend_boot rows in the window + 1 for this boot", async () => {
    const { svc, calls } = makeSvc({
      boots: { data: [{ id: "a" }], error: null },
    });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.boots_last_10m).toBe(2);
    expect(f.storm).toBe(false);
    const bootsCall = calls.find((c) =>
      (c.eq as Array<[string, unknown]>).some(
        ([k, v]) => k === "code" && v === "backend_boot",
      ),
    ) as Record<string, unknown>;
    expect(bootsCall.gte).toContainEqual([
      "created_at",
      "2026-06-10T14:20:00.000Z",
    ]);
  });

  it("3rd boot in 10 min (default threshold) → storm=true + backend_boot_storm logged at error", async () => {
    const { svc } = makeSvc({
      boots: { data: [{ id: "a" }, { id: "b" }], error: null },
    });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.boots_last_10m).toBe(3);
    expect(f.storm).toBe(true);
    const stormLog = vi
      .mocked(logEvent)
      .mock.calls.find(([i]) => i.code === "backend_boot_storm");
    expect(stormLog).toBeDefined();
    expect(stormLog![0].level).toBe("error");
    expect(stormLog![0].source).toBe("boot");
  });

  it("BOOT_STORM_BREAKER=0 disables the breaker (forensics still recorded)", async () => {
    const { svc } = makeSvc({
      boots: { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
    });
    const f = await recordBootForensics(BOOT, svc, env({ BOOT_STORM_BREAKER: "0" }));
    expect(f.boots_last_10m).toBe(4);
    expect(f.storm).toBe(false);
    const bootLog = vi
      .mocked(logEvent)
      .mock.calls.find(([i]) => i.code === "backend_boot");
    expect(bootLog).toBeDefined();
  });

  it("BOOT_STORM_THRESHOLD overrides the default", async () => {
    const { svc } = makeSvc({
      boots: { data: [{ id: "a" }, { id: "b" }], error: null },
    });
    const f = await recordBootForensics(BOOT, svc, env({ BOOT_STORM_THRESHOLD: "5" }));
    expect(f.storm).toBe(false);
  });

  it("boots query error fails open: boots_last_10m=1, no storm", async () => {
    const { svc } = makeSvc({
      boots: { data: null, error: { message: "boom" } },
    });
    const f = await recordBootForensics(BOOT, svc, env());
    expect(f.boots_last_10m).toBe(1);
    expect(f.storm).toBe(false);
  });
});

describe("recordBootForensics: backend_boot forensic row", () => {
  it("logs backend_boot with role + prev_shutdown_clean (0/1) + boots_last_10m", async () => {
    const { svc } = makeSvc({
      prev: { data: [{ code: "backend_shutdown_sigterm" }], error: null },
      boots: { data: [{ id: "a" }], error: null },
    });
    await recordBootForensics(BOOT, svc, env());
    const bootLog = vi
      .mocked(logEvent)
      .mock.calls.find(([i]) => i.code === "backend_boot");
    expect(bootLog).toBeDefined();
    expect(bootLog![0].source).toBe("boot");
    expect(bootLog![0].meta).toMatchObject({
      container_role: "canonical",
      prev_shutdown_clean: 1,
      boots_last_10m: 2,
    });
  });

  it("prev_shutdown_clean=null is OMITTED from meta (not coerced to a number)", async () => {
    const { svc } = makeSvc({ prev: { data: [], error: null } });
    await recordBootForensics(BOOT, svc, env());
    const bootLog = vi
      .mocked(logEvent)
      .mock.calls.find(([i]) => i.code === "backend_boot");
    expect(bootLog![0].meta).not.toHaveProperty("prev_shutdown_clean");
  });

  it("unset role records as 'unknown' (local dev)", async () => {
    const { svc } = makeSvc({});
    const f = await recordBootForensics(BOOT, svc, {} as NodeJS.ProcessEnv);
    expect(f.container_role).toBe("unknown");
  });
});

describe("recordShutdownSigterm", () => {
  it("logs the clean-drain marker with the container role", async () => {
    await recordShutdownSigterm(env());
    const call = vi
      .mocked(logEvent)
      .mock.calls.find(([i]) => i.code === "backend_shutdown_sigterm");
    expect(call).toBeDefined();
    expect(call![0].source).toBe("boot");
    expect(call![0].meta).toMatchObject({ container_role: "canonical" });
  });
});

describe("env knobs", () => {
  it("bootStormBreakerEnabled: default on, '0' disables", () => {
    expect(bootStormBreakerEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      bootStormBreakerEnabled({ BOOT_STORM_BREAKER: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      bootStormBreakerEnabled({ BOOT_STORM_BREAKER: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("bootStormThreshold: default 3, env override, garbage falls back", () => {
    expect(bootStormThreshold({} as NodeJS.ProcessEnv)).toBe(3);
    expect(
      bootStormThreshold({ BOOT_STORM_THRESHOLD: "5" } as NodeJS.ProcessEnv),
    ).toBe(5);
    expect(
      bootStormThreshold({ BOOT_STORM_THRESHOLD: "garbage" } as NodeJS.ProcessEnv),
    ).toBe(3);
    expect(
      bootStormThreshold({ BOOT_STORM_THRESHOLD: "0" } as NodeJS.ProcessEnv),
    ).toBe(3);
  });
});
