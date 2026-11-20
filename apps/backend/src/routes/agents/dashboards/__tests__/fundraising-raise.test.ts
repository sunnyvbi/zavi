
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSettings = vi.hoisted(() => ({ getBool: vi.fn() }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: mockSettings.getBool,
}));
const mockFlag = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock("@/services/fundraising/flag", () => ({
  fundraisingPipelineEnabled: mockFlag.enabled,
}));

beforeEach(() => {
  mockFlag.enabled.mockResolvedValue(false);
  mockSettings.getBool.mockReset();
});

import { build } from "../fundraising";
import type { DashboardContext } from "../_contract";

const TENANT = "22222222-2222-2222-2222-222222222222";

function makeSb(tables: Record<string, unknown[]>) {
  let current: string | null = null;
  const chain: Record<string, unknown> = {
    from(t: string) {
      current = t;
      return chain;
    },
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    rpc: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () =>
      Promise.resolve({ data: (tables[current ?? ""] ?? [])[0] ?? null, error: null }),
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: tables[current ?? ""] ?? [], error: null }).then(
        resolve,
      );
    },
  };
  return chain;
}

function ctx(tables: Record<string, unknown[]> = {}): DashboardContext {
  return { tenantId: TENANT, sb: makeSb(tables) } as unknown as DashboardContext;
}

describe("fundraising builder — raise_room_advisor OFF-safe", () => {
  it("flag OFF => payload has NO `raise` key (byte-for-byte unchanged)", async () => {
    mockSettings.getBool.mockResolvedValue(false);
    const d = (await build(ctx())) as Record<string, unknown>;
    expect("raise" in d).toBe(false);
  });

  it("flag ON => payload gains exactly one additive `raise` key", async () => {
    mockSettings.getBool.mockResolvedValue(true);
    const offCtx = ctx();
    const onCtx = ctx();
    mockSettings.getBool.mockResolvedValueOnce(false);
    const off = (await build(offCtx)) as Record<string, unknown>;
    mockSettings.getBool.mockResolvedValueOnce(true);
    const on = (await build(onCtx)) as Record<string, unknown>;

    const addedKeys = Object.keys(on).filter((k) => !(k in off));
    expect(addedKeys).toEqual(["raise"]);

    const raise = on.raise as Record<string, unknown>;
    expect(raise.enabled).toBe(true);
    expect(raise.current_phase).toBe("prep");
    expect(raise.readiness_state).toBe("not_assessed");
    expect(raise.funnel).toMatchObject({ total: 0, notContacted: 0 });
    expect(raise.momentum).toMatchObject({ ready: false, sentCount: 0 });
    expect(raise.next_action).toBeTruthy();
  });

  it("flag ON with a persisted raise row => surfaces the stored phase", async () => {
    mockSettings.getBool.mockResolvedValue(true);
    const d = (await build(
      ctx({
        fundraising_raise: [
          { current_phase: "outreach", readiness_snapshot: null, round_design_snapshot: null },
        ],
      }),
    )) as Record<string, unknown>;
    const raise = d.raise as Record<string, unknown>;
    expect(raise.current_phase).toBe("outreach");
  });

  it("flag ON with intro + meeting rows => raise.intros / raise.meetings carry the mapped display shape", async () => {
    mockSettings.getBool.mockResolvedValue(true);
    const d = (await build(
      ctx({
        fundraising_raise_intro: [
          {
            id: "intro-1",
            target_firm: "Boldstart",
            target_person: "Ada",
            path: "via your investor",
            status: "drafted",
            draft_text: "Hey — quick intro ask…",
          },
          {
            id: "intro-2",
            target_firm: "Uncork",
            target_person: null,
            path: null,
            status: "sent",
            draft_text: null,
          },
        ],
        fundraising_raise_meeting: [
          {
            id: "mtg-1",
            investor_ref: "Boldstart / Ada",
            scheduled_for: "2026-08-01T17:00:00Z",
            status: "upcoming",
            outcome: null,
          },
          {
            id: "mtg-2",
            investor_ref: "Uncork",
            scheduled_for: null,
            status: "done",
            outcome: "soft_yes",
          },
        ],
      }),
    )) as Record<string, unknown>;

    const raise = d.raise as Record<string, unknown>;
    const intros = raise.intros as Array<Record<string, unknown>>;
    const meetings = raise.meetings as Array<Record<string, unknown>>;

    expect(intros).toHaveLength(2);
    expect(intros[0]).toEqual({
      id: "intro-1",
      target_firm: "Boldstart",
      target_person: "Ada",
      path: "via your investor",
      status: "queued",
      draft: "Hey — quick intro ask…",
    });
    expect(intros[1]).toEqual({
      id: "intro-2",
      target_firm: "Uncork",
      status: "sent",
    });

    expect(meetings).toHaveLength(2);
    expect(meetings[0]).toEqual({
      id: "mtg-1",
      investor_ref: "Boldstart / Ada",
      kind: "upcoming",
      scheduled_for: "2026-08-01T17:00:00Z",
      outcome: null,
    });
    expect(meetings[1]).toEqual({
      id: "mtg-2",
      investor_ref: "Uncork",
      kind: "done",
      scheduled_for: null,
      outcome: "soft_yes",
    });
    for (const m of meetings) {
      expect("prep" in m).toBe(false);
      expect("debrief" in m).toBe(false);
    }
  });

  it("flag OFF => neither raise nor its intro/meeting lists appear", async () => {
    mockSettings.getBool.mockResolvedValue(false);
    const d = (await build(
      ctx({
        fundraising_raise_intro: [{ id: "intro-1", target_firm: "X", status: "sent" }],
        fundraising_raise_meeting: [{ id: "m-1", investor_ref: "X", status: "done", outcome: "pass" }],
      }),
    )) as Record<string, unknown>;
    expect("raise" in d).toBe(false);
  });
});
