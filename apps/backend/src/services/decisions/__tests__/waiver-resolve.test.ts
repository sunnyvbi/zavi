
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingleMock: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chain: any = {
  select: vi.fn(() => chain),
  eq: vi.fn(() => chain),
  maybeSingle: mocks.maybeSingleMock,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn(() => chain),
  })),
}));

import { resolveWaiverState } from "../waiver-resolve";

const NOW = Date.parse("2026-05-30T12:00:00Z");

beforeEach(() => {
  mocks.maybeSingleMock.mockReset();
  Object.values(chain).forEach((m) => {
    if ("mockClear" in (m as object)) (m as ReturnType<typeof vi.fn>).mockClear();
  });
});

describe("resolveWaiverState", () => {
  it("no row → state='none'", async () => {
    mocks.maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r).toEqual({ state: "none" });
  });

  it("row with NULL waiver_expires_at → state='none' (no waiver was granted)", async () => {
    mocks.maybeSingleMock.mockResolvedValue({
      data: {
        waiver_expires_at: null,
        waiver_max_daily_usd: null,
        waiver_cooling_off_seconds: 0,
      },
      error: null,
    });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r).toEqual({ state: "none" });
  });

  it("future expires_at → state='active' with the cap and cooling-off propagated", async () => {
    mocks.maybeSingleMock.mockResolvedValue({
      data: {
        waiver_expires_at: new Date(NOW + 60 * 1000).toISOString(),
        waiver_max_daily_usd: 25,
        waiver_cooling_off_seconds: 30,
      },
      error: null,
    });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r.state).toBe("active");
    if (r.state === "active") {
      expect(r.max_daily_usd).toBe(25);
      expect(r.cooling_off_seconds).toBe(30);
    }
  });

  it("supabase numeric → string → coerces cap back to number", async () => {
    mocks.maybeSingleMock.mockResolvedValue({
      data: {
        waiver_expires_at: new Date(NOW + 60 * 1000).toISOString(),
        waiver_max_daily_usd: "12.50",
        waiver_cooling_off_seconds: 0,
      },
      error: null,
    });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    if (r.state !== "active") throw new Error("expected active");
    expect(r.max_daily_usd).toBe(12.5);
  });

  it("past expires_at → state='expired' (defense-in-depth vs late expire cron)", async () => {
    const past = new Date(NOW - 60 * 1000).toISOString();
    mocks.maybeSingleMock.mockResolvedValue({
      data: {
        waiver_expires_at: past,
        waiver_max_daily_usd: 5,
        waiver_cooling_off_seconds: 0,
      },
      error: null,
    });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r).toEqual({ state: "expired", expires_at: past });
  });

  it("malformed expires_at → state='expired' (fail-closed)", async () => {
    mocks.maybeSingleMock.mockResolvedValue({
      data: {
        waiver_expires_at: "not-a-date",
        waiver_max_daily_usd: 5,
        waiver_cooling_off_seconds: 0,
      },
      error: null,
    });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r.state).toBe("expired");
  });

  it("DB error → state='expired' (FAIL-CLOSED — a blip must never auto-fire)", async () => {
    mocks.maybeSingleMock.mockResolvedValue({ data: null, error: { message: "db boom" } });
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r).toEqual({ state: "expired", expires_at: null });
  });

  it("throw during query → state='expired' (FAIL-CLOSED)", async () => {
    mocks.maybeSingleMock.mockRejectedValue(new Error("network down"));
    const r = await resolveWaiverState("t-1", "send_email", NOW);
    expect(r).toEqual({ state: "expired", expires_at: null });
  });

  it("scopes the query by tenant_id + decision_class", async () => {
    mocks.maybeSingleMock.mockResolvedValue({ data: null, error: null });
    await resolveWaiverState("t-99", "post_slack_message", NOW);
    expect(chain.eq).toHaveBeenCalledWith("tenant_id", "t-99");
    expect(chain.eq).toHaveBeenCalledWith("decision_class", "post_slack_message");
  });
});
