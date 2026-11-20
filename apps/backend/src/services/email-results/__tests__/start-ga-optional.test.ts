import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shaOf } from "@/services/email-cards/variants";
import { startEmailSendResult, type ResultRow, type StartDeps } from "../start";

const ga = vi.hoisted(() => ({ creds: vi.fn() }));
vi.mock("@/services/tools/google-analytics/_client", () => ({ googleAnalyticsCreds: ga.creds }));

const T = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-27T12:00:00Z");

const content = { subject: "Members update", preview_text: "", title: "Hello", paragraphs: ["Hi"], button: { label: "Read", url: "https://northwind.test/a" } };
const variant = { content, html: "<p>x</p>", text: "x", render_sha: shaOf("r1", "<p>x</p>", "x") };
const snapshot = {
  logo_url: null, brand_color: "#112233", button_color: "#112233", font_key: "system", sign_off: "Thanks", postal_address: "1 Main St",
  show_cards: false, company_name: "Northwind", own_host: "northwind.test", campaign_slug: "members-20261027-abcdefghij",
};
const card = {
  class: "bulk_outbound.send",
  body: { list_id: "11111111-1111-4111-8111-111111111111", list_version_id: "22222222-2222-4222-8222-222222222222", list_name: "Members", from_address: "news@northwind.test", variants: [variant], template_snapshot: snapshot, renderer_version: "r1", chosen_variant: 1 },
  progress: null,
  ended_at: null,
};
const bulk = { id: "bb50596f", status: "done", sent: 4, total: 4, created_at: "2026-10-27T11:00:00Z", finished_at: "2026-10-27T11:01:00Z" };

function harness() {
  const rows: ResultRow[] = [];
  const winArgs: Array<{ gaConnected: boolean }> = [];
  const deps: Partial<StartDeps> = {
    readCard: async () => card,
    readRef: async () => null,
    readBulk: async () => bulk,
    slugTaken: async () => false,
    winLine: async (_t, a) => {
      winArgs.push(a);
      return { metric: a.gaConnected ? "visitors" : "clicks", threshold: null, basis: "first_sends", n_past: 0 };
    },
    rpc: async (_t, row) => {
      rows.push(row);
      return { ok: true, created: true };
    },
    now: () => NOW,
  };
  return { deps, rows, winArgs };
}

describe("a finished Zavi-list send starts its results row unless GA read failed only for now", () => {
  const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
  let warn: ReturnType<typeof spyWarn>;
  beforeEach(() => {
    ga.creds.mockReset();
    warn = spyWarn();
  });
  afterEach(() => warn.mockRestore());

  const failures: Array<[string, unknown]> = [
    ["GA not configured on this deployment", Object.assign(new Error("Google Analytics is not configured on this Praxis deployment"), { code: "google_analytics_not_configured" })],
    ["GA's refresh token is rejected", Object.assign(new Error("refresh failed"), { code: "google_analytics_oauth_refresh_failed" })],
  ];

  const passing: Array<[string, unknown]> = [
    ["GA temporarily unavailable", Object.assign(new Error("Google Analytics could not be checked right now"), { code: "google_analytics_unavailable" })],
    ["a plain network error", new Error("fetch failed")],
  ];

  it.each(passing)("%s twice: no row starts, so the repair sweep starts it once GA reads again", async (_label, err) => {
    ga.creds.mockRejectedValue(err);
    const h = harness();
    await expect(startEmailSendResult({ tenant_id: T, rail: "decisions", card_id: "2bede3b0" }, h.deps)).rejects.toBe(err);
    expect(ga.creds).toHaveBeenCalledTimes(2);
    expect(h.rows).toHaveLength(0);
  });

  it.each(failures)("%s: the row still starts, with no GA property and a clicks win line", async (_label, err) => {
    ga.creds.mockRejectedValue(err);
    const h = harness();
    const out = await startEmailSendResult({ tenant_id: T, rail: "decisions", card_id: "2bede3b0" }, h.deps);
    expect(out).toEqual({ started: true });
    expect(ga.creds).toHaveBeenCalledTimes(2);
    expect(ga.creds).toHaveBeenCalledWith(T);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ route: "zavi_list", provider_ref: "bb50596f", sent_count: 4, ga_property_id: null, win_line: { metric: "clicks" } });
    expect(h.winArgs[0].gaConnected).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(T);
  });

  it("GA not connected is the normal no-GA case and is not warned about", async () => {
    ga.creds.mockRejectedValue(Object.assign(new Error("not connected"), { code: "google_analytics_not_connected" }));
    const h = harness();
    expect(await startEmailSendResult({ tenant_id: T, rail: "decisions", card_id: "2bede3b0" }, h.deps)).toEqual({ started: true });
    expect(h.rows[0].ga_property_id).toBeNull();
    expect(ga.creds).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a GA timeout on the first read is retried, and the property it then returns is frozen with a visitors win line", async () => {
    ga.creds
      .mockRejectedValueOnce(Object.assign(new Error("GA request timed out"), { code: "google_analytics_unavailable" }))
      .mockResolvedValueOnce({ property_id: "987654", auth: {} })
      .mockRejectedValue(new Error("a third read must not happen"));
    const h = harness();
    expect(await startEmailSendResult({ tenant_id: T, rail: "decisions", card_id: "2bede3b0" }, h.deps)).toEqual({ started: true });
    expect(ga.creds).toHaveBeenCalledTimes(2);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ ga_property_id: "987654", win_line: { metric: "visitors" } });
    expect(h.winArgs).toEqual([expect.objectContaining({ gaConnected: true })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a connected GA property is still frozen on the row", async () => {
    ga.creds.mockResolvedValue({ property_id: "123456", auth: {} });
    const h = harness();
    expect(await startEmailSendResult({ tenant_id: T, rail: "decisions", card_id: "2bede3b0" }, h.deps)).toEqual({ started: true });
    expect(h.rows[0]).toMatchObject({ ga_property_id: "123456", win_line: { metric: "visitors" } });
    expect(warn).not.toHaveBeenCalled();
  });
});
