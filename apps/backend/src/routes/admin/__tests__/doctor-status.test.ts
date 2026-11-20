
import { describe, it, expect, vi, beforeEach } from "vitest";

const assertStaffMock = vi.fn();
const queryBuilder = {
  select: vi.fn(),
  in: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
};
const fromMock = vi.fn(() => queryBuilder);
const serviceClientMock = vi.fn(() => ({ from: fromMock }));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: (req: unknown) => assertStaffMock(req),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => serviceClientMock(),
}));

import { staffDoctorStatus } from "../doctor-status";

function mkReq(query: Record<string, string> = {}) {
  return { query } as never;
}

function mkRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { json, status } as never as {
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
}

const NOW = "2026-05-24T16:00:00.000Z";

const sampleRows = [
  { level: "info", source: "praxis-doctor.cron", code: "doctor.uptime", message: "process up for 0d 3h", meta: { ms: 10800000 }, created_at: NOW },
  { level: "info", source: "praxis-doctor.cron", code: "doctor.secrets", message: "42 keys expected, all present", meta: { count: 42 }, created_at: NOW },
  { level: "info", source: "praxis-doctor.cron", code: "doctor.db", message: "service-role + anon both reachable", meta: null, created_at: NOW },
  { level: "info", source: "praxis-doctor.cron", code: "doctor.inngest", message: "ping/pong round-trip ok in 5234ms", meta: { ms: 5234 }, created_at: NOW },
  { level: "warn", source: "praxis-doctor.cli", code: "doctor.secrets", message: "stale", meta: { count: 42 }, created_at: "2026-05-24T15:00:00.000Z" },
];

describe("staffDoctorStatus", () => {
  beforeEach(() => {
    assertStaffMock.mockReset();
    queryBuilder.select.mockReset();
    queryBuilder.in.mockReset();
    queryBuilder.order.mockReset();
    queryBuilder.limit.mockReset();
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.in.mockReturnValue(queryBuilder);
    queryBuilder.order.mockReturnValue(queryBuilder);
    queryBuilder.limit.mockReset();
    fromMock.mockClear();
  });

  it("calls assertStaff before any DB work", async () => {
    queryBuilder.limit.mockResolvedValue({ data: [], error: null });
    const res = mkRes();
    await staffDoctorStatus(mkReq(), res as never);
    expect(assertStaffMock).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledOnce();
  });

  it("returns latest-per-check + flat rows", async () => {
    queryBuilder.limit.mockResolvedValue({ data: sampleRows, error: null });
    const res = mkRes();
    await staffDoctorStatus(mkReq(), res as never);

    const body = res.json.mock.calls[0][0];
    expect(body.rows).toHaveLength(5);
    expect(body.latest.uptime).toMatchObject({ code: "doctor.uptime" });
    expect(body.latest.secrets).toMatchObject({
      code: "doctor.secrets",
      ts: NOW,
    });
    expect(body.latest.db).toMatchObject({ code: "doctor.db" });
    expect(body.latest.inngest).toMatchObject({ code: "doctor.inngest" });
  });

  it("clamps limit param (default 24, max 200)", async () => {
    queryBuilder.limit.mockResolvedValue({ data: [], error: null });
    const res = mkRes();
    await staffDoctorStatus(mkReq({ limit: "9999" }), res as never);
    expect(queryBuilder.limit).toHaveBeenCalledWith(200);

    queryBuilder.limit.mockReset();
    queryBuilder.limit.mockResolvedValue({ data: [], error: null });
    await staffDoctorStatus(mkReq({}), res as never);
    expect(queryBuilder.limit).toHaveBeenCalledWith(24);
  });

  it("filters by both doctor sources + the four doctor codes", async () => {
    queryBuilder.limit.mockResolvedValue({ data: [], error: null });
    const res = mkRes();
    await staffDoctorStatus(mkReq(), res as never);
    const sourceCall = queryBuilder.in.mock.calls.find(
      (c: unknown[]) => c[0] === "source",
    );
    const codeCall = queryBuilder.in.mock.calls.find(
      (c: unknown[]) => c[0] === "code",
    );
    expect(sourceCall?.[1]).toEqual(["praxis-doctor.cli", "praxis-doctor.cron"]);
    expect(codeCall?.[1]).toEqual([
      "doctor.uptime",
      "doctor.secrets",
      "doctor.db",
      "doctor.inngest",
    ]);
  });

  it("returns 500 with a structured error on DB failure", async () => {
    queryBuilder.limit.mockResolvedValue({
      data: null,
      error: { message: "connection refused" },
    });
    const res = mkRes();
    await staffDoctorStatus(mkReq(), res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
