import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(),
}));

const systemConfigMaybeSingle = vi.fn();
const openActionsLimit = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => mkClient(),
}));

function mkClient() {
  return {
    from: (table: string) => {
      if (table === "system_config") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: systemConfigMaybeSingle }) }),
        };
      }
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      chain.select = passthrough;
      chain.eq = passthrough;
      chain.order = passthrough;
      chain.limit = openActionsLimit;
      return chain;
    },
  };
}

import {
  parseOpenActionsFromEnvelope,
  renderOpenActionsBlock,
  buildOpenActionsBlock,
} from "../open-actions";

beforeEach(() => {
  systemConfigMaybeSingle.mockReset();
  openActionsLimit.mockReset();
});

describe("parseOpenActionsFromEnvelope", () => {
  it("captures a valid open_actions array (array form)", () => {
    const out = parseOpenActionsFromEnvelope([
      { summary: "Pause $353/wk campaign — full stop", severity: "urgent", proposed_action: "pause campaign 123" },
      { summary: "Refresh stale creative", severity: "normal" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      summary: "Pause $353/wk campaign — full stop",
      severity: "urgent",
      proposed_action: "pause campaign 123",
    });
    expect(out[1].severity).toBe("normal");
    expect(out[1].proposed_action).toBeUndefined();
  });

  it("also accepts the whole envelope object and digs out .open_actions", () => {
    const out = parseOpenActionsFromEnvelope({
      rendered_markdown: "hi",
      open_actions: [{ summary: "x", severity: "urgent" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("urgent");
  });

  it("absent / undefined → no capture, no throw", () => {
    expect(parseOpenActionsFromEnvelope(undefined)).toEqual([]);
    expect(parseOpenActionsFromEnvelope(null)).toEqual([]);
    expect(parseOpenActionsFromEnvelope({ rendered_markdown: "no field" })).toEqual([]);
  });

  it("malformed (non-array / wrong types) → no capture, no throw", () => {
    expect(parseOpenActionsFromEnvelope("not-an-array")).toEqual([]);
    expect(parseOpenActionsFromEnvelope({ open_actions: "still-not-array" })).toEqual([]);
    expect(parseOpenActionsFromEnvelope(42)).toEqual([]);
  });

  it("drops malformed entries but keeps valid siblings", () => {
    const out = parseOpenActionsFromEnvelope([
      null,
      { severity: "urgent" },
      { summary: "   ", severity: "urgent" },
      { summary: "keep me", severity: "urgent" },
      "garbage",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("keep me");
  });

  it("unknown severity defaults to 'normal'", () => {
    const out = parseOpenActionsFromEnvelope([{ summary: "x", severity: "critical" }]);
    expect(out[0].severity).toBe("normal");
  });

  it("caps at 5 actions per run", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      summary: `action ${i}`,
      severity: "urgent" as const,
    }));
    expect(parseOpenActionsFromEnvelope(many)).toHaveLength(5);
  });

  it("never throws on a hostile getter", () => {
    const hostile = {
      get open_actions() {
        throw new Error("boom");
      },
    };
    expect(parseOpenActionsFromEnvelope(hostile)).toEqual([]);
  });
});

describe("renderOpenActionsBlock", () => {
  it("returns '' for empty input", () => {
    expect(renderOpenActionsBlock([])).toBe("");
  });

  it("renders summary + proposed action, labeled block", () => {
    const block = renderOpenActionsBlock([
      { summary: "Pause campaign", severity: "urgent", proposed_action: "pause 123" },
      { summary: "No proposal here", severity: "urgent", proposed_action: null },
    ]);
    expect(block).toContain("OPEN URGENT ACTIONS you raised earlier");
    expect(block).toContain("- Pause campaign (proposed: pause 123)");
    expect(block).toContain("- No proposal here");
    expect(block).not.toContain("No proposal here (proposed");
  });

  it("truncates to top-3 even if more rows are passed", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      summary: `urgent ${i}`,
      severity: "urgent" as const,
      proposed_action: null,
    }));
    const block = renderOpenActionsBlock(rows);
    const bulletCount = block.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(bulletCount).toBe(3);
  });
});

describe("buildOpenActionsBlock — flag gate", () => {
  it("FLAG OFF (absent) → empty string, never reads the ledger", async () => {
    systemConfigMaybeSingle.mockResolvedValue({ data: { blob: {} }, error: null });
    const block = await buildOpenActionsBlock("tenant-1", "thread-1");
    expect(block).toBe("");
    expect(openActionsLimit).not.toHaveBeenCalled();
  });

  it("FLAG OFF (explicit false) → empty string", async () => {
    systemConfigMaybeSingle.mockResolvedValue({
      data: { blob: { open_actions_ledger_enabled: false } },
      error: null,
    });
    expect(await buildOpenActionsBlock("tenant-1", "thread-1")).toBe("");
  });

  it("FLAG ON + open urgent rows → renders the block", async () => {
    systemConfigMaybeSingle.mockResolvedValue({
      data: { blob: { open_actions_ledger_enabled: true } },
      error: null,
    });
    openActionsLimit.mockResolvedValue({
      data: [
        { summary: "Pause $353/wk campaign", severity: "urgent", proposed_action: "pause 123" },
      ],
      error: null,
    });
    const block = await buildOpenActionsBlock("tenant-1", "thread-1");
    expect(block).toContain("OPEN URGENT ACTIONS");
    expect(block).toContain("Pause $353/wk campaign (proposed: pause 123)");
  });

  it("FLAG ON + no rows → empty string", async () => {
    systemConfigMaybeSingle.mockResolvedValue({
      data: { blob: { open_actions_ledger_enabled: true } },
      error: null,
    });
    openActionsLimit.mockResolvedValue({ data: [], error: null });
    expect(await buildOpenActionsBlock("tenant-1", "thread-1")).toBe("");
  });

  it("FAIL-SAFE: a system_config read error → flag treated OFF → empty string", async () => {
    systemConfigMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await buildOpenActionsBlock("tenant-1", "thread-1")).toBe("");
  });
});
