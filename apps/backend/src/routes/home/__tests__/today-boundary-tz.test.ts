
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const FROZEN = new Date("2026-09-07T01:30:00.000Z");
const PACIFIC_DAY_START = "2026-09-06T07:00:00.000Z";
const UTC_DAY_START = "2026-09-07T00:00:00.000Z";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  verifyBearer: vi.fn(),
  getTenantDisabledSlugs: vi.fn(),
  tenantTimezone: { value: null as string | null },
  gteCalls: [] as Array<{ table: string; col: string; val: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: mocks.verifyBearer }));
vi.mock("@/services/agents/visibility", () => ({
  getTenantDisabledSlugs: mocks.getTenantDisabledSlugs,
}));
vi.mock("../../../../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/agents/credits", () => ({
  creditsEnforcedFromBlob: () => false,
  creditAllowanceFor: () => 0,
  freeDailyCreditsFromBlob: () => 5000,
  FREE_DAILY_CREDITS_SQL_FALLBACK: 2000,
}));

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.eq = chain;
  b.lte = chain;
  b.in = chain;
  b.is = chain;
  b.neq = chain;
  b.order = chain;
  b.limit = chain;
  b.gte = (col: string, val: unknown) => {
    mocks.gteCalls.push({ table, col, val });
    return b;
  };
  b.maybeSingle = async () => ({
    data:
      table === "profiles"
        ? { active_tenant_id: "t-1" }
        : table === "tenants"
          ? { credits_unlimited: false, timezone: mocks.tenantTimezone.value }
          : null,
    error: null,
  });
  b.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: [], count: 0, error: null });
  return b;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: (t: string) => makeBuilder(t) }),
  serviceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

import { homeSummary } from "../summary";
import { workspaceStatusCounters } from "@/routes/workspace/status-counters";
import { tenantDayStartIso } from "@/services/tenants/local-day";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as import("express").Response & { statusCode: number };
}

const req = {
  body: {},
  headers: { authorization: "Bearer tok" },
} as unknown as import("express").Request;

function startedAtBound(): string {
  const hit = mocks.gteCalls.find(
    (c) => c.table === "agent_runs" && c.col === "started_at",
  );
  return String(hit?.val ?? "");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN);
  mocks.gteCalls.length = 0;
  mocks.tenantTimezone.value = null;
  mocks.verifyBearer.mockResolvedValue({ user_id: "u1", access_token: "tok" });
  mocks.requireAuth.mockResolvedValue({
    user_id: "u1",
    tenant_id: "t-1",
    access_token: "tok",
  });
  mocks.getTenantDisabledSlugs.mockResolvedValue(new Set<string>());
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ["home/summary", async () => void (await homeSummary(req, mockRes()))],
  [
    "workspace/status-counters",
    async () => void (await workspaceStatusCounters(req, mockRes())),
  ],
])('%s — "today" is the tenant\'s day', (_name, run) => {
  it("uses the tenant's local midnight, not UTC midnight", async () => {
    mocks.tenantTimezone.value = "America/Los_Angeles";
    await run();
    expect(startedAtBound()).toBe(PACIFIC_DAY_START);
    expect(startedAtBound()).not.toBe(UTC_DAY_START);
    expect(tenantDayStartIso("America/Los_Angeles")).toBe(PACIFIC_DAY_START);
  });

  it("an evening-Pacific viewer still sees this morning's runs", async () => {
    mocks.tenantTimezone.value = "America/Los_Angeles";
    await run();
    const boundMs = Date.parse(startedAtBound());
    const morningRun = Date.parse("2026-09-06T16:00:00.000Z");
    expect(morningRun).toBeGreaterThanOrEqual(boundMs);
    expect(morningRun).toBeLessThan(Date.parse(UTC_DAY_START));
  });

  it("a far-east tenant (UTC+14) gets a different boundary than a far-west one (UTC-11)", async () => {
    mocks.tenantTimezone.value = "Pacific/Kiritimati";
    await run();
    const east = startedAtBound();
    mocks.gteCalls.length = 0;
    mocks.tenantTimezone.value = "Pacific/Niue";
    await run();
    const west = startedAtBound();
    expect(east).toBe("2026-09-06T10:00:00.000Z");
    expect(west).toBe("2026-09-06T11:00:00.000Z");
    expect(Date.parse(east)).toBeLessThan(Date.parse(west));
    for (const b of [east, west]) expect(b).not.toBe(UTC_DAY_START);
  });

  it("no timezone on the tenant row → the old UTC boundary, never a throw", async () => {
    mocks.tenantTimezone.value = null;
    await run();
    expect(startedAtBound()).toBe(UTC_DAY_START);
  });
});
