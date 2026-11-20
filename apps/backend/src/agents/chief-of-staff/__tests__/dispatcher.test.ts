import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: vi.fn(),
}));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  writeNote: vi.fn(),
}));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import { writeNote } from "@/services/memory";
import { chiefOfStaffDispatcher, digestHasSignal } from "../dispatcher";
import { digestSchema } from "../output-schema";

const runGenericMock = runGeneric as ReturnType<typeof vi.fn>;
const visibleMock = getVisibleAgentSlugs as ReturnType<typeof vi.fn>;
const writeNoteMock = writeNote as ReturnType<typeof vi.fn>;

function makeCtx(emitDecision: ReturnType<typeof vi.fn>, trigger?: string) {
  return {
    tenant_id: "t1",
    runId: "run-1",
    agent: { slug: "chief-of-staff" },
    trigger,
    emitDecision,
  } as never;
}

function digest(tier1: unknown[], extra: Record<string, unknown> = {}) {
  return {
    parse_ok: true,
    parsed: { tier1, tier2: [], tier3: [], tier4: [], rendered_markdown: "x", ...extra },
    output_text: "x",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  visibleMock.mockResolvedValue(
    new Set(["dispute-response", "support-lead", "performance-marketer", "qa", "pm"]),
  );
  writeNoteMock.mockResolvedValue("note-1");
});

describe("chiefOfStaffDispatcher", () => {
  it("emits one dispatch decision per valid suggested_dispatch", async () => {
    const emit = vi.fn().mockResolvedValue("dec-1");
    runGenericMock.mockResolvedValue(
      digest([
        { title: "A", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "dispute-response", intent: "draft evidence du_1" } },
        { title: "B", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "support-lead", intent: "triage booking 9" } },
        { title: "C", summary: "s", evidence: [] },
      ]),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith("chief-of-staff.dispatch-specialist", {
      target_agent_slug: "dispute-response",
      intent: "draft evidence du_1",
    });
  });

  it("drops self, operator, and hidden/unknown targets", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([
        { title: "self", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "chief-of-staff", intent: "x" } },
        { title: "operator", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "operator", intent: "x" } },
        { title: "hidden", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "advisor", intent: "x" } },
        { title: "bogus", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "not-an-agent", intent: "x" } },
        { title: "ok", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "qa", intent: "file bug" } },
      ]),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("chief-of-staff.dispatch-specialist", {
      target_agent_slug: "qa",
      intent: "file bug",
    });
  });

  it("caps dispatches at 4 even if more are tagged", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest(
        Array.from({ length: 6 }, (_, i) => ({
          title: `t${i}`,
          summary: "s",
          evidence: [],
          suggested_dispatch: { target_agent_slug: "qa", intent: `bug ${i}` },
        })),
      ),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it("emits nothing on a parse failure", async () => {
    const emit = vi.fn();
    runGenericMock.mockResolvedValue({ parse_ok: false, parsed: null, output_text: "" });
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits nothing when no tier1 item carries a suggested_dispatch", async () => {
    const emit = vi.fn();
    runGenericMock.mockResolvedValue(
      digest([{ title: "A", summary: "s", evidence: [] }]),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).not.toHaveBeenCalled();
    expect(visibleMock).not.toHaveBeenCalled();
  });

  it("emits nothing (degrades) if the visible-fleet lookup throws", async () => {
    const emit = vi.fn();
    visibleMock.mockRejectedValue(new Error("db down"));
    runGenericMock.mockResolvedValue(
      digest([{ title: "A", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "qa", intent: "x" } }]),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).not.toHaveBeenCalled();
  });

  it("one bad emit does not abort the rest", async () => {
    const emit = vi
      .fn()
      .mockRejectedValueOnce(new Error("emit boom"))
      .mockResolvedValue("dec-2");
    runGenericMock.mockResolvedValue(
      digest([
        { title: "A", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "dispute-response", intent: "x" } },
        { title: "B", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "qa", intent: "y" } },
      ]),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe("chiefOfStaffDispatcher — manager accountability (Slice 3)", () => {
  it("schema validates a digest WITH weekly_priorities[]", () => {
    const parsed = digestSchema.safeParse({
      tier1: [],
      tier2: [],
      tier3: [],
      tier4: [],
      rendered_markdown: "x",
      weekly_priorities: [
        { agent_slug: "performance-marketer", priority: "Cut CAC under $28." },
        { agent_slug: "qa", priority: "Clear the regression backlog." },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("schema validates a digest WITHOUT the optional fields (back-compat)", () => {
    const parsed = digestSchema.safeParse({
      tier1: [{ title: "A", summary: "s", evidence: [] }],
      tier2: [],
      tier3: [],
      tier4: [],
      rendered_markdown: "x",
    });
    expect(parsed.success).toBe(true);
  });

  it("still validates a digest emitting the RETIRED accountability[] (no hard-fail mid-deploy)", () => {
    const parsed = digestSchema.safeParse({
      tier1: [{ title: "A", summary: "s", evidence: [] }],
      tier2: [],
      tier3: [],
      tier4: [],
      rendered_markdown: "x",
      accountability: [
        { agent_slug: "qa", committed: "x", status: "ghosted" },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "accountability" in parsed.data).toBe(false);
  });

  it("persists one note per weekly_priority via writeNote", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([{ title: "A", summary: "s", evidence: [] }], {
        weekly_priorities: [
          { agent_slug: "performance-marketer", priority: "Cut CAC under $28." },
          { agent_slug: "dispute-response", priority: "Clear 3 open chargebacks." },
        ],
      }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(writeNoteMock).toHaveBeenCalledTimes(2);
    const [tenantArg, noteArg] = writeNoteMock.mock.calls[0];
    expect(tenantArg).toBe("t1");
    expect(noteArg.source_ref).toBe("run-1");
    expect(noteArg.tags).toContain("agent_priorities");
    expect(noteArg.tags).toContain("agent:performance-marketer");
  });

  it("does not call writeNote when no weekly_priorities are set", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(digest([{ title: "A", summary: "s", evidence: [] }]));
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(writeNoteMock).not.toHaveBeenCalled();
  });

  it("a writeNote failure does not fail the digest run", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    writeNoteMock.mockRejectedValue(new Error("note boom"));
    runGenericMock.mockResolvedValue(
      digest([{ title: "A", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "qa", intent: "file bug" } }], {
        weekly_priorities: [{ agent_slug: "qa", priority: "Clear backlog." }],
      }),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(result).toBeDefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("chiefOfStaffDispatcher — grounding-skip visibility (1.2)", () => {
  it("wired + no revenue data → injects a fleet-health tier4 line and warns cos.grounding_skipped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.fn().mockResolvedValue("dec");
    const res = digest([], { tier4: [] });
    (res as { resolved_tool_names?: string[] }).resolved_tool_names = [
      "operator_db__query_recent_transactions",
    ];
    (res as { tool_calls?: unknown[] }).tool_calls = [];
    runGenericMock.mockResolvedValue(res);

    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier4: Array<{ category: string; summary: string }>;
    };
    expect(
      parsed.tier4.some(
        (t) =>
          t.category === "fleet-health" &&
          t.summary.startsWith("Ran without pulling live numbers"),
      ),
    ).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("cos.grounding_skipped")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("not wired (no resolved_tool_names) → tier4 unchanged, no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(digest([], { tier4: [] }));

    const result = await chiefOfStaffDispatcher(makeCtx(emit), {});
    const parsed = result.parsed as {
      tier4: Array<{ category: string; summary: string }>;
    };
    expect(
      parsed.tier4.some((t) =>
        t.summary.startsWith("Ran without pulling live numbers"),
      ),
    ).toBe(false);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("cos.grounding_skipped")),
    ).toBe(false);
    warn.mockRestore();
  });
});

describe("chiefOfStaffDispatcher — daily-digest delivery (P0-1)", () => {
  function calls(emit: ReturnType<typeof vi.fn>, decisionClass: string) {
    return emit.mock.calls.filter((c) => c[0] === decisionClass);
  }

  it("cron run with signal emits ONE chief-of-staff.daily-digest carrying rendered_markdown", async () => {
    const emit = vi.fn().mockResolvedValue("dec-digest");
    runGenericMock.mockResolvedValue(
      digest([], { tier2: [{ area: "growth", summary: "GMV +4% WoW" }], rendered_markdown: "## Pulse\nGMV +4%" }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    const digestCalls = calls(emit, "chief-of-staff.daily-digest");
    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0][1]).toMatchObject({ rendered_markdown: "## Pulse\nGMV +4%" });
  });

  it("delivers a CALM-day digest (tier1 empty, tier2 pulse) — quiet-but-present is the win", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([], {
        tier2: [{ area: "revenue", summary: "Nothing to decide today. Here's the pulse." }],
      }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    expect(calls(emit, "chief-of-staff.daily-digest")).toHaveLength(1);
  });

  it("SUPPRESSES a contentless digest (all tiers empty) — no Slack spam", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([], { tier2: [], tier3: [], tier4: [], rendered_markdown: "(nothing yet)" }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    expect(calls(emit, "chief-of-staff.daily-digest")).toHaveLength(0);
  });

  it("does NOT emit daily-digest on a NON-cron (manual) run — no double-push", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([], { tier2: [{ area: "growth", summary: "pulse" }] }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit, "manual"), {});
    expect(calls(emit, "chief-of-staff.daily-digest")).toHaveLength(0);
  });

  it("does NOT emit daily-digest when trigger is unset (defensive default)", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([], { tier2: [{ area: "growth", summary: "pulse" }] }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit), {});
    expect(calls(emit, "chief-of-staff.daily-digest")).toHaveLength(0);
  });

  it("daily-digest and dispatch-specialist are independent — a cron digest with a fire emits BOTH", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest(
        [{ title: "fire", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "qa", intent: "file bug" } }],
        { tier2: [{ area: "growth", summary: "pulse" }] },
      ),
    );
    await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    expect(calls(emit, "chief-of-staff.daily-digest")).toHaveLength(1);
    expect(calls(emit, "chief-of-staff.dispatch-specialist")).toHaveLength(1);
  });

  it("a failed daily-digest emit does NOT fail the run or block dispatch-specialist emits", async () => {
    const emit = vi
      .fn()
      .mockRejectedValueOnce(new Error("digest emit boom"))
      .mockResolvedValue("dec-2");
    runGenericMock.mockResolvedValue(
      digest(
        [{ title: "fire", summary: "s", evidence: [], suggested_dispatch: { target_agent_slug: "qa", intent: "file bug" } }],
        { tier2: [{ area: "growth", summary: "pulse" }] },
      ),
    );
    const result = await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    expect(result).toBeDefined();
    expect(calls(emit, "chief-of-staff.dispatch-specialist")).toHaveLength(1);
  });

  it("does NOT emit daily-digest on a parse failure (no structured digest)", async () => {
    const emit = vi.fn();
    runGenericMock.mockResolvedValue({ parse_ok: false, parsed: null, output_text: "" });
    await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("chief-of-staff daily-digest class", () => {
  it("dispatcher emits the daily-digest class on a cron run", async () => {
    const emit = vi.fn().mockResolvedValue("dec");
    runGenericMock.mockResolvedValue(
      digest([], { tier2: [{ area: "growth", summary: "pulse" }] }),
    );
    await chiefOfStaffDispatcher(makeCtx(emit, "cron"), {});
    expect(emit.mock.calls.map((c) => c[0])).toContain("chief-of-staff.daily-digest");
  });
});

describe("digestHasSignal", () => {
  const base = { tier1: [], tier2: [], tier3: [], tier4: [], rendered_markdown: "x" };
  it("false when rendered_markdown is empty/blank", () => {
    expect(digestHasSignal({ ...base, rendered_markdown: "" } as never)).toBe(false);
    expect(digestHasSignal({ ...base, rendered_markdown: "   " } as never)).toBe(false);
  });
  it("false when every tier is empty", () => {
    expect(digestHasSignal(base as never)).toBe(false);
  });
  it("true when any single tier has an item", () => {
    expect(digestHasSignal({ ...base, tier1: [{}] } as never)).toBe(true);
    expect(digestHasSignal({ ...base, tier2: [{}] } as never)).toBe(true);
    expect(digestHasSignal({ ...base, tier3: [{}] } as never)).toBe(true);
    expect(digestHasSignal({ ...base, tier4: [{}] } as never)).toBe(true);
  });
});
