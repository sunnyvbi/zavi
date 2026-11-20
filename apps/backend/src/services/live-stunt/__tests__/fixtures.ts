import { parseLiveRun, type LiveStuntConfig } from "../config";

export function realRun(over: Record<string, unknown> = {}, slug = "upcar"): LiveStuntConfig {
  const c = parseLiveRun(slug, {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    start_at: "2026-10-01T00:00:00-04:00",
    unlock_at: "2026-10-13T09:00:00-04:00",
    end_at: "2026-10-30T23:59:59-04:00",
    budget_usd: 25000,
    goals: { bookings: 600, hosts: 500 },
    public: true,
    ...over,
  });
  if (!c) throw new Error("bad test run");
  return c;
}
