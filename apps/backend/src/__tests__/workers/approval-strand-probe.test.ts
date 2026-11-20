
import { describe, it, expect, vi, beforeEach } from "vitest";

const scan = vi.fn();
const tenantScan = vi.fn();
const logEvent = vi.fn(async (_arg: { meta: Record<string, unknown> }) => {});
const alertFn = vi.fn(async (_arg: unknown) => {});
let chatOriginIds: string[] = [];
let notFilter: string[] = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) =>
      table === "tenants"
        ? { select: () => ({ in: () => tenantScan() }) }
        : {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    is: () => ({
                      not: (col: string, op: string, val: string) => {
                        notFilter = [col, op, val];
                        return scan();
                      },
                    }),
                  }),
                }),
              }),
            }),
          },
  }),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (arg: { meta: Record<string, unknown> }) => logEvent(arg),
}));

vi.mock("@/services/logging/alert", () => ({
  alert: (arg: unknown) => alertFn(arg),
}));

let cardIds: "all" | string[] | null = "all";
let channelRunIds: string[] = [];
vi.mock("@/../workers/functions/approval-slack-notify", () => ({
  loadRunTriggers: async (ids: string[]) =>
    new Map(ids.flatMap((i) => (chatOriginIds.includes(i) ? [[i, "chat"]] : channelRunIds.includes(i) ? [[i, "channel_recipe"]] : [])) as Array<[string, string]>),
  loadIdsWithChatCard: async (rows: Array<{ id: string }>) => {
    const ids = rows.map((r) => r.id);
    return cardIds === null ? null : new Set(cardIds === "all" ? ids : ids.filter((i) => (cardIds as string[]).includes(i)));
  },
  loadChatCardEvents: async () => [],
}));

import {
  planChatCardReconcile,
  walkKeyset,
  probeStrandedApprovals,
  buildStrandReport,
  shouldPageStrand,
  renderStrandPage,
  __resetStrandPageMemoForTest,
  type TenantMeta,
} from "@/../workers/functions/approval-strand-probe";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type AlertArg = {
  msg: string;
  email?: { dedupeKey: string; detail?: string; subjectDetail?: string };
};
const lastAlert = () => alertFn.mock.calls.at(-1)?.[0] as AlertArg;

const meta = (...rows: TenantMeta[]) => new Map(rows.map((r) => [r.id, r]));

beforeEach(() => {
  cardIds = "all";
  channelRunIds = [];
  scan.mockReset();
  tenantScan.mockReset();
  tenantScan.mockResolvedValue({ data: [], error: null });
  logEvent.mockReset();
  logEvent.mockResolvedValue(undefined);
  alertFn.mockReset();
  alertFn.mockResolvedValue(undefined);
  chatOriginIds = [];
  __resetStrandPageMemoForTest();
});

describe("probeStrandedApprovals", () => {
  it("counts only rows past the 10-minute grace window", async () => {
    scan.mockResolvedValue({
      data: [
        { tenant_id: "t1", agent_run_id: "r1", emitted_at: iso(20 * 60_000) },
        { tenant_id: "t1", agent_run_id: "r2", emitted_at: iso(11 * 60_000) },
        { tenant_id: "t1", agent_run_id: "r3", emitted_at: iso(2 * 60_000) },
      ],
      error: null,
    });

    const r = await probeStrandedApprovals(NOW);
    expect(r.stranded).toBe(2);
    expect(r.tenants).toBe(1);
  });

  it("EXCLUDES web-chat-origin approvals (null by design, not stranded)", async () => {
    scan.mockResolvedValue({
      data: [
        { id: "d-cron", tenant_id: "t1", agent_run_id: "cron1", emitted_at: iso(30 * 60_000) },
        { id: "d-chat1", tenant_id: "t1", agent_run_id: "chat1", emitted_at: iso(30 * 60_000) },
        { id: "d-chat2", tenant_id: "t1", agent_run_id: "chat2", emitted_at: iso(30 * 60_000) },
      ],
      error: null,
    });
    chatOriginIds = ["chat1", "chat2"];

    const r = await probeStrandedApprovals(NOW);
    expect(r.stranded).toBe(1);
    expect(r.tenants).toBe(1);
  });

  it("bug #7 must-catch: a web-chat approval whose chat card never landed IS stranded (nobody was told)", async () => {
    scan.mockResolvedValue({
      data: [
        { id: "d-chat1", tenant_id: "t1", agent_run_id: "chat1", emitted_at: iso(30 * 60_000) },
        { id: "d-chat2", tenant_id: "t1", agent_run_id: "chat2", emitted_at: iso(30 * 60_000) },
      ],
      error: null,
    });
    chatOriginIds = ["chat1", "chat2"];
    cardIds = ["d-chat1"];
    expect((await probeStrandedApprovals(NOW)).stranded).toBe(1);
    cardIds = null;
    expect((await probeStrandedApprovals(NOW)).stranded).toBe(0);
  });

  it("must-not-touch: a channel run's approval is never stranded, chat card or not (it is worked on its tile)", async () => {
    scan.mockResolvedValue({ data: [{ id: "d-ch", tenant_id: "t1", agent_run_id: "ch1", emitted_at: iso(30 * 60_000) }], error: null });
    channelRunIds = ["ch1"];
    cardIds = [];
    expect((await probeStrandedApprovals(NOW)).stranded).toBe(0);
  });

  it("groups per tenant and logs one row per affected tenant", async () => {
    scan.mockResolvedValue({
      data: [
        { tenant_id: "t1", agent_run_id: "r1", emitted_at: iso(30 * 60_000) },
        { tenant_id: "t1", agent_run_id: "r2", emitted_at: iso(30 * 60_000) },
        { tenant_id: "t2", agent_run_id: "r3", emitted_at: iso(30 * 60_000) },
      ],
      error: null,
    });

    const r = await probeStrandedApprovals(NOW);
    expect(r.stranded).toBe(3);
    expect(r.tenants).toBe(2);
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent.mock.calls[0][0].meta).toEqual({ count: 2 });
  });

  it("returns zero and logs/pages nothing when nothing is stranded", async () => {
    scan.mockResolvedValue({
      data: [{ tenant_id: "t1", agent_run_id: "r1", emitted_at: iso(60_000) }],
      error: null,
    });
    const r = await probeStrandedApprovals(NOW);
    expect(r.stranded).toBe(0);
    expect(r.tenants).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
    expect(alertFn).not.toHaveBeenCalled();
  });

  it("never counts growth-page-only cards (cgo goal moves are not posted to Slack by design)", async () => {
    scan.mockResolvedValue({ data: [], error: null });
    await probeStrandedApprovals(NOW);
    expect(notFilter).toEqual(["decision_class", "in", '("cgo.dispatch-specialist")']);
  });

  it("ignores rows with an unparseable or missing emitted_at", async () => {
    scan.mockResolvedValue({
      data: [
        { tenant_id: "t1", agent_run_id: "r1", emitted_at: null },
        { tenant_id: "t1", agent_run_id: "r2", emitted_at: "not-a-date" },
        { tenant_id: "t1", agent_run_id: "r3", emitted_at: iso(30 * 60_000) },
      ],
      error: null,
    });
    const r = await probeStrandedApprovals(NOW);
    expect(r.stranded).toBe(1);
  });

  it("throws on a scan error (so the cron logs it, not a silent zero)", async () => {
    scan.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(probeStrandedApprovals(NOW)).rejects.toThrow(/boom/);
  });

  it("still measures test-tenant strands but keeps them OUT of the paged number", async () => {
    scan.mockResolvedValue({
      data: [
        { tenant_id: "real1", agent_run_id: "r1", emitted_at: iso(2 * DAY) },
        { tenant_id: "test1", agent_run_id: "r2", emitted_at: iso(2 * DAY) },
        { tenant_id: "test1", agent_run_id: "r3", emitted_at: iso(2 * DAY) },
      ],
      error: null,
    });
    tenantScan.mockResolvedValue({
      data: [
        { id: "real1", slug: "acme", kind: "real" },
        { id: "test1", slug: "qa-shell", kind: "test" },
      ],
      error: null,
    });

    const r = await probeStrandedApprovals(NOW);
    expect(r.stranded).toBe(3);
    expect(r.realStranded).toBe(1);
    expect(r.testStranded).toBe(2);
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(lastAlert().email?.detail).toContain("acme");
  });

  it("calls alert() ONCE per dedupe bucket, not once per hourly tick", async () => {
    scan.mockResolvedValue({
      data: [{ tenant_id: "t1", agent_run_id: "r1", emitted_at: iso(30 * DAY) }],
      error: null,
    });
    tenantScan.mockResolvedValue({ data: [{ id: "t1", slug: "acme", kind: "real" }], error: null });

    await probeStrandedApprovals(NOW);
    await probeStrandedApprovals(NOW + 60 * 60_000);
    await probeStrandedApprovals(NOW + 2 * 60 * 60_000);
    expect(alertFn).toHaveBeenCalledTimes(1);

    await probeStrandedApprovals(NOW + 8 * DAY);
    expect(alertFn).toHaveBeenCalledTimes(2);
  });

  it("does not silently treat test tenants as customers when the lookup ERRORS", async () => {
    scan.mockResolvedValue({
      data: [{ tenant_id: "t1", agent_run_id: "r1", emitted_at: iso(2 * DAY) }],
      error: null,
    });
    tenantScan.mockResolvedValue({ data: null, error: { message: "pg down" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await probeStrandedApprovals(NOW);
    expect(r.realStranded).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tenant lookup errored"));
    warn.mockRestore();
  });

  it("pages with the rendered detail body when a delta fires", async () => {
    scan.mockResolvedValue({
      data: [
        { tenant_id: "t1", agent_run_id: "r1", emitted_at: iso(30 * 60_000), decision_class: "engineer.ship-pr" },
        { tenant_id: "t1", agent_run_id: "r2", emitted_at: iso(60 * 60_000), decision_class: "engineer.ship-pr" },
        { tenant_id: "t1", agent_run_id: "r3", emitted_at: iso(90 * 60_000), decision_class: "pm.needs_action" },
      ],
      error: null,
    });
    tenantScan.mockResolvedValue({ data: [{ id: "t1", slug: "acme", kind: "real" }], error: null });

    await probeStrandedApprovals(NOW);
    const arg = lastAlert();
    expect(arg.email?.dedupeKey).toMatch(/^approval_stranded:delta:/);
    expect(arg.email?.detail).toContain("admin.zaviagent.com/human-actions?tenant=acme");
    expect(arg.email?.subjectDetail).toContain("3 new");
  });
});

describe("buildStrandReport", () => {
  const t = (id: string, slug: string, kind: string): TenantMeta => ({ id, slug, kind });

  it("splits real vs test tenants and derives the 24h delta", () => {
    const r = buildStrandReport(
      [
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(2 * 60 * 60_000) },
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(3 * DAY) },
        { tenant_id: "b", agent_run_id: null, emitted_at: iso(3 * DAY) },
      ],
      meta(t("a", "acme", "real"), t("b", "shell", "test")),
      NOW,
    );

    expect(r.stranded).toBe(3);
    expect(r.realStranded).toBe(2);
    expect(r.realTenants).toBe(1);
    expect(r.testStranded).toBe(1);
    expect(r.newLast24h).toBe(1);
    expect(r.lines.map((l) => l.slug)).toEqual(["acme"]);
  });

  it("counts newlyAged only in the 7-8 day band, so age-escalation is a DELTA", () => {
    const r = buildStrandReport(
      [
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(7.5 * DAY) },
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(20 * DAY) },
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(6 * DAY) },
      ],
      meta(t("a", "acme", "real")),
      NOW,
    );
    expect(r.newlyAged7d).toBe(1);
    expect(r.over7d).toBe(2);
    expect(r.oldestDays).toBe(20);
  });

  it("picks the dominant decision class per tenant", () => {
    const r = buildStrandReport(
      [
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(DAY), decision_class: "pm.needs_action" },
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(DAY), decision_class: "engineer.ship-pr" },
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(DAY), decision_class: "engineer.ship-pr" },
      ],
      meta(t("a", "acme", "real")),
      NOW,
    );
    expect(r.lines[0].dominantClass).toBe("engineer.ship-pr");
  });

  it("degrades to a short tenant id for DISPLAY but links on the full id", () => {
    const r = buildStrandReport(
      [{ tenant_id: "abcdefgh-1111", agent_run_id: null, emitted_at: iso(DAY) }],
      new Map(),
      NOW,
    );
    expect(r.lines[0].slug).toBe("abcdefgh");
    expect(r.lines[0].linkKey).toBe("abcdefgh-1111");
    expect(r.lines[0].isTest).toBe(false);
  });

  it("clamps decision_class to a slug token before it reaches the unscrubbed email", () => {
    const r = buildStrandReport(
      [
        {
          tenant_id: "a",
          agent_run_id: null,
          emitted_at: iso(DAY),
          decision_class: "<b>go to https://evil.example</b> now",
        },
      ],
      meta(t("a", "acme", "real")),
      NOW,
    );
    const cls = r.lines[0].dominantClass;
    expect(cls).not.toMatch(/[<>\s]/);
    expect(cls).not.toContain("//");
    expect(cls.length).toBeLessThanOrEqual(60);
  });
});

describe("shouldPageStrand", () => {
  const report = (over: Partial<ReturnType<typeof buildStrandReport>>) =>
    ({
      stranded: 0,
      tenants: 0,
      realStranded: 0,
      realTenants: 0,
      testStranded: 0,
      testTenants: 0,
      newLast24h: 0,
      newlyAged7d: 0,
      over7d: 0,
      oldestDays: 0,
      lines: [],
      ...over,
    }) as ReturnType<typeof buildStrandReport>;

  it("pages on a burst of new strands, under a DAY bucket", () => {
    const d = shouldPageStrand(report({ realStranded: 10, newLast24h: 3 }), NOW);
    expect(d).toMatchObject({ page: true, reason: "delta" });
    expect(d.dedupeKey).toBe(`approval_stranded:delta:${Math.floor(NOW / DAY)}`);
  });

  it("pages when even ONE decision just crossed 7 days", () => {
    expect(shouldPageStrand(report({ realStranded: 4, newlyAged7d: 1 }), NOW).reason).toBe("delta");
  });

  it("falls back to a WEEKLY floor when the backlog is standing but quiet", () => {
    const d = shouldPageStrand(report({ realStranded: 35, newLast24h: 0 }), NOW);
    expect(d.reason).toBe("floor");
    expect(d.dedupeKey).toBe(`approval_stranded:floor:${Math.floor(NOW / (7 * DAY))}`);
  });

  it("does not page at all when no customer tenant is affected", () => {
    expect(shouldPageStrand(report({ stranded: 4, testStranded: 4 }), NOW).page).toBe(false);
  });

  it("keys the floor bucket per WEEK so a quiet backlog cannot nag daily", () => {
    const quiet = report({ realStranded: 35 });
    const today = shouldPageStrand(quiet, NOW).dedupeKey;
    expect(shouldPageStrand(quiet, NOW + DAY).dedupeKey).toBe(today);
    expect(shouldPageStrand(quiet, NOW + 8 * DAY).dedupeKey).not.toBe(today);
  });
});

describe("renderStrandPage", () => {
  const built = () =>
    buildStrandReport(
      [
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(2 * 60 * 60_000), decision_class: "pm.needs_action" },
        { tenant_id: "a", agent_run_id: null, emitted_at: iso(13 * DAY), decision_class: "pm.needs_action" },
        { tenant_id: "b", agent_run_id: null, emitted_at: iso(3 * DAY), decision_class: "engineer.ship-pr" },
      ],
      meta({ id: "a", slug: "a2z-reach", kind: "real" }, { id: "b", slug: "couple-app", kind: "real" }),
      NOW,
    );

  it("drops the false 'no human can see this' claim and says what actually failed", () => {
    const { msg } = renderStrandPage(built(), "delta");
    expect(msg).not.toMatch(/no human can/i);
    expect(msg).toMatch(/still live in each tenant's workspace/i);
    expect(msg).toMatch(/Nobody was NOTIFIED/);
  });

  it("gives EVERY tabulated tenant its own admin link, not just the top few", () => {
    const report = built();
    const { detail } = renderStrandPage(report, "delta");
    for (const line of report.lines) {
      expect(detail).toContain(line.slug);
      expect(detail).toContain(`https://admin.zaviagent.com/human-actions?tenant=${line.linkKey}`);
    }
  });

  it("links to ADMIN_ORIGIN when set, so staging pages open the staging admin", () => {
    vi.stubEnv("ADMIN_ORIGIN", "https://admin-latest.zaviagent.com/");
    try {
      const { detail } = renderStrandPage(built(), "delta");
      expect(detail).toContain("https://admin-latest.zaviagent.com/human-actions?tenant=");
      expect(detail).not.toContain("https://admin.zaviagent.com/");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the WIRE message inside the 500-char scrubber cap", () => {
    expect(renderStrandPage(built(), "delta").msg.length).toBeLessThanOrEqual(500);
  });

  it("leads with the weekly framing (not a fake delta) on a floor page", () => {
    const { msg, subjectDetail } = renderStrandPage(built(), "floor");
    expect(msg).toMatch(/Weekly reminder/);
    expect(msg).toMatch(/nothing new this week/);
    expect(subjectDetail).toMatch(/^weekly/);
  });

  it("carries no decision content — a body riding along on the row never reaches the page (C14)", () => {
    const SENTINEL = "CUSTOMER-SECRET-PAYLOAD";
    const report = buildStrandReport(
      [
        {
          tenant_id: "a",
          agent_run_id: null,
          emitted_at: iso(DAY),
          decision_class: "pm.needs_action",
          body: { summary: SENTINEL },
        } as never,
      ],
      meta({ id: "a", slug: "acme", kind: "real" }),
      NOW,
    );
    const { msg, detail, subjectDetail } = renderStrandPage(report, "delta");
    for (const part of [msg, detail, subjectDetail]) expect(part).not.toContain(SENTINEL);
    expect(detail).toContain("pm.needs_action");
  });
});

describe("planChatCardReconcile (bug #7 backstop)", () => {
  const row = (over: Partial<Parameters<typeof planChatCardReconcile>[0][number]>) => ({
    id: "c1",
    tenant_id: "t1",
    run_id: "r1",
    table: "decisions" as const,
    founder: false,
    advice_missing: false,
    ...over,
  });
  const runs = new Map([
    ["r1", { trigger: "chat", thread_id: "th-A" }],
    ["child", { trigger: "handoff", thread_id: "th-A" }],
    ["r2", { trigger: "chat", thread_id: "th-B" }],
    ["a2a", { trigger: "a2a", thread_id: null }],
  ]);
  it("must-catch: a chat turn's waiting ad card with no chat card is re-delivered; a founder card's missing warnings are asked again", () => {
    const plan = planChatCardReconcile(
      [row({ id: "held-cut" }), row({ id: "founder", run_id: "child", founder: true, advice_missing: true }), row({ id: "tile", table: "channel_actions", run_id: "r2" })],
      runs,
      [],
    );
    expect(plan.deliver.map((r) => r.id)).toEqual(["held-cut", "founder", "tile"]);
    expect(plan.advice.map((r) => r.id)).toEqual(["founder"]);
  });
  it("must-catch: a copy shown in ANOTHER chat (or another tenant) does not count as delivered to the filing chat", () => {
    const plan = planChatCardReconcile([row({ id: "held-cut" })], runs, [
      { tenant_id: "t1", thread_id: "th-B", decision_id: "held-cut", full: true },
      { tenant_id: "t2", thread_id: "th-A", decision_id: "held-cut", full: true },
    ]);
    expect(plan.deliver.map((r) => r.id)).toEqual(["held-cut"]);
  });
  it("must-catch: an older plain confirm card (its upgrade failed) is retried, and a run with no known thread proves nothing", () => {
    const plan = planChatCardReconcile(
      [row({ id: "plain" }), row({ id: "nothread", run_id: "r9" })],
      new Map([...runs, ["r9", { trigger: "chat", thread_id: null }]]),
      [
        { tenant_id: "t1", thread_id: "th-A", decision_id: "plain", full: false },
        { tenant_id: "t1", thread_id: "th-A", decision_id: "nothread", full: true },
      ],
    );
    expect(plan.deliver.map((r) => r.id)).toEqual(["plain", "nothread"]);
  });
  it("must-not-touch: a card in its own chat, a scheduled review's card, and a non-founder handoff child are left alone", () => {
    const plan = planChatCardReconcile(
      [row({ id: "shown" }), row({ id: "review", run_id: "a2a" }), row({ id: "child", run_id: "child" }), row({ id: "no-run", run_id: null })],
      runs,
      [{ tenant_id: "t1", thread_id: "th-A", decision_id: "shown", full: true }],
    );
    expect(plan.deliver).toEqual([]);
    expect(plan.advice).toEqual([]);
  });
});

describe("walkKeyset (reconciler scan)", () => {
  it("walks every page by (time, id) cursor, never by offset, and stops at a short page", async () => {
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}`, at: "2026-10-18T00:00:00Z" }));
    const cursors: Array<{ at: string; id: string } | null> = [];
    const rows = await walkKeyset(
      async (after) => {
        cursors.push(after);
        const rest = after ? all.filter((r) => r.at > after.at || (r.at === after.at && r.id > after.id)) : all;
        return { data: rest.slice(0, 500), error: null };
      },
      (r) => r.at,
    );
    expect(rows).toHaveLength(1200);
    expect(cursors).toEqual([null, { at: "2026-10-18T00:00:00Z", id: "id-00499" }, { at: "2026-10-18T00:00:00Z", id: "id-00999" }]);
  });
  it("a read error is null (the hour decides nothing), never a partial plan", async () => {
    expect(await walkKeyset(async () => ({ data: null, error: { message: "down" } }), () => "")).toBeNull();
  });
});
