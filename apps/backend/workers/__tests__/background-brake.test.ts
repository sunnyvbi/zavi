import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const disabled = vi.hoisted(() => ({ isTenantDisabled: vi.fn(async (_t: string, _m?: string) => false) }));
vi.mock("@/services/tenants/disabled", () => disabled);

import {
  isBackgroundPaused, withBackgroundBrake, withSharedCronCap, SCHEDULED_EVENT, CRON_DEFAULT_RETRIES,
  BACKGROUND_CRON_CONCURRENCY, BACKGROUND_CRON_KEY, TENANT_DISABLED_EXEMPT,
} from "../background-brake";

const noFile = join(tmpdir(), "praxis-brake-test-absent");

function fakeClient() {
  const calls: Array<{ opts: Record<string, unknown>; trigger: unknown; handler: (ctx: unknown) => unknown }> = [];
  const client = {
    createFunction: (opts: Record<string, unknown>, trigger: unknown, handler: (ctx: unknown) => unknown) => {
      calls.push({ opts, trigger, handler });
      return { opts };
    },
  };
  return { client: withBackgroundBrake(client), calls };
}

afterEach(() => {
  delete process.env.PRAXIS_BACKGROUND_PAUSED;
  delete process.env.PRAXIS_BACKGROUND_PAUSE_FILE;
});

describe("isBackgroundPaused", () => {
  it("is off by default, on by env or by file", () => {
    expect(isBackgroundPaused({ PRAXIS_BACKGROUND_PAUSE_FILE: noFile })).toBe(false);
    expect(isBackgroundPaused({ PRAXIS_BACKGROUND_PAUSED: "1", PRAXIS_BACKGROUND_PAUSE_FILE: noFile })).toBe(true);
    const f = join(mkdtempSync(join(tmpdir(), "brake-")), "paused");
    writeFileSync(f, "");
    expect(isBackgroundPaused({ PRAXIS_BACKGROUND_PAUSE_FILE: f })).toBe(true);
  });
});

describe("withBackgroundBrake", () => {
  it("skips a cron-fired run while paused and runs it otherwise", async () => {
    const { client, calls } = fakeClient();
    const inner = vi.fn(() => "ran");
    client.createFunction({ id: "x" }, { cron: "* * * * *" }, inner);
    const h = calls[0]!.handler;
    process.env.PRAXIS_BACKGROUND_PAUSE_FILE = noFile;
    expect(await h({ event: { name: SCHEDULED_EVENT } })).toBe("ran");
    process.env.PRAXIS_BACKGROUND_PAUSED = "1";
    expect(await h({ event: { name: SCHEDULED_EVENT } })).toEqual({ skipped: "background_paused" });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("never pauses event-triggered runs, even of a cron+event function", async () => {
    const { client, calls } = fakeClient();
    const inner = vi.fn(() => "ran");
    client.createFunction({ id: "x" }, [{ cron: "* * * * *" }, { event: "a/b" }], inner);
    process.env.PRAXIS_BACKGROUND_PAUSED = "1";
    expect(await calls[0]!.handler({ event: { name: "a/b" } })).toBe("ran");
  });

  it("pure crons default to fewer retries; explicit retries and event functions are untouched", () => {
    const { client, calls } = fakeClient();
    const h = () => null;
    client.createFunction({ id: "a" }, { cron: "* * * * *" }, h);
    client.createFunction({ id: "b", retries: 3 }, { cron: "* * * * *" }, h);
    client.createFunction({ id: "c" }, [{ cron: "* * * * *" }, { event: "x" }], h);
    client.createFunction({ id: "d" }, { event: "x" }, h);
    client.createFunction({ id: "e" }, { cron: "0 9 * * 1" }, h);
    client.createFunction({ id: "f" }, { cron: "TZ=America/Los_Angeles 30 9 * * *" }, h);
    client.createFunction({ id: "g" }, { cron: "*/2 * * * *" }, h);
    expect(calls.map((c) => c.opts.retries)).toEqual([
      CRON_DEFAULT_RETRIES, 3, undefined, undefined, undefined, undefined, CRON_DEFAULT_RETRIES,
    ]);
  });
});

describe("disabled-tenant skip", () => {
  afterEach(() => {
    disabled.isTenantDisabled.mockReset().mockResolvedValue(false);
  });

  it("skips an event for a disabled tenant, runs it for an active one, fail-open", async () => {
    const { client, calls } = fakeClient();
    const inner = vi.fn(() => "ran");
    client.createFunction({ id: "x" }, { event: "a/b" }, inner);
    const h = calls[0]!.handler;
    disabled.isTenantDisabled.mockImplementation(async (t: string) => t === "dead");
    expect(await h({ event: { name: "a/b", data: { tenant_id: "dead" } } })).toEqual({ skipped: "tenant_disabled" });
    expect(await h({ event: { name: "a/b", data: { tenant_id: "live" } } })).toBe("ran");
    expect(disabled.isTenantDisabled).toHaveBeenCalledWith("dead", "open");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("never reads the flag for an event without a string tenant_id (crons included)", async () => {
    const { client, calls } = fakeClient();
    client.createFunction({ id: "x" }, { cron: "* * * * *" }, () => "ran");
    process.env.PRAXIS_BACKGROUND_PAUSE_FILE = noFile;
    const h = calls[0]!.handler;
    expect(await h({ event: { name: SCHEDULED_EVENT } })).toBe("ran");
    expect(await h({ event: { name: "a/b", data: { tenant_id: 42 } } })).toBe("ran");
    expect(await h({})).toBe("ran");
    expect(disabled.isTenantDisabled).not.toHaveBeenCalled();
  });

  it("exempt functions (credit refunds, forget requests) still run for a disabled tenant", async () => {
    const { client, calls } = fakeClient();
    const id = [...TENANT_DISABLED_EXEMPT][0]!;
    client.createFunction({ id }, { event: "agent.run.failed" }, () => "ran");
    disabled.isTenantDisabled.mockResolvedValue(true);
    expect(await calls[0]!.handler({ event: { name: "agent.run.failed", data: { tenant_id: "dead" } } })).toBe("ran");
  });
});

describe("every worker uses the braked client", () => {
  it("nothing constructs its own Inngest client and the shared one is wrapped", () => {
    const fnDir = join(__dirname, "../functions");
    const offenders = readdirSync(fnDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /new Inngest\(/.test(readFileSync(join(fnDir, f), "utf8")));
    expect(offenders).toEqual([]);
    const client = readFileSync(join(__dirname, "../client.ts"), "utf8");
    expect(client).toMatch(/export const inngest = withBackgroundBrake\(\s*new Inngest\(/);
  });
});

describe("shared cron concurrency cap", () => {
  const cap = { scope: "env", key: BACKGROUND_CRON_KEY, limit: BACKGROUND_CRON_CONCURRENCY };
  it("adds the cap next to a function's own limit in every shape", () => {
    expect(withSharedCronCap(undefined)).toEqual([cap]);
    expect(withSharedCronCap(1)).toEqual([{ limit: 1 }, cap]);
    expect(withSharedCronCap({ limit: 1, key: "event.data.tenant_id" })).toEqual([{ limit: 1, key: "event.data.tenant_id" }, cap]);
  });
  it("leaves a function that already uses both Inngest constraint slots alone", () => {
    const two = [{ limit: 1 }, { limit: 5, key: "x" }];
    expect(withSharedCronCap(two)).toBe(two);
  });
  it("applies to pure crons only", () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = withBackgroundBrake({
      createFunction: (opts: Record<string, unknown>, _trigger: unknown, _handler: unknown) => { calls.push(opts); return {}; },
    });
    const h = () => null;
    client.createFunction({ id: "a" }, { cron: "0 9 * * 1" }, h);
    client.createFunction({ id: "b" }, [{ cron: "* * * * *" }, { event: "x" }], h);
    client.createFunction({ id: "c" }, { event: "x" }, h);
    expect(calls[0]!.concurrency).toEqual([cap]);
    expect(calls[1]!.concurrency).toBeUndefined();
    expect(calls[2]!.concurrency).toBeUndefined();
  });
});
