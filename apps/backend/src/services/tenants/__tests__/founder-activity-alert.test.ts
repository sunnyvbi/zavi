import { beforeEach, describe, it, expect, vi } from "vitest";

import {
  notifyFounderActivity,
  renderFounderAlert,
  dedupeKey,
  founderAlertRecipients,
  __resetFounderAlertMemo,
  FOUNDER_ALERT_EVENTS,
  DEFAULT_EMAILED_EVENTS,
  paywallFounderEvent,
} from "../founder-activity-alert";

type Row = Record<string, unknown>;

function fakeClient(
  tables: Record<string, Row[]>,
  email: string | null = "founder@acme.com",
  failing: string[] = [],
) {
  const builder = (table: string, rows: Row[]) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () =>
      failing.includes(table)
        ? { data: null, error: { message: "boom" } }
        : { data: rows[0] ?? null, error: null };
    return b;
  };
  return {
    from: (table: string) => builder(table, tables[table] ?? []),
    auth: { admin: { getUserById: async () => ({ data: { user: { email } }, error: null }) } },
  };
}

const NOW = new Date("2026-09-23T12:00:00Z");
const REAL = { slug: "acme", display_name: "Acme", kind: "real" };

function deps(tables: Record<string, Row[]> = { tenants: [REAL] }, enabled = true) {
  return {
    sgSend: vi.fn(async (_to: string, _s: string, _h: string, _t: string) => {}),
    serviceClient: () => fakeClient(tables),
    getBoolSetting: vi.fn(async () => enabled),
    emailedEvents: async () => Object.keys(FOUNDER_ALERT_EVENTS),
    setTenantSetting: vi.fn(async (_t: string, _k: string, _v: unknown, _by: string) => {}),
    now: () => NOW,
  };
}

beforeEach(() => {
  __resetFounderAlertMemo();
  delete process.env.FOUNDER_ACTIVITY_ALERT_EMAILS;
});

describe("recipients", () => {
  it("defaults to Ravi and Tarun, env CSV overrides", () => {
    expect(founderAlertRecipients()).toEqual(["ravi@zaviagent.com", "tarun@zaviagent.com"]);
    process.env.FOUNDER_ACTIVITY_ALERT_EMAILS = " a@x.com , b@x.com,";
    expect(founderAlertRecipients()).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("notifyFounderActivity", () => {
  it("emails every recipient for an anonymous launch-video request, no dedupe write", async () => {
    const d = deps({});
    const out = await notifyFounderActivity(
      { event: "launch_video_requested", email: "v@lead.com", details: { company: "Lead Co" } },
      d,
    );
    expect(out).toEqual({ sent: true });
    expect(d.sgSend.mock.calls.map((c) => c[0])).toEqual(["ravi@zaviagent.com", "tarun@zaviagent.com"]);
    expect(d.sgSend.mock.calls[0][1]).toContain("Launch video requested");
    expect(d.sgSend.mock.calls[0][3]).toContain("Lead Co");
    expect(d.setTenantSetting).not.toHaveBeenCalled();
  });

  it("once-per-tenant: sends, records the key, then skips", async () => {
    const d = deps();
    const first = await notifyFounderActivity({ event: "first_chat_message", tenant_id: "t1", user_id: "u1" }, d);
    expect(first).toEqual({ sent: true });
    expect(d.setTenantSetting).toHaveBeenCalledWith(
      "t1",
      "founder_alerts_sent",
      { first_chat_message: NOW.toISOString() },
      "u1",
    );
    const again = await notifyFounderActivity({ event: "first_chat_message", tenant_id: "t1" }, d);
    expect(again).toEqual({ sent: false, reason: "already_sent" });
    expect(d.sgSend).toHaveBeenCalledTimes(2);
  });

  it("skips when the stored map already has the key (fresh process)", async () => {
    const d = deps({
      tenants: [REAL],
      tenant_app_setting: [{ value: { first_channel_run: "2026-09-20T00:00:00Z" } }],
    });
    const out = await notifyFounderActivity({ event: "first_channel_run", tenant_id: "t1" }, d);
    expect(out).toEqual({ sent: false, reason: "already_sent" });
    expect(d.sgSend).not.toHaveBeenCalled();
  });

  it("does not send when the sent map cannot be read", async () => {
    const d = { ...deps(), serviceClient: () => fakeClient({ tenants: [REAL] }, "f@a.com", ["tenant_app_setting"]) };
    const out = await notifyFounderActivity({ event: "first_chat_message", tenant_id: "t1" }, d);
    expect(out).toEqual({ sent: false, reason: "sent_map_read_failed: boom" });
    expect(d.sgSend).not.toHaveBeenCalled();
    expect(d.setTenantSetting).not.toHaveBeenCalled();
  });

  it("keeps earlier keys when adding a new one", async () => {
    const d = deps({ tenants: [REAL], tenant_app_setting: [{ value: { first_chat_message: "x" } }] });
    await notifyFounderActivity({ event: "first_approval", tenant_id: "t1" }, d);
    expect(d.setTenantSetting.mock.calls[0][2]).toEqual({ first_chat_message: "x", first_approval: NOW.toISOString() });
  });

  it("skips test and dogfood tenants", async () => {
    const t = deps({ tenants: [{ ...REAL, kind: "test" }] });
    expect(await notifyFounderActivity({ event: "first_chat_message", tenant_id: "t1" }, t)).toEqual({
      sent: false,
      reason: "skipped_test_tenant",
    });
    const g = deps({ tenants: [{ ...REAL, slug: "upcar-ai" }] });
    expect(await notifyFounderActivity({ event: "first_chat_message", tenant_id: "t2" }, g)).toEqual({
      sent: false,
      reason: "skipped_dogfood_tenant",
    });
    expect(t.sgSend).not.toHaveBeenCalled();
    expect(g.sgSend).not.toHaveBeenCalled();
  });

  it("respects the global mute", async () => {
    const d = deps(undefined, false);
    expect(await notifyFounderActivity({ event: "feedback_submitted", tenant_id: "t1" }, d)).toEqual({
      sent: false,
      reason: "muted",
    });
    expect(d.sgSend).not.toHaveBeenCalled();
  });

  it("sends only events on the emailed list (default: paywall + feedback)", async () => {
    const d = { ...deps(), emailedEvents: async () => DEFAULT_EMAILED_EVENTS };
    expect(await notifyFounderActivity({ event: "first_chat_message", tenant_id: "t1" }, d)).toEqual({
      sent: false,
      reason: "event_muted",
    });
    expect(d.sgSend).not.toHaveBeenCalled();
    const out = await notifyFounderActivity({ event: "feedback_submitted", tenant_id: "t1" }, d);
    expect(out).toMatchObject({ sent: true });
  });

  it("does not record the key when every send fails, so the next occurrence retries", async () => {
    const d = deps();
    d.sgSend.mockRejectedValue(new Error("sendgrid down"));
    const out = await notifyFounderActivity({ event: "website_published", tenant_id: "t1" }, d);
    expect(out).toEqual({ sent: false, reason: "send_failed" });
    expect(d.setTenantSetting).not.toHaveBeenCalled();
  });

  it("never throws, even when a dependency does", async () => {
    const d = deps();
    d.getBoolSetting.mockRejectedValue(new Error("db down"));
    await expect(notifyFounderActivity({ event: "first_connector", tenant_id: "t1" }, d)).resolves.toEqual({
      sent: false,
      reason: "db down",
    });
  });
});

describe("paywallFounderEvent (a plan wall is not running out of credits)", () => {
  it("files a plan wall as plan_upgrade_required and every credit wall as out_of_credits", () => {
    expect(paywallFounderEvent("plan_upgrade_required")).toBe("plan_upgrade_required");
    expect(paywallFounderEvent("insufficient_credits")).toBe("out_of_credits");
    expect(paywallFounderEvent("build_credits_exhausted")).toBe("out_of_credits");
  });

  it("keeps plan walls emailed by default, once per tenant per day, with their own label", async () => {
    expect(DEFAULT_EMAILED_EVENTS).toContain("plan_upgrade_required");
    expect(dedupeKey("plan_upgrade_required", NOW)).toBe("plan_upgrade_required:2026-09-23");
    const d = { ...deps(), emailedEvents: async () => DEFAULT_EMAILED_EVENTS };
    expect(await notifyFounderActivity({ event: "plan_upgrade_required", tenant_id: "t1" }, d)).toMatchObject({ sent: true });
    expect(d.sgSend.mock.calls[0][1]).toContain("Hit a plan wall");
    expect(d.sgSend.mock.calls[0][1]).not.toContain("credits");
  });
});

describe("dedupeKey", () => {
  it("is per UTC day for out_of_credits and null for feedback", () => {
    expect(dedupeKey("out_of_credits", NOW)).toBe("out_of_credits:2026-09-23");
    expect(dedupeKey("first_chat_message", NOW)).toBe("first_chat_message");
    expect(dedupeKey("feedback_submitted", NOW)).toBeNull();
  });
});

describe("renderFounderAlert", () => {
  it("escapes html and drops empty details", () => {
    const r = renderFounderAlert({
      event: "feedback_submitted",
      company: "<Acme>",
      email: "f@acme.com",
      tenant_id: "t1",
      details: { feedback: "<script>x</script>", empty: "", missing: null },
      at: NOW.toISOString(),
    });
    expect(r.subject).toBe("Zavi: Feedback submitted by <Acme> (f@acme.com)");
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.text).not.toContain("empty");
    expect(r.text).toContain("/tenants/t1");
  });
});
