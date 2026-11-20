
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseUsageLimit,
  maybeSendUsageLimitAlert,
} from "../usage-limit-alert";

const REAL_LIMIT_MSG =
  "Claude Code returned an error result: You've hit your limit · resets Jun 13, 12am (UTC)";

describe("parseUsageLimit", () => {
  it("matches the real usage-limit string and extracts the reset window", () => {
    const r = parseUsageLimit(REAL_LIMIT_MSG);
    expect(r.hit).toBe(true);
    expect(r.resetsAt).toContain("Jun 13");
    expect(r.resetsAt).toContain("12am");
    expect(r.resetsAt).toContain("UTC");
  });

  it("matches 'usage limit' + 'resets' phrasing", () => {
    const r = parseUsageLimit("You have reached your usage limit. Resets in 2 days.");
    expect(r.hit).toBe(true);
  });

  it("matches 'exceeded your … limit'", () => {
    const r = parseUsageLimit("You have exceeded your monthly limit.");
    expect(r.hit).toBe(true);
  });

  it("does NOT match an ordinary error", () => {
    expect(parseUsageLimit("Error: connection refused").hit).toBe(false);
    expect(parseUsageLimit("Internal server error (500)").hit).toBe(false);
    expect(parseUsageLimit("tool execution failed: bad_request").hit).toBe(false);
  });

  it("does NOT match a bare 'limit' with no usage/rate/exceeded signature", () => {
    expect(parseUsageLimit("character limit reached in field name").hit).toBe(false);
  });

  it("hit=true but resetsAt=null when there is no parseable reset window", () => {
    const r = parseUsageLimit("You've hit your limit. Try again later.");
    expect(r.hit).toBe(true);
    expect(r.resetsAt).toBeNull();
  });
});

function makeDeps(
  initialBlob: Record<string, unknown> = {},
  opts: { readError?: boolean; duringSend?: (row: { blob: Record<string, unknown> }) => void } = {},
) {
  const row: { blob: Record<string, unknown> } = { blob: { ...initialBlob } };
  const sgSend =
    vi.fn<[to: string, subject: string, html: string, text: string], Promise<void>>(
      async () => {
        opts.duringSend?.(row);
      },
    );
  const sb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            opts.readError
              ? { data: null, error: { message: "read timed out" } }
              : { data: { blob: structuredClone(row.blob) }, error: null },
        }),
      }),
      update: (patch: { blob: Record<string, unknown> }) => ({
        eq: async () => {
          row.blob = structuredClone(patch.blob);
          return { error: null };
        },
      }),
    }),
    rpc: async (fn: string, params: { p_patch: Record<string, unknown> }) => {
      if (fn !== "system_config_merge") return { error: { message: `unexpected ${fn}` } };
      row.blob = { ...row.blob, ...params.p_patch };
      return { error: null };
    },
  };
  return {
    get blob() {
      return row.blob;
    },
    row,
    sgSend,
    deps: {
      sgSend,
      serviceClient: () => sb as never,
      now: () => "2026-06-09T00:00:00.000Z",
    },
  };
}

const baseArgs = {
  message: REAL_LIMIT_MSG,
  run_id: "run-123",
  tenant_id: "tenant-abc",
  agent_slug: "engineer",
};

describe("maybeSendUsageLimitAlert", () => {
  beforeEach(() => {
    delete process.env.OPS_ALERT_EMAIL;
  });

  it("first call (empty blob) sends + writes the window marker", async () => {
    const h = makeDeps();
    const { sgSend, deps } = h;
    await maybeSendUsageLimitAlert({ ...baseArgs, deps });
    const blob = h.blob;
    expect(sgSend).toHaveBeenCalledTimes(1);
    expect(sgSend.mock.calls[0][0]).toBe("ravi@zaviagent.com");
    expect(blob.usage_limit_alert_sent_for).toContain("Jun 13");
  });

  it("second call with the SAME reset window does NOT send (dedup)", async () => {
    const h = makeDeps();
    const { sgSend, deps } = h;
    await maybeSendUsageLimitAlert({ ...baseArgs, deps });
    expect(sgSend).toHaveBeenCalledTimes(1);
    const blob = h.blob;
    await maybeSendUsageLimitAlert({ ...baseArgs, deps });
    expect(sgSend).toHaveBeenCalledTimes(1);
    expect(blob.usage_limit_alert_sent_for).toContain("Jun 13");
  });

  it("a NEW reset window sends again", async () => {
    const { sgSend, deps } = makeDeps({
      usage_limit_alert_sent_for: "Jun 13, 12am (UTC)",
    });
    await maybeSendUsageLimitAlert({
      ...baseArgs,
      message:
        "Claude Code returned an error result: You've hit your limit · resets Jun 20, 12am (UTC)",
      deps,
    });
    expect(sgSend).toHaveBeenCalledTimes(1);
  });

  it("a non-usage-limit message never sends", async () => {
    const { sgSend, deps } = makeDeps();
    await maybeSendUsageLimitAlert({
      ...baseArgs,
      message: "Error: connection refused",
      deps,
    });
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("sgSend throwing does NOT reject (best-effort)", async () => {
    const { deps } = makeDeps();
    const throwingDeps = {
      ...deps,
      sgSend: async () => {
        throw new Error("sendgrid down");
      },
    };
    await expect(
      maybeSendUsageLimitAlert({ ...baseArgs, deps: throwingDeps }),
    ).resolves.toBeUndefined();
  });

  it("a serviceClient that throws does NOT reject (best-effort)", async () => {
    const sgSend = vi.fn(async () => {});
    await expect(
      maybeSendUsageLimitAlert({
        ...baseArgs,
        deps: {
          sgSend,
          serviceClient: () => {
            throw new Error("db down");
          },
          now: () => "2026-06-09T00:00:00.000Z",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPS_ALERT_EMAIL override", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    const { sgSend, deps } = makeDeps();
    await maybeSendUsageLimitAlert({ ...baseArgs, deps });
    expect(sgSend.mock.calls[0][0]).toBe("ops@example.com");
  });

  it("unparseable-reset limit falls back to a time-bucket dedup (sends once per bucket)", async () => {
    const h = makeDeps();
    const { sgSend, deps } = h;
    const msg = "You've hit your limit. Try again later.";
    await maybeSendUsageLimitAlert({ ...baseArgs, message: msg, deps });
    expect(sgSend).toHaveBeenCalledTimes(1);
    await maybeSendUsageLimitAlert({ ...baseArgs, message: msg, deps });
    expect(sgSend).toHaveBeenCalledTimes(1);
    expect(typeof h.blob.usage_limit_alert_sent_for).toBe("string");
  });

  it("a Coming soon lock and the fleet halt saved by staff while the alert email is sending survive the dedup marker write", async () => {
    const h = makeDeps(
      { locked_channel_slugs: ["meta_ads"], other_flag: true },
      {
        duringSend: (row) => {
          row.blob = { ...row.blob, locked_channel_slugs: ["meta_ads", "linkedin_ads"], fleet_halt: true };
        },
      },
    );
    await maybeSendUsageLimitAlert({ ...baseArgs, deps: h.deps });
    expect(h.sgSend).toHaveBeenCalledTimes(1);
    expect(h.blob).toEqual({
      locked_channel_slugs: ["meta_ads", "linkedin_ads"],
      fleet_halt: true,
      other_flag: true,
      usage_limit_alert_sent_for: expect.stringContaining("Jun 13"),
      usage_limit_alert_sent_at: "2026-06-09T00:00:00.000Z",
    });
  });

  it("a failed config read still alerts but never writes an empty config over every lock and the fleet halt", async () => {
    const h = makeDeps(
      { locked_channel_slugs: ["linkedin_ads"], fleet_halt: true, disabled_agent_slugs: ["x"] },
      { readError: true },
    );
    await maybeSendUsageLimitAlert({ ...baseArgs, deps: h.deps });
    expect(h.sgSend).toHaveBeenCalledTimes(1);
    expect(h.blob).toMatchObject({ locked_channel_slugs: ["linkedin_ads"], fleet_halt: true, disabled_agent_slugs: ["x"] });
  });
});
