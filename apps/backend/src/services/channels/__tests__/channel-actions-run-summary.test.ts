import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

import { clearFigures, recordFigures } from "@/services/agents/engine/figure-ledger";
import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { recordChannelRunActions, type ScoreContext } from "../channel-actions";

const CTX: ScoreContext = {
  channel_in_plan: true,
  goal_metric_keys: new Set(),
  rejected_title_keys: new Set(),
  rejected_ids: new Set(),
};

const LIST_SUMMARY = { label: "Your list", value: "1,240", unit: "contacts", context: "Your list has 1,240 contacts" };

function envelope(summary: Record<string, unknown>) {
  return {
    rendered_markdown: "Your list has 1,240 contacts and the welcome email is ready.",
    summary,
    steps: [
      { title: "Send the welcome email", body: "b", blocking: false, effort: "minutes", evidence: ["e"], action_type: "fix" },
      { title: "Clean the bounced addresses", body: "b", blocking: false, effort: "minutes", evidence: ["e"], action_type: "fix" },
    ],
  };
}

async function filedBodies(runId: string, summary: Record<string, unknown>, channelSlug = "email_marketing") {
  const rpc = vi.fn(async (_tid: unknown, name: string, _args: Record<string, unknown>) =>
    name === "record_channel_run_actions"
      ? { data: { inserted: 2, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: [] }, error: null }
      : { data: { ok: true }, error: null },
  );
  const env = envelope(summary);
  await recordChannelRunActions(
    { tenantId: "t-1", runId, channelSlug, envelope: env, bodies: stepDecisionBodies(env), redo: null },
    { rpc: rpc as never, loadScoreContext: async () => CTX, displace: vi.fn(async () => 0) as never },
  );
  const call = rpc.mock.calls.find((c) => c[1] === "record_channel_run_actions");
  const actions = (call?.[2] as { p_actions: Array<{ position: number; body: Record<string, unknown> }> }).p_actions;
  return actions.map((a) => a.body);
}

describe("the email run summary is filed only when its figures were read", () => {
  it("drops 'Your list has 1,240 contacts' when the run never read 1240", async () => {
    const run = "run-summary-unread";
    clearFigures(run);
    recordFigures(run, JSON.stringify({ contacts: 312, opens: 48 }));
    const bodies = await filedBodies(run, LIST_SUMMARY);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b.summary).toBeUndefined();
    expect(JSON.stringify(bodies)).not.toContain("1,240 contacts\"");
    expect(bodies[0].rendered_markdown).toBe("Your list has 1,240 contacts and the welcome email is ready.");
    clearFigures(run);
  });

  it("drops a summary whose figure is only in its context sentence", async () => {
    const run = "run-summary-context";
    clearFigures(run);
    recordFigures(run, JSON.stringify({ contacts: 312 }));
    const bodies = await filedBodies(run, { label: "List size", value: "312", context: "up from 1,240 last week" });
    expect(bodies[0].summary).toBeUndefined();
    clearFigures(run);
  });

  it("drops a numeric summary when the run read nothing, as metrics are", async () => {
    const run = "run-summary-empty";
    clearFigures(run);
    const bodies = await filedBodies(run, LIST_SUMMARY);
    expect(bodies[0].summary).toBeUndefined();
  });

  it("keeps the same summary unchanged when the run read 1240", async () => {
    const run = "run-summary-read";
    clearFigures(run);
    recordFigures(run, JSON.stringify({ contacts: "1,240", opens: 48 }));
    const bodies = await filedBodies(run, LIST_SUMMARY);
    expect(bodies[0].summary).toEqual(LIST_SUMMARY);
    expect(bodies[1].summary).toBeUndefined();
    clearFigures(run);
  });

  it("keeps a summary with no numbers, even when the run read nothing", async () => {
    const run = "run-summary-words";
    clearFigures(run);
    const words = { label: "Sending domain", value: "not verified", context: "Add the DNS records before the first send" };
    const bodies = await filedBodies(run, words);
    expect(bodies[0].summary).toEqual(words);
  });

  it("keeps a summary whose only numbers are single digits", async () => {
    const run = "run-summary-small";
    clearFigures(run);
    recordFigures(run, JSON.stringify({ contacts: 312 }));
    const small = { label: "Checks failing", value: "4 of 9", context: "SPF and DKIM are missing" };
    const bodies = await filedBodies(run, small);
    expect(bodies[0].summary).toEqual(small);
    clearFigures(run);
  });

  it("keeps a derived rate, a duration and a year on email even when the run read nothing", async () => {
    const run = "run-summary-derived";
    clearFigures(run);
    const rate = { label: "Open rate", value: "23.4%", context: "Open rate 23.4% over the last 30 days in 2026, last sent Oct 23 (2026-10-23), 24 hours ago" };
    const bodies = await filedBodies(run, rate);
    expect(bodies[0].summary).toEqual(rate);
  });

  it("keeps derived ad figures on email when the only counts were read", async () => {
    const run = "run-summary-derived-read";
    clearFigures(run);
    recordFigures(run, JSON.stringify({ sends: 312 }));
    const cost = { label: "Cost per signup", value: "$41.50", context: "ROAS 1.05x, CTR 2.3%, 12x reach, $120 spent on 312 sends in 7 days" };
    const bodies = await filedBodies(run, cost);
    expect(bodies[0].summary).toEqual(cost);
    clearFigures(run);
  });

  it("still drops an unread count sitting next to exempt figures on email", async () => {
    const run = "run-summary-mixed";
    clearFigures(run);
    recordFigures(run, JSON.stringify({ sends: 312 }));
    const bodies = await filedBodies(run, { label: "Open rate", value: "23.4%", context: "across 1,240 contacts over the last 30 days" });
    expect(bodies[0].summary).toBeUndefined();
    clearFigures(run);
  });

  for (const slug of ["google_ads", "meta_ads"]) {
    it(`keeps a ${slug} summary with ROAS 1.05x and an unread count, as only email is grounded`, async () => {
      const run = `run-summary-${slug}`;
      clearFigures(run);
      recordFigures(run, JSON.stringify({ spend: 41 }));
      const roas = { label: "ROAS", value: "1.05x", context: "1,240 clicks at $0.80 each" };
      const bodies = await filedBodies(run, roas, slug);
      expect(bodies[0].summary).toEqual(roas);
      clearFigures(run);
    });
  }
});
