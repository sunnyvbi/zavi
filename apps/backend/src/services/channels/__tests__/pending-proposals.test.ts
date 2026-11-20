import { describe, it, expect, vi } from "vitest";

const recent = new Date().toISOString();
const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

const RUNS = [
  { id: "r-gads", agent_slug: "google_ads" },
  { id: "r-yt", agent_slug: "youtube_ads" },
  { id: "r-email", agent_slug: "email_marketing" },
];

const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const sentEmitted = new Date(Date.parse(sentAt) - 2 * 60 * 1000).toISOString();
const openEmitted = new Date(Date.parse(sentAt) + 3 * 60 * 1000).toISOString();
const queuedEmitted = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const EMAIL_DECISIONS = [
  { id: "e-sent", agent_run_id: "r-email", decision_class: "bulk_outbound.send", status: "acted", approved_by: "u-owner", body: { list_name: "QA list" }, emitted_at: sentEmitted, dispatched_at: sentAt },
  { id: "e-open", agent_run_id: "r-email", decision_class: "bulk_outbound.send", status: "proposed", approved_by: null, body: { list_name: "QA list" }, emitted_at: openEmitted, dispatched_at: null },
  { id: "e-queued", agent_run_id: "r-email", decision_class: "bulk_outbound.send", status: "proposed", approved_by: "u-owner", body: { list_name: "QA list" }, emitted_at: queuedEmitted, dispatched_at: queuedEmitted },
  { id: "e-rejected", agent_run_id: "r-email", decision_class: "bulk_outbound.send", status: "rejected", approved_by: null, body: { list_name: "QA list" }, emitted_at: queuedEmitted, dispatched_at: null },
];
const DECISIONS = [
  { id: "d1", agent_run_id: "r-gads", decision_class: "google_ads.add_keywords", status: "proposed", body: { name: "Search" }, emitted_at: recent, dispatched_at: null },
  { id: "d2", agent_run_id: "r-yt", decision_class: "google_ads.update_campaign_budget_review", status: "proposed", body: { name: "Video" }, emitted_at: recent, dispatched_at: null },
  { id: "d3", agent_run_id: "r-gads", decision_class: "channel.recipe_step", status: "proposed", body: {}, emitted_at: recent, dispatched_at: null },
  { id: "d4", agent_run_id: null, decision_class: "google_ads.update_campaign_budget_review", status: "acted", body: { name: "Manual edit" }, emitted_at: recent, dispatched_at: recent },
  { id: "d5", agent_run_id: "r-gads", decision_class: "google_ads.update_campaign_budget", status: "acted", body: { name: "Old raise" }, emitted_at: old, dispatched_at: old },
  { id: "d6", agent_run_id: "r-gads", decision_class: "google_ads.set_status", status: "rejected", body: { name: "Rejected" }, emitted_at: recent, dispatched_at: null },
  { id: "d7", agent_run_id: "r-gads", decision_class: "google_ads.update_campaign_budget", status: "proposed", approved_by: "u-owner", body: { name: "Approved raise" }, emitted_at: recent, dispatched_at: null },
  ...EMAIL_DECISIONS,
];

const ACTIONS = [
  { id: "a1", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.update_campaign_budget_review", status: "pending", exec_status: null, exec_payload: { name: "YT pending raise" }, proposed_at: recent, executed_at: null },
  { id: "a2", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.set_status", status: "pending", exec_status: "dispatching", exec_payload: { name: "YT pause in flight" }, proposed_at: recent, executed_at: null },
  { id: "a3", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.update_campaign_budget", status: "acted", exec_status: "executed", exec_payload: { name: "YT raise applied" }, proposed_at: recent, executed_at: recent },
  { id: "a4", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.set_status", status: "rejected", exec_status: null, exec_payload: { name: "YT rejected" }, proposed_at: recent, executed_at: null },
  { id: "a5", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.set_status", status: "pending", exec_status: "failed", exec_payload: { name: "YT failed, still open" }, proposed_at: recent, executed_at: null },
  ...Array.from({ length: 25 }, (_, i) => ({ id: `dead-${i}`, run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.set_status", status: "rejected", exec_status: null, exec_payload: { name: `dead ${i}` }, proposed_at: new Date(Date.now() + 60_000 + i).toISOString(), executed_at: null })),
  { id: "a7", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: "google_ads.update_campaign_budget", status: "pending", exec_status: null, exec_payload: { name: "YT old pending, under the dead" }, proposed_at: old, executed_at: null },
  { id: "ca-open", run_id: "r-email", channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send", status: "pending", exec_status: null, exec_payload: { list_name: "Tool list" }, proposed_at: recent, executed_at: null },
  { id: "ca-queued", run_id: "r-email", channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send", status: "pending", exec_status: "queued", exec_payload: { list_name: "Tool list" }, proposed_at: recent, executed_at: null },
  { id: "ca-failed", run_id: "r-email", channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send", status: "pending", exec_status: "failed", exec_payload: { list_name: "Tool list" }, proposed_at: recent, executed_at: null },
  { id: "a6", run_id: "r-yt", channel_slug: "youtube_ads", exec_class: null, status: "pending", exec_status: null, exec_payload: null, proposed_at: recent, executed_at: null },
];

function chain(rows: Array<Record<string, unknown>>) {
  let out = rows;
  let cols: string[] | null = null;
  const q: Record<string, unknown> = {
    select: (c: string) => ((cols = c.split(",").map((x) => x.trim())), q),
    eq: (c: string, v: unknown) => ((out = out.filter((r) => r[c] === v)), q),
    in: (c: string, v: unknown[]) => ((out = out.filter((r) => v.includes(r[c]))), q),
    like: (c: string, pat: string) => ((out = out.filter((r) => String(r[c]).startsWith(pat.replace("%", "")))), q),
    not: (c: string, op: string, pat: string | null) =>
      ((out = op === "is" && pat === null
        ? out.filter((r) => r[c] !== null && r[c] !== undefined)
        : out.filter((r) => !String(r[c]).startsWith(String(pat).replace("%", "")))),
      q),
    gte: () => q,
    or: (expr: string) => {
      if (expr.includes("exec_status")) {
        const since = expr.match(/executed_at\.gte\.([^)]+)\)/)?.[1] ?? "";
        out = out.filter(
          (r) =>
            r.status === "pending" ||
            r.status === "snoozed" ||
            r.exec_status === "queued" ||
            r.exec_status === "dispatching" ||
            (r.exec_status === "executed" && String(r.executed_at) >= since),
        );
        return q;
      }
      const since = expr.match(/emitted_at\.gte\.([^)]+)\)/)?.[1] ?? "";
      out = out.filter((r) => r.status === "proposed" || (r.status === "acted" && String(r.emitted_at) >= since));
      return q;
    },
    order: (c: string) => ((out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? 1 : -1))), q),
    limit: (n: number) =>
      Promise.resolve({
        data: out.slice(0, n).map((r) => (cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : r)),
        error: null,
      }),
  };
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: (t: string) =>
      chain(t === "agent_runs" ? RUNS : t === "channel_actions" ? ACTIONS : DECISIONS),
  }),
}));

import { readPendingProposals } from "../engine";

const names = async (executor: string) => (await readPendingProposals("t", executor)).map((p) => p.name).sort();

describe("readPendingProposals", () => {
  it("youtube_ads sees its own google_ads.* proposals, on BOTH stores", async () => {
    const got = await names("youtube_ads");
    expect(got).toEqual(
      expect.arrayContaining(["Video", "YT pause in flight", "YT pending raise", "YT raise applied"]),
    );
  });

  it("still reports an OLD pending row under twenty newer dead ones", async () => {
    expect(await names("youtube_ads")).toContain("YT old pending, under the dead");
  });

  it("google_ads sees youtube_ads' pending exec rows on the shared account", async () => {
    const got = await names("google_ads");
    expect(got).toContain("YT pending raise");
    expect(got).toContain("YT pause in flight");
  });

  it("counts an APPROVED exec row still on its way to the account as pending", async () => {
    const byName = Object.fromEntries(
      (await readPendingProposals("t", "youtube_ads")).map((p) => [p.name, p.state]),
    );
    expect(byName["YT pause in flight"]).toBe("pending");
    expect(byName["YT pending raise"]).toBe("pending");
    expect(byName["YT raise applied"]).toBe("applied");
  });

  it("leaves out a rejected exec row and a plain recipe step", async () => {
    const got = await names("youtube_ads");
    expect(got).not.toContain("YT rejected");
    expect(got).not.toContain(null);
  });

  it("keeps a FAILED execution on the list as pending, because the card is still open", async () => {
    const byName = Object.fromEntries(
      (await readPendingProposals("t", "youtube_ads")).map((p) => [p.name, p.state]),
    );
    expect(byName["YT failed, still open"]).toBe("pending");
  });

  it("google_ads also sees a founder's manual edit and changes already applied this week", async () => {
    expect(await names("google_ads")).toEqual([
      "Approved raise",
      "Manual edit",
      "Search",
      "Video",
      "YT failed, still open",
      "YT old pending, under the dead",
      "YT pause in flight",
      "YT pending raise",
      "YT raise applied",
    ]);
  });

  it("drops manual recipe steps, rejected rows and changes applied more than a week ago", async () => {
    const got = await names("google_ads");
    expect(got).not.toContain("Old raise");
    expect(got).not.toContain("Rejected");
    expect((await readPendingProposals("t", "google_ads")).every((p) => !p.decision_class.startsWith("channel."))).toBe(true);
  });

  it("labels applied vs pending", async () => {
    const byName = Object.fromEntries((await readPendingProposals("t", "google_ads")).map((p) => [p.name, p.state]));
    expect(byName["Manual edit"]).toBe("applied");
    expect(byName["Search"]).toBe("pending");
  });
});

describe("readPendingProposals for email_marketing bulk sends", () => {
  const byId = async () => Object.fromEntries((await readPendingProposals("t", "email_marketing")).map((p) => [p.id, p]));

  it("reports a sent card as applied with the time it went out, never as pending", async () => {
    const got = await byId();
    expect(got["e-sent"]).toMatchObject({ state: "applied", applied_at: sentAt, emitted_at: sentEmitted, name: "QA list" });
  });

  it("reports only the card nobody has approved as pending", async () => {
    const got = await byId();
    const pending = Object.values(got).filter((p) => p.id.startsWith("e-") && p.state === "pending").map((p) => p.id);
    expect(pending).toEqual(["e-open"]);
    expect(got["e-open"].applied_at).toBeNull();
  });

  it("reports an approved card that has not gone out as approved, not as awaiting approval", async () => {
    const got = await byId();
    expect(got["e-queued"]).toMatchObject({ state: "approved", applied_at: null });
  });

  it("does the same for a tool-route email card on channel_actions; a failed one is awaiting approval again", async () => {
    const got = await byId();
    expect(got["ca-queued"]).toMatchObject({ state: "approved", applied_at: null });
    expect(got["ca-open"]).toMatchObject({ state: "pending" });
    expect(got["ca-failed"]).toMatchObject({ state: "pending" });
  });

  it("tells two cards from the same day and list apart by id, and drops a rejected one", async () => {
    const got = await byId();
    expect(Object.keys(got).filter((k) => k.startsWith("e-")).sort()).toEqual(["e-open", "e-queued", "e-sent"]);
  });

  it("keeps an approved ad change that has not applied as pending, so the ads prompt never proposes it again", async () => {
    const byName = Object.fromEntries((await readPendingProposals("t", "google_ads")).map((p) => [p.name, p.state]));
    expect(byName["Approved raise"]).toBe("pending");
  });

  it("does not leak another executor's email cards into an ads run", async () => {
    const ids = (await readPendingProposals("t", "google_ads")).map((p) => p.id);
    expect(ids.some((id) => id.startsWith("e-"))).toBe(false);
  });
});
