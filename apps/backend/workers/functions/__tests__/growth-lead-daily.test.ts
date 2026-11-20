
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const inserted: Array<{ cron_dedupe_key: string | null | undefined }> = [];
const seenKeys = new Set<string>();
const enqueueSpy = vi.fn(
  async (input: { cron_dedupe_key?: string | null }) => {
    const key = input.cron_dedupe_key ?? null;
    if (key !== null && seenKeys.has(key)) {
      return { run_id: "" };
    }
    if (key !== null) seenKeys.add(key);
    inserted.push({ cron_dedupe_key: key });
    return { run_id: `run-${inserted.length}` };
  },
);

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (input: { cron_dedupe_key?: string | null }) => enqueueSpy(input),
}));

vi.mock("@/services/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "order"]) {
    chain[m] = () => chain;
  }
  chain.limit = async () => ({ data: [], error: null });
  return { serviceClient: () => ({ from: () => chain }) };
});

vi.mock("@/services/growth/action-outcomes", () => ({
  getGrowthBetOutcomes: async () => ({ bets: [] }),
}));

import {
  renderFanInBlock,
  renderBetOutcomesBlock,
  fanInOneTenant,
  growthDailyDedupeKey,
  utcDayBucket,
} from "../growth-lead-daily";

beforeAll(() => {
  process.env.PRAXIS_DISABLE_CRON_STOP = "1";
});
afterAll(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

type MemoryNoteRow = Parameters<typeof renderFanInBlock>[0][number];

function makeNote(overrides: Partial<MemoryNoteRow>): MemoryNoteRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: "t-1",
    note_type: "ads_channel_perf",
    title: "Ad perf",
    body_markdown: "short body",
    tags: ["x"],
    source: "agent_run",
    source_ref: "r-1",
    created_at: "2026-05-21T00:00:00.000Z",
    ...overrides,
  } as MemoryNoteRow;
}

describe("renderFanInBlock — truncation marker (Gap #2/#14)", () => {
  it("ads_channel_perf body > 1800 chars → explicit truncation marker naming the id, no bare ellipsis", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const block = renderFanInBlock([
      makeNote({ id, note_type: "ads_channel_perf", body_markdown: "x".repeat(2000) }),
    ]);
    expect(block).toBeDefined();
    expect(block!).toContain(`[row truncated — open note id=${id} for figures]`);
    expect(block!).not.toMatch(/x…/);
  });

  it("note body ≤ excerpt cap → neither the marker nor an ellipsis", () => {
    const block = renderFanInBlock([
      makeNote({ body_markdown: "tiny body under the cut" }),
    ]);
    expect(block).toBeDefined();
    expect(block!).not.toContain("row truncated");
    expect(block!).not.toContain("…");
  });
});

describe("renderFanInBlock — P1-6 ads_channel_perf excerpt fidelity", () => {
  it("ads_channel_perf note 1000 chars → figures past 240 are PRESERVED (not truncated)", () => {
    const body =
      "ROAS table preamble " + "y".repeat(500) + " ROAS=4.2x CAC=$31 spend=$1,240";
    expect(body.length).toBeGreaterThan(240);
    expect(body.length).toBeLessThan(1800);
    const block = renderFanInBlock([
      makeNote({ note_type: "ads_channel_perf", body_markdown: body }),
    ]);
    expect(block).toBeDefined();
    expect(block!).toContain("ROAS=4.2x CAC=$31 spend=$1,240");
    expect(block!).not.toContain("row truncated");
  });

  it("non-ads note keeps the tight 240-char preview (figures past 240 cut)", () => {
    const body = "z".repeat(250) + " HIDDEN_TAIL";
    const block = renderFanInBlock([
      makeNote({ note_type: "social_approved_drafts", body_markdown: body }),
    ]);
    expect(block).toBeDefined();
    expect(block!).not.toContain("HIDDEN_TAIL");
    expect(block!).toContain("row truncated");
  });
});

describe("fanInOneTenant — 06:00 daily double-fire dedupe (cron_dedupe_key)", () => {
  const tenant = { id: "73db45ff-457e-4541-bc8f-bdb625390204", display_name: "UpcarAI" };

  beforeEach(() => {
    inserted.length = 0;
    seenKeys.clear();
    enqueueSpy.mockClear();
  });

  it("builds the dedupe key in the 09:00 `<tenant>:<agent>:<iso-window>` shape", () => {
    const bucket = "2026-07-08T00:00:00.000Z";
    expect(growthDailyDedupeKey(tenant.id, bucket)).toBe(
      `${tenant.id}:growth-lead:${bucket}`,
    );
  });

  it("utcDayBucket floors to the UTC day (never the 09:00 5-min bucket)", () => {
    expect(utcDayBucket(new Date("2026-07-08T06:00:07.123Z"))).toBe(
      "2026-07-08T00:00:00.000Z",
    );
    expect(utcDayBucket(new Date("2026-07-08T06:00:07.123Z"))).not.toBe(
      "2026-07-08T09:00:00.000Z",
    );
  });

  it("same (agent, window) enqueued TWICE collapses to ONE inserted run", async () => {
    const bucket = utcDayBucket(new Date("2026-07-08T06:00:06.000Z"));

    const a = await fanInOneTenant(tenant, bucket);
    const b = await fanInOneTenant(tenant, bucket);

    const expectedKey = `${tenant.id}:growth-lead:${bucket}`;
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    for (const call of enqueueSpy.mock.calls) {
      expect(call[0].cron_dedupe_key).toBe(expectedKey);
    }

    expect(inserted).toHaveLength(1);

    expect(a.enqueued).toBe(true);
    expect(a.run_id).toBeTruthy();
    expect(b.enqueued).toBe(false);
    expect(b.reason).toBe("deduped_same_bucket");
  });

  it("REGRESSION GUARD — a null key would NOT collapse (proves the fix is the key)", async () => {
    inserted.length = 0;
    seenKeys.clear();
    await enqueueSpy({ cron_dedupe_key: null });
    await enqueueSpy({ cron_dedupe_key: null });
    expect(inserted).toHaveLength(2);
  });
});

describe("renderBetOutcomesBlock — P1-4 outcome attribution", () => {
  type Outcome = Parameters<typeof renderBetOutcomesBlock>[0][number];
  const makeOutcome = (o: Partial<Outcome>): Outcome =>
    ({
      bet_decision_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      bet_class: "growth-lead.reallocate-budget",
      bet_claim: "shift $40/wk meta → google",
      bet_emitted_at: "2026-05-20T00:00:00.000Z",
      outcome_decision_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      action_class: "meta_ads.update_ad_set_budget",
      decision_outcome: "approved",
      target_metric: "spend",
      spend_delta: -120.5,
      roas_delta: 0.6,
      measured_at: "2026-06-03T00:00:00.000Z",
      ...o,
    }) as Outcome;

  it("zero measured outcomes → null (block omitted)", () => {
    expect(renderBetOutcomesBlock([])).toBeNull();
  });

  it("one measured outcome → cites bet id + date + measured delta", () => {
    const block = renderBetOutcomesBlock([makeOutcome({})]);
    expect(block).toBeDefined();
    expect(block!).toContain("Measured outcomes of your past EXECUTED bets");
    expect(block!).toContain("bet `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` from 2026-05-20");
    expect(block!).toContain("shift $40/wk meta → google");
    expect(block!).toContain("meta_ads.update_ad_set_budget approved");
    expect(block!).toContain("Δspend -120.5");
    expect(block!).toContain("Δroas +0.6");
    expect(block!).toContain("measured 2026-06-03");
  });

  it("null deltas → 'no numeric delta', never a fabricated zero", () => {
    const block = renderBetOutcomesBlock([
      makeOutcome({ spend_delta: null, roas_delta: null }),
    ]);
    expect(block).toBeDefined();
    expect(block!).toContain("no numeric delta");
    expect(block!).not.toContain("Δspend");
  });
});
