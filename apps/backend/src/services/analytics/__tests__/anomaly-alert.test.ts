
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { renderIncidentSlack, renderIncidentEmail, sendIncidentAlert, formatValue, type IncidentAlert, type AlertSendDeps } from "../anomaly-alert";

const base: IncidentAlert = {
  tenant_id: "tenant-a",
  incident_id: "inc-1",
  notice_seq: 1,
  companyName: "Acme",
  kind: "opened",
  primary: { kind: "anomaly", label: "Sessions", unit: "count", currency: null, date: "2026-09-27", direction: "down", value: 412, typical: 1180, severity: 4.6 },
  supporting: [{ label: "Search clicks", unit: "count", currency: null, direction: "down", value: 80, typical: 310 }],
  contributors: [
    { dimension: "source_medium", segment: "google / organic", share_pct: 78.4, confidence: "high" },
    { dimension: "device", segment: "mobile", share_pct: 64, confidence: "high" },
  ],
  woke: true,
  workspaceUrl: "https://www.zaviagent.com/workspace?company=tenant-a",
  muteUrl: "https://www.zaviagent.com/workspace?company=tenant-a&mute_alert=sessions",
};

function deps(over: Partial<AlertSendDeps> = {}) {
  return {
    slackDmChannel: vi.fn(async () => ({ channel: "D123", team_id: "T1", user: "U1" }) as { channel: string; team_id: string | null; user: string } | null),
    enqueueSlack: vi.fn(async () => true),
    ownerEmail: vi.fn(async () => "founder@acme.com" as string | null),
    sendEmail: vi.fn(async () => undefined),
    ...over,
  };
}

describe("routing: Slack OR email, never both", () => {
  it("Slack connected: one DM, no email, keyed per incident notice", async () => {
    const d = deps();
    expect(await sendIncidentAlert(base, d)).toBe("slack");
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.enqueueSlack).toHaveBeenCalledTimes(1);
    expect(d.enqueueSlack).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a", channel: "D123", key: "metric_incident:inc-1:1" }));
  });

  it("no Slack: one email to the owner", async () => {
    const d = deps({ slackDmChannel: vi.fn(async () => null) });
    expect(await sendIncidentAlert(base, d)).toBe("email");
    expect(d.enqueueSlack).not.toHaveBeenCalled();
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
    expect(d.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a", to: "founder@acme.com" }));
  });

  it("Slack connected but the DM could not be queued or looked up: email instead", async () => {
    const d1 = deps({ enqueueSlack: vi.fn(async () => false) });
    expect(await sendIncidentAlert(base, d1)).toBe("email");
    const d2 = deps({ slackDmChannel: vi.fn(async () => Promise.reject(new Error("ratelimited"))) });
    expect(await sendIncidentAlert(base, d2)).toBe("email");
  });

  it("no Slack and no owner email: nothing sent", async () => {
    const d = deps({ slackDmChannel: vi.fn(async () => null), ownerEmail: vi.fn(async () => null) });
    expect(await sendIncidentAlert(base, d)).toBe("none");
    expect(d.sendEmail).not.toHaveBeenCalled();
  });
});

describe("copy", () => {
  it("an opened incident leads with the problem, lists what else moved, and calls segments contributors", () => {
    const s = renderIncidentSlack(base);
    expect(s.split("\n")[0]).toBe("*Acme: Problem: Sessions fell to 412 on Sun, Sep 27*");
    expect(s).toContain("A normal Sunday is about 1,180, so this is far outside its normal range for the last 8 weeks.");
    expect(s).toContain("*Also moving*\n• Search clicks fell to 80 (normal about 310)");
    expect(s).toContain("*Possible contributors (moved with it, not proven causes)*");
    expect(s).toContain("• google / organic (source / medium): 78% of the change, high confidence");
    expect(s).not.toMatch(/drove|driver|caused by/i);
    expect(s).toContain("Your head of growth is looking into it");
    expect(s).toContain("<https://www.zaviagent.com/workspace?company=tenant-a&mute_alert=sessions|Mute alerts for this metric>");
  });

  it("a worsened incident says so; a runaway cost rises", () => {
    const w = renderIncidentEmail({ ...base, kind: "worsened", notice_seq: 2, woke: false });
    expect(w.subject).toBe("Acme: Getting worse: Sessions fell to 412 on Sun, Sep 27");
    expect(w.text).not.toContain("looking into it");
    expect(w.text).toContain("Mute alerts for this metric: https://www.zaviagent.com/workspace?company=tenant-a&mute_alert=sessions");
    const spend = renderIncidentEmail({
      ...base,
      primary: { kind: "anomaly", label: "Meta ad spend", unit: "currency", currency: "USD", date: "2026-09-27", direction: "up", value: 2400, typical: 310, severity: 6 },
      supporting: [],
      contributors: [],
    });
    expect(spend.subject).toBe("Acme: Problem: Meta ad spend rose to $2,400 on Sun, Sep 27");
    expect(spend.text).not.toContain("Possible contributors");
  });

  it("tracking symptoms read as tracking, not demand", () => {
    const zero = renderIncidentSlack({ ...base, primary: { ...base.primary, kind: "zero", value: 0, typical: null }, supporting: [], contributors: [] });
    expect(zero).toContain("Problem: Sessions dropped to zero on Sun, Sep 27");
    expect(zero).toContain("usually means tracking broke rather than demand");
    const failed = renderIncidentSlack({ ...base, primary: { ...base.primary, kind: "read_failed", label: "Google Analytics", value: null, typical: null }, supporting: [], contributors: [] });
    expect(failed).toContain("Problem: Zavi could not read Google Analytics on Sun, Sep 27");
  });

  it("no em-dashes and no raw z anywhere", () => {
    const all = [renderIncidentSlack(base), ...Object.values(renderIncidentEmail(base))].join("\n");
    expect(all).not.toMatch(/—/);
    expect(all).not.toMatch(/\bz\s*=|4\.6/);
  });

  it("escapes outside data (a campaign name) for Slack and HTML", () => {
    const evil = { ...base, contributors: [{ dimension: "campaign" as const, segment: "<!channel> *win* & <b>", share_pct: 90, confidence: "high" as const }] };
    const s = renderIncidentSlack(evil);
    expect(s).not.toContain("<!channel>");
    expect(s).toContain("&lt;!channel&gt;");
    const e = renderIncidentEmail(evil);
    expect(e.html).not.toContain("<b>");
    expect(e.html).toContain("&lt;b&gt;");
  });

  it("formats values by unit", () => {
    expect(formatValue(0.0234, "ratio", null)).toBe("2.3%");
    expect(formatValue(12345.6, "currency", "USD")).toBe("$12,346");
    expect(formatValue(1500, "currency", "EUR")).toBe("€1,500");
    expect(formatValue(1234.4, "count", null)).toBe("1,234");
  });
});
