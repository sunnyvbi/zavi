import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ opsRpc: vi.fn() }));
const inserted = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) }),
}));

import {
  PING_CLAIM_BATCH, PING_LEASE_MS, PING_MAX_BATCHES, PING_POST_WINDOW_MS, TEAM_REPORTS_ADMIN_URL, drainTeamReportPings, teamReportPingText, type PingRow,
} from "../report-pings";
import { logEvent } from "@/services/logging/logEvent";

const row = (id: number, attempts = 1, over: Partial<PingRow> = {}): PingRow => ({
  id, tenant_id: `t${id}`, tenant_slug: `acme-${id}`, agent_slug: "operator", signal: "tool_failure",
  send_count: 1, attempts, window_start: "2026-10-18T10:00:00Z", ...over,
});
const deps = (rows: PingRow[], over: Record<string, unknown> = {}) => ({
  webhook: () => "https://hooks.example/team",
  claim: vi.fn(async () => ({ data: rows, error: null })),
  finish: vi.fn(async () => ({ data: true, error: null })),
  post: vi.fn(async () => ({ ok: true, status: 200 })),
  log: vi.fn(async () => {}),
  ...over,
});

describe("teamReportPingText", () => {
  it("is slug, agent, signal, count and the admin link", () => {
    expect(teamReportPingText({ tenant_slug: "acme", agent_slug: "operator", signal: "looping", send_count: 3 }))
      .toBe(`Founder sent 3 reports to the Zavi team in 10 min. Tenant acme, agent operator, signal looping. <${TEAM_REPORTS_ADMIN_URL}|Open team notes>`);
    expect(teamReportPingText({ tenant_slug: "acme", agent_slug: "pm", signal: "other", send_count: 1 })).toContain("1 report to");
  });

  it("strips Slack control characters, so a field cannot forge a link or mention", () => {
    const t = teamReportPingText({ tenant_slug: "<!channel>", agent_slug: "a|b*", signal: "x_y", send_count: 1 });
    expect(t).not.toMatch(/<!channel>/);
    expect(t).toContain("Tenant !channel");
  });
});

describe("drainTeamReportPings", () => {
  it("posts each due row once and records sent with its attempt as the fencing token", async () => {
    const d = deps([row(1), row(2, 2)]);
    expect(await drainTeamReportPings(d)).toEqual({ claimed: 2, sent: 2, skipped: 0, retried: 0, gave_up: 0, fenced: 0, batches: 1, released: 0 });
    expect(d.post).toHaveBeenCalledTimes(2);
    expect(d.finish).toHaveBeenNthCalledWith(1, 1, 1, "sent", null);
    expect(d.finish).toHaveBeenNthCalledWith(2, 2, 2, "sent", null);
  });

  it("the payload is only the built text: no field of the row beyond the codes", async () => {
    const d = deps([row(1, 1, { send_count: 2 })]);
    await drainTeamReportPings(d);
    expect(d.post).toHaveBeenCalledWith("https://hooks.example/team", { text: teamReportPingText(row(1, 1, { send_count: 2 })) });
  });

  it("webhook unset: every due row is skipped, nothing is posted, one info log", async () => {
    const d = deps([row(1), row(2)], { webhook: () => undefined });
    expect(await drainTeamReportPings(d)).toMatchObject({ claimed: 2, skipped: 2, sent: 0 });
    expect(d.post).not.toHaveBeenCalled();
    expect(d.finish).toHaveBeenCalledWith(1, 1, "skipped", null);
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ level: "info", code: "team_report_ping.no_webhook" }));
  });

  it("a failed or thrown POST is a retry (warn), the 6th attempt a give-up (warn); never an error log", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ ok: false, status: 500 });
    const d = deps([row(1), row(2, 3), row(3, 6)], { post });
    expect(await drainTeamReportPings(d)).toMatchObject({ retried: 2, gave_up: 1 });
    expect(d.finish).toHaveBeenNthCalledWith(1, 1, 1, "retry", "http_503");
    expect(d.finish).toHaveBeenNthCalledWith(2, 2, 3, "retry", "TimeoutError");
    const levels = d.log.mock.calls.map((c) => (c as unknown as [{ level: string }])[0].level);
    expect(levels).not.toContain("error");
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ code: "team_report_ping.gave_up", level: "warn" }));
  });

  it("a stale fencing token is counted, not overwritten", async () => {
    const d = deps([row(1)], { finish: vi.fn(async () => ({ data: false, error: null })) });
    expect(await drainTeamReportPings(d)).toMatchObject({ fenced: 1, sent: 0 });
  });

  it("nothing due: no webhook read, no post", async () => {
    const webhook = vi.fn(() => "x");
    const d = deps([], { webhook });
    expect(await drainTeamReportPings(d)).toMatchObject({ claimed: 0 });
    expect(webhook).not.toHaveBeenCalled();
  });

  it("a failed claim throws (the cron step logs it)", async () => {
    const d = deps([], { claim: vi.fn(async () => ({ data: null, error: { message: "db down" } })) });
    await expect(drainTeamReportPings(d)).rejects.toThrow("db down");
  });

  it("claims batch after batch until one comes back short", async () => {
    const full = (start: number) => Array.from({ length: PING_CLAIM_BATCH }, (_, i) => row(start + i));
    const claim = vi.fn()
      .mockResolvedValueOnce({ data: full(0), error: null })
      .mockResolvedValueOnce({ data: full(100), error: null })
      .mockResolvedValueOnce({ data: [row(999)], error: null });
    const d = deps([], { claim });
    expect(await drainTeamReportPings(d)).toMatchObject({ claimed: 2 * PING_CLAIM_BATCH + 1, sent: 2 * PING_CLAIM_BATCH + 1, batches: 3 });
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it("stops at PING_MAX_BATCHES per tick, so one tick cannot run away", async () => {
    const claim = vi.fn(async () => ({ data: Array.from({ length: PING_CLAIM_BATCH }, (_, i) => row(i)), error: null }));
    const d = deps([], { claim });
    expect(await drainTeamReportPings(d)).toMatchObject({ batches: PING_MAX_BATCHES });
    expect(claim).toHaveBeenCalledTimes(PING_MAX_BATCHES);
  });

  it("a failed claim after the first batch ends the tick with what was done", async () => {
    const claim = vi.fn()
      .mockResolvedValueOnce({ data: Array.from({ length: PING_CLAIM_BATCH }, (_, i) => row(i)), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "db blip" } });
    const d = deps([], { claim });
    expect(await drainTeamReportPings(d)).toMatchObject({ sent: PING_CLAIM_BATCH, batches: 1 });
  });
});

describe("drainTeamReportPings deadlines (no post outlives the claim's lease)", () => {
  const clocked = (rows: PingRow[], over: Record<string, unknown> = {}) => {
    let t = 0;
    const post = vi.fn(async () => { t += 60_000; return { ok: true, status: 200 }; });
    return deps(rows, { now: () => t, post, ...over });
  };

  it("the post window ends well inside the lease, even for the last 10s post", () => {
    expect(PING_POST_WINDOW_MS + 10_000).toBeLessThan(PING_LEASE_MS);
  });

  it("stops posting once the batch's post window is over and releases the rest, uncounted", async () => {
    const n = PING_POST_WINDOW_MS / 60_000;
    const rows = Array.from({ length: n + 3 }, (_, i) => row(i + 1));
    const d = clocked(rows);
    const out = await drainTeamReportPings(d);
    expect(out).toMatchObject({ sent: n, released: 3 });
    expect(d.post).toHaveBeenCalledTimes(n);
    for (const r of rows.slice(n)) expect(d.finish).toHaveBeenCalledWith(r.id, r.attempts, "release", null);
    expect(d.claim).toHaveBeenCalledTimes(1);
  });

  it("a wall-clock deadline: no post starts after it, no further claim", async () => {
    const d = clocked([row(1), row(2), row(3)]);
    const out = await drainTeamReportPings(d, { deadlineMs: 90_000 });
    expect(out).toMatchObject({ sent: 2, released: 1 });
  });

  it("batchSize and maxBatches are honoured and never exceed the caps", async () => {
    const d = deps([row(1)]);
    await drainTeamReportPings(d, { batchSize: 10, maxBatches: 1 });
    expect(d.claim).toHaveBeenCalledWith(10);
    const big = deps([row(1)]);
    await drainTeamReportPings(big, { batchSize: 500 });
    expect(big.claim).toHaveBeenCalledWith(PING_CLAIM_BATCH);
  });

  it("an already-spent deadline claims nothing at all", async () => {
    const d = clocked([row(1), row(2)], { webhook: () => undefined });
    expect(await drainTeamReportPings(d, { deadlineMs: 0 })).toMatchObject({ claimed: 0 });
  });
});

describe("drainTeamReportPings logs through the real meta allow-list", () => {
  it("keeps the counts and codes, and never carries the webhook URL", async () => {
    inserted.length = 0;
    const url = "https://hooks.slack.com/services/T000/B000/SECRETTOKEN";
    const post = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    await drainTeamReportPings(deps([row(1, 6), row(2, 1)], { webhook: () => url, post, log: logEvent }));
    await drainTeamReportPings(deps([row(3)], { webhook: () => undefined, log: logEvent }));
    await new Promise((r) => setTimeout(r, 0));
    const byCode = Object.fromEntries(inserted.map((r) => [r.code, r]));
    expect(byCode["team_report_ping.gave_up"]).toMatchObject({ level: "warn", meta: { retry_count: 6, error_class: "http_503", http_status: 503 } });
    expect(byCode["team_report_ping.retry"]).toMatchObject({ level: "warn", meta: { count: 1, batch_errors: 0 } });
    expect(byCode["team_report_ping.no_webhook"]).toMatchObject({ level: "info", meta: { count: 1 } });
    expect(JSON.stringify(inserted)).not.toContain("SECRETTOKEN");
    expect(JSON.stringify(inserted)).not.toContain("hooks.slack.com");
  });
});
