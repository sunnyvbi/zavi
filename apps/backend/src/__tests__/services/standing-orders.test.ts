
import { describe, it, expect, vi } from "vitest";
import {
  validatePayloadTemplate,
  findSecretLiteral,
  createStandingOrderFromDecision,
  createResearchWatchFromDecision,
  composeStandingOrderBody,
  deliverStandingOrderResult,
  PAYLOAD_TEMPLATE_MAX_JSON_CHARS,
  STANDING_ORDER_PROMPT_MAX,
} from "@/services/agents/standing-orders";
import { validateCronExpression } from "../../../workers/functions/cron-match";

const THREAD_ID = "11111111-1111-1111-1111-111111111111";

const goodOrder = {
  prompt: "Post stalled approvals + GMV summary",
  deliver: { kind: "chat_thread" as const, thread_id: THREAD_ID },
};

describe("validatePayloadTemplate", () => {
  it("accepts a plain object template (generic, non-standing-order)", () => {
    const r = validatePayloadTemplate({ repo_hint: "o/r" });
    expect(r.ok).toBe(true);
  });

  it("accepts a valid standing_order template (both destinations)", () => {
    expect(validatePayloadTemplate({ standing_order: goodOrder }).ok).toBe(true);
    expect(
      validatePayloadTemplate({
        standing_order: {
          prompt: "weekly recap",
          deliver: { kind: "slack_channel", channel_id: "C0123ABC" },
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects non-objects (null, array, string)", () => {
    for (const bad of [null, [], "x", 42]) {
      const r = validatePayloadTemplate(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects an oversized template (JSON length cap)", () => {
    const r = validatePayloadTemplate({
      blob: "x".repeat(PAYLOAD_TEMPLATE_MAX_JSON_CHARS + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/);
  });

  it("rejects secret literals anywhere in the template", () => {
    const r = validatePayloadTemplate({
      standing_order: {
        ...goodOrder,
        prompt: "use sk-abcdefghijklmnopqrstuvwxyz1234 to query",
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/secret/);
  });

  it("rejects a malformed standing_order (bad deliver kind, bad channel, long prompt)", () => {
    expect(
      validatePayloadTemplate({
        standing_order: { prompt: "x", deliver: { kind: "sms", to: "+15551234" } },
      }).ok,
    ).toBe(false);
    expect(
      validatePayloadTemplate({
        standing_order: {
          prompt: "x",
          deliver: { kind: "slack_channel", channel_id: "general" },
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePayloadTemplate({
        standing_order: {
          prompt: "x".repeat(STANDING_ORDER_PROMPT_MAX + 1),
          deliver: goodOrder.deliver,
        },
      }).ok,
    ).toBe(false);
  });
});

describe("findSecretLiteral", () => {
  it("flags high-confidence secrets, passes ordinary ops prose", () => {
    expect(findSecretLiteral("xoxb-1234567890-abcdef")).toBeTruthy();
    expect(findSecretLiteral("AKIAABCDEFGHIJKLMNOP")).toBeTruthy();
    expect(findSecretLiteral("-----BEGIN RSA PRIVATE KEY-----")).toBeTruthy();
    expect(
      findSecretLiteral("post stalled approvals + GMV to #ops every Monday"),
    ).toBeNull();
    expect(findSecretLiteral("task force discussion")).toBeNull();
  });
});

describe("createStandingOrderFromDecision (dispatch-handler core)", () => {
  const deps = () => ({
    upsertScheduleRow: vi.fn(async () => ({ error: null })),
    validateCron: validateCronExpression,
  });

  it("locks agent_slug to 'operator' and writes the validated template", async () => {
    const d = deps();
    const r = await createStandingOrderFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: goodOrder },
      d,
    );
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/Standing order active/);
    expect(d.upsertScheduleRow).toHaveBeenCalledWith({
      tenant_id: "t1",
      agent_slug: "operator",
      cron_expression: "0 16 * * 1",
      enabled: true,
      payload_template: { standing_order: goodOrder },
    });
  });

  it("fail-closed on an invalid body (forged/corrupt decision row)", async () => {
    const d = deps();
    const r = await createStandingOrderFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: { prompt: "x" } },
      d,
    );
    expect(r.ok).toBe(false);
    expect(d.upsertScheduleRow).not.toHaveBeenCalled();
  });

  it("fail-closed on an invalid cron expression", async () => {
    const d = deps();
    const r = await createStandingOrderFromDecision(
      "t1",
      { cron_expression: "not a cron", standing_order: goodOrder },
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cron/);
    expect(d.upsertScheduleRow).not.toHaveBeenCalled();
  });

  it("surfaces a schedule write failure as ok:false", async () => {
    const r = await createStandingOrderFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: goodOrder },
      {
        upsertScheduleRow: async () => ({ error: { message: "boom" } }),
        validateCron: validateCronExpression,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
  });
});

describe("createResearchWatchFromDecision (dispatch-handler core)", () => {
  const deps = () => ({
    upsertScheduleRow: vi.fn(async () => ({ error: null })),
    validateCron: validateCronExpression,
  });

  it("locks agent_slug to 'research' (NOT operator) and writes the validated template", async () => {
    const d = deps();
    const r = await createResearchWatchFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: goodOrder },
      d,
    );
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/Research watch active/);
    expect(d.upsertScheduleRow).toHaveBeenCalledWith({
      tenant_id: "t1",
      agent_slug: "research",
      cron_expression: "0 16 * * 1",
      enabled: true,
      payload_template: { standing_order: goodOrder },
    });
  });

  it("a forged body cannot retarget the schedule at another agent (slug is a param, not from body)", async () => {
    const d = deps();
    const r = await createResearchWatchFromDecision(
      "t1",
      {
        cron_expression: "0 16 * * 1",
        standing_order: goodOrder,
        agent_slug: "engineer",
      } as unknown,
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.upsertScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({ agent_slug: "research" }),
    );
  });

  it("fail-closed on an invalid body / cron (forged or corrupt decision row)", async () => {
    const d = deps();
    const badBody = await createResearchWatchFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: { prompt: "x" } },
      d,
    );
    expect(badBody.ok).toBe(false);
    const badCron = await createResearchWatchFromDecision(
      "t1",
      { cron_expression: "not a cron", standing_order: goodOrder },
      d,
    );
    expect(badCron.ok).toBe(false);
    expect(d.upsertScheduleRow).not.toHaveBeenCalled();
  });

  it("surfaces a schedule write failure as ok:false", async () => {
    const r = await createResearchWatchFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: goodOrder },
      {
        upsertScheduleRow: async () => ({ error: { message: "boom" } }),
        validateCron: validateCronExpression,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
  });
});

describe("composeStandingOrderBody", () => {
  it("success carries the brief; failure is an honest one-liner", () => {
    expect(
      composeStandingOrderBody({ status: "success", output_text: "GMV: $23K", error: null }),
    ).toContain("GMV: $23K");
    const fail = composeStandingOrderBody({
      status: "error",
      output_text: null,
      error: "boot_reap: orphaned by container restart (worker died mid-run)",
    });
    expect(fail).toContain("did not complete");
    expect(fail).not.toContain("boot_reap");
    expect(fail).not.toContain("orphaned");
    expect(fail).toMatch(/temporary|hiccup|transient|connect/i);

    const conn = composeStandingOrderBody({
      status: "error",
      output_text: null,
      error: "slack_not_connected",
    });
    expect(conn).toContain("did not complete");
    expect(conn).toMatch(/Connect Slack/i);
  });

  it("sanitizes infra-reap / watchdog / inngest raw errors out of the delivered body", () => {
    const bootReap = composeStandingOrderBody({
      status: "failed",
      output_text: null,
      error: "boot_reap: orphaned by container restart (worker died mid-run)",
    });
    expect(bootReap).toContain("did not complete");
    expect(bootReap).not.toContain("boot_reap");
    expect(bootReap).not.toContain("orphaned");

    const watchdog = composeStandingOrderBody({
      status: "failed",
      output_text: null,
      error: "watchdog_reap: stale at 2026-06-13T00:00:00Z",
    });
    expect(watchdog).toContain("did not complete");
    expect(watchdog).not.toContain("watchdog_reap");

    const exhausted = composeStandingOrderBody({
      status: "error",
      output_text: null,
      error: "exhausted retries",
    });
    expect(exhausted).toContain("did not complete");
    expect(exhausted).not.toContain("exhausted retries");
  });

  it("falls back to a status line when there is no error string", () => {
    const fail = composeStandingOrderBody({
      status: "cancelled",
      output_text: null,
      error: null,
    });
    expect(fail).toContain("did not complete");
    expect(fail).toContain("cancelled");
  });

  it("caps the body at the thread-message bound", () => {
    const body = composeStandingOrderBody({
      status: "success",
      output_text: "y".repeat(50000),
      error: null,
    });
    expect(body.length).toBeLessThanOrEqual(32000);
  });
});

describe("deliverStandingOrderResult", () => {
  const baseArgs = {
    tenant_id: "t1",
    run_id: "r1",
    status: "success" as const,
    output_text: "47 stalled approvals",
    error: null,
  };
  const mkDeps = () => ({
    postToThread: vi.fn(
      async (_args: { thread_id: string; tenant_id: string; run_id: string; body: string }) =>
        null as string | null,
    ),
    postToSlack: vi.fn(
      async (_args: { tenant_id: string; run_id: string; channel_id: string; text: string }) =>
        null as string | null,
    ),
    postToEmail: vi.fn(
      async (_args: {
        tenant_id: string;
        run_id: string;
        agent_slug: string;
        body: string;
      }) => null as string | null,
    ),
    scrub: (t: string) => t,
  });

  it("routes chat_thread delivery to postToThread with the payload's thread id", async () => {
    const deps = mkDeps();
    const err = await deliverStandingOrderResult(
      { ...baseArgs, payload: { standing_order: goodOrder } },
      deps,
    );
    expect(err).toBeNull();
    expect(deps.postToThread).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: THREAD_ID, tenant_id: "t1" }),
    );
    expect(deps.postToSlack).not.toHaveBeenCalled();
  });

  it("routes slack_channel delivery to postToSlack", async () => {
    const deps = mkDeps();
    const err = await deliverStandingOrderResult(
      {
        ...baseArgs,
        payload: {
          standing_order: {
            prompt: "p",
            deliver: { kind: "slack_channel", channel_id: "C0123ABC" },
          },
        },
      },
      deps,
    );
    expect(err).toBeNull();
    expect(deps.postToSlack).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "C0123ABC" }),
    );
    expect(deps.postToThread).not.toHaveBeenCalled();
  });

  it("routes email delivery to postToEmail, carrying NO address in the payload", async () => {
    const deps = mkDeps();
    const err = await deliverStandingOrderResult(
      {
        ...baseArgs,
        agent_slug: "operator",
        payload: {
          standing_order: { prompt: "p", deliver: { kind: "email" } },
        },
      },
      deps,
    );
    expect(err).toBeNull();
    expect(deps.postToEmail).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", agent_slug: "operator" }),
    );
    const emailCall = deps.postToEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(emailCall)).not.toContain("email");
    expect(Object.keys(emailCall)).not.toContain("to");
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.postToSlack).not.toHaveBeenCalled();
  });

  it("rejects an email deliver that tries to name its own address", async () => {
    const deps = mkDeps();
    const err = await deliverStandingOrderResult(
      {
        ...baseArgs,
        payload: {
          standing_order: {
            prompt: "p",
            deliver: { kind: "email", to: "attacker@evil.com" },
          },
        },
      },
      deps,
    );
    expect(err).toBeNull();
    const emailCall = deps.postToEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(emailCall)).not.toContain("attacker@evil.com");
  });

  it("fail-closed on a malformed standing_order payload (no delivery)", async () => {
    const deps = mkDeps();
    const err = await deliverStandingOrderResult(
      { ...baseArgs, payload: { standing_order: { prompt: "p" } } },
      deps,
    );
    expect(err).toMatch(/malformed/);
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.postToSlack).not.toHaveBeenCalled();
    expect(deps.postToEmail).not.toHaveBeenCalled();
  });

  it("scrubs the body before delivery", async () => {
    const deps = mkDeps();
    deps.scrub = (t: string) => t.replace("47", "[n]");
    await deliverStandingOrderResult(
      { ...baseArgs, payload: { standing_order: goodOrder } },
      deps,
    );
    const call = deps.postToThread.mock.calls[0][0];
    expect(call.body).toContain("[n]");
    expect(call.body).not.toContain("47");
  });
});

import {
  createChannelStandingOrderFromDecision,
  standingOrderThreadOwners,
} from "@/services/agents/standing-orders";

describe("channel standing orders", () => {
  const deps = () => ({
    upsertScheduleRow: vi.fn(async () => ({ error: null })),
    validateCron: validateCronExpression,
  });
  const body = {
    cron_expression: "0 13 * * *",
    timezone: "Asia/Calcutta",
    standing_order: { ...goodOrder, prompt: "x".repeat(4900) },
  };

  it("the prompt cap fits a whole daily brief (5000), not an operator one-liner", () => {
    expect(STANDING_ORDER_PROMPT_MAX).toBe(5000);
    expect(validatePayloadTemplate({ standing_order: body.standing_order }).ok).toBe(true);
    expect(
      validatePayloadTemplate({
        standing_order: { ...goodOrder, prompt: "x".repeat(5001) },
      }).ok,
    ).toBe(false);
  });

  it("writes the run's channel slug + timezone; the slug comes from the caller, never the body", async () => {
    const d = deps();
    const r = await createChannelStandingOrderFromDecision(
      "t1",
      { ...body, agent_slug: "engineer" },
      d,
      "x_organic",
    );
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/X schedule active/);
    expect(r.notice).toMatch(/Asia\/Calcutta/);
    expect(d.upsertScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        agent_slug: "x_organic",
        cron_expression: "0 13 * * *",
        timezone: "Asia/Calcutta",
        enabled: true,
      }),
    );
  });

  it("refuses a run slug that owns no channel (wiring bug, not a schedule)", async () => {
    const d = deps();
    for (const slug of ["operator", "engineer", "research"]) {
      const r = await createChannelStandingOrderFromDecision("t1", body, d, slug);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/does not own a channel/);
    }
    expect(d.upsertScheduleRow).not.toHaveBeenCalled();
  });

  it("refuses a bad timezone and accepts a row with none (UTC, pre-2026-09-10 shape)", async () => {
    const d = deps();
    const bad = await createChannelStandingOrderFromDecision(
      "t1",
      { ...body, timezone: "Mars/Olympus" },
      d,
      "x_organic",
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/invalid timezone/);
    expect(d.upsertScheduleRow).not.toHaveBeenCalled();

    const { timezone: _tz, ...noTz } = body;
    const ok = await createChannelStandingOrderFromDecision("t1", noTz, d, "x_organic");
    expect(ok.ok).toBe(true);
    const written = (d.upsertScheduleRow.mock.calls[0] as unknown[])[0];
    expect(written).not.toHaveProperty("timezone");
  });

  it("the operator wrapper still ignores timezone-less bodies byte-identically", async () => {
    const d = deps();
    await createStandingOrderFromDecision(
      "t1",
      { cron_expression: "0 16 * * 1", standing_order: goodOrder },
      d,
    );
    expect(d.upsertScheduleRow).toHaveBeenCalledWith({
      tenant_id: "t1",
      agent_slug: "operator",
      cron_expression: "0 16 * * 1",
      enabled: true,
      payload_template: { standing_order: goodOrder },
    });
  });

  it("a channel agent may deliver into its own thread OR the operator's; others only their own", () => {
    expect(standingOrderThreadOwners("x_organic")).toEqual(["x_organic", "operator"]);
    expect(standingOrderThreadOwners("meta_ads")).toEqual(["meta_ads", "operator"]);
    expect(standingOrderThreadOwners("operator")).toEqual(["operator"]);
    expect(standingOrderThreadOwners("research")).toEqual(["research"]);
  });

  it("failure copy is keyed on the run's own slug", () => {
    const body = composeStandingOrderBody({
      status: "failed",
      output_text: null,
      error: "boot_reap",
      agent_slug: "x_organic",
    });
    expect(body).toMatch(/Scheduled brief/);
    expect(body).not.toMatch(/boot_reap/);
  });
});
