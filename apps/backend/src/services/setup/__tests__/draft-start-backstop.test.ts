import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  today: null as null | { status: string; payload: unknown },
  latest: null as null | { status: string; payload: unknown; day: string; updated_at: string } | "throw",
  enqueued: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/routes/workspace/growth-intake-research", () => ({
  readTodaysResearch: async () => h.today,
  readLatestResearchStrict: async () => {
    if (h.latest === "throw") throw new Error("read down");
    return h.latest;
  },
  isIntakeResearchEnabled: async () => true,
}));
vi.mock("@/routes/workspace/growth-strategy-draft", () => ({
  researchIsSettled: (s: string | null | undefined) => !!s && s !== "pending",
  researchForDraft: (row: { status: string } | null) => (row ? { from: row.status } : null),
}));
vi.mock("@/services/growth/interview", () => ({ interviewPairs: () => [] }));
vi.mock("@/routes/workspace/growth-interview", () => ({ readNote: async () => ({ metadata: {} }) }));
vi.mock("@/services/growth/setup-draft", () => ({ pastWorkForDraft: async () => [], setupDraftKey: () => "k" }));
vi.mock("@/services/knowledge-import/run-read", () => ({ anyImportReadOpen: async () => false }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: async (a: Record<string, unknown>) => {
    h.enqueued.push(a);
    return { run_id: "run-1" };
  },
}));

import { BACKSTOP_PENDING_WAIT_MS, backstopResearch, startSetupDraftAttempt } from "../draft-start";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

beforeEach(() => {
  h.today = null;
  h.latest = null;
  h.enqueued = [];
});

describe("startSetupDraftAttempt research wait", () => {
  it("page path: no research row today still waits (unchanged)", async () => {
    expect(await startSetupDraftAttempt(T, { attempt: 1 }, {} as never)).toEqual({ retry: true });
    expect(h.enqueued).toEqual([]);
  });

  const row = (status: string, minAgo: number, day = "2026-10-20") => ({
    status,
    payload: {},
    day,
    updated_at: new Date(Date.now() - minAgo * 60_000).toISOString(),
  });

  it("backstop: uses the setup day's settled research when today has none", async () => {
    h.latest = row("ready", 60 * 24 * 9);
    expect(await startSetupDraftAttempt(T, { attempt: 1, backstop: true }, {} as never)).toEqual({ status: "queued", run_id: "run-1" });
    expect((h.enqueued[0]!.payload as Record<string, unknown>).research).toEqual({ from: "ready" });
  });

  it("backstop: no research at all, or a dead pending pass, drafts without research", async () => {
    expect(await startSetupDraftAttempt(T, { attempt: 1, backstop: true }, {} as never)).toMatchObject({ status: "queued" });
    h.latest = row("pending", 60);
    expect(await startSetupDraftAttempt(T, { attempt: 2, backstop: true }, {} as never)).toMatchObject({ status: "queued" });
    for (const e of h.enqueued) expect((e.payload as Record<string, unknown>).research).toBeUndefined();
  });

  it("backstop: a pass still running (touched in 15 min, also across midnight) waits; an unreadable read waits", async () => {
    h.latest = row("pending", 3);
    expect(await startSetupDraftAttempt(T, { attempt: 1, backstop: true }, {} as never)).toEqual({ retry: true });
    h.latest = "throw";
    expect(await startSetupDraftAttempt(T, { attempt: 1, backstop: true }, {} as never)).toEqual({ retry: true });
    expect(h.enqueued).toEqual([]);
  });

  it("backstopResearch decides from status and last touch only", () => {
    const now = Date.parse("2026-10-30T00:05:00Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(backstopResearch(null, now)).toBeNull();
    expect(backstopResearch({ status: "thin", day: "2026-10-14", updated_at: at(9e9) }, now)).toMatchObject({ status: "thin" });
    expect(backstopResearch({ status: "pending", day: "2026-10-29", updated_at: at(60_000) }, now)).toBe("wait");
    expect(backstopResearch({ status: "pending", day: "2026-10-30", updated_at: at(BACKSTOP_PENDING_WAIT_MS + 1) }, now)).toBeNull();
    expect(backstopResearch({ status: "pending", day: "2026-10-30", updated_at: "garbage" }, now)).toBe("wait");
  });
});
