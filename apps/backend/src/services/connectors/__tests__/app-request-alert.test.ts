import { describe, it, expect, vi } from "vitest";
import { recordAppRequest, renderAppRequestEmail } from "../app-request-alert";

function deps(over: Partial<Record<string, unknown>> = {}) {
  const sent: unknown[][] = [];
  const d = {
    insertRequest: vi.fn(async () => ({ inserted: true })),
    tenant: vi.fn(async () => ({ slug: "acme-co", display_name: "Acme Co", kind: "real" })),
    founderEmail: vi.fn(async () => "f@acme.co"),
    countTenants: vi.fn(async () => 3),
    sgSend: vi.fn(async (...a: unknown[]) => { sent.push(a); }),
    now: () => new Date("2026-09-25T10:00:00Z"),
    ...over,
  };
  return { sent, d: d as typeof d & Record<string, any> };
}

describe("recordAppRequest", () => {
  it("emails once with app, company, founder email, time, and count", async () => {
    const { d, sent } = deps();
    expect(await recordAppRequest({ tenant_id: "T1", user_id: "U1", app_slug: "acme_crm", app_name: "Acme CRM" }, d)).toEqual({ requested: true, emailed: true });
    expect(d.insertRequest).toHaveBeenCalledWith("T1", "acme_crm", "U1");
    expect(sent[0][0]).toBe(process.env.NEW_TENANT_ALERT_EMAIL ?? "ravi@zaviagent.com");
    expect(sent[0][1]).toBe("App request: Acme CRM from Acme Co");
    const text = String(sent[0][3]);
    expect(text).toContain("App: Acme CRM");
    expect(text).toContain("Acme Co (T1)");
    expect(text).toContain("f@acme.co");
    expect(text).toContain("2026-09-25T10:00:00.000Z");
    expect(text).toContain("Tenants that asked for this app: 3");
  });

  it("second click from the same tenant does not email again", async () => {
    const { d } = deps({ insertRequest: vi.fn(async () => ({ inserted: false })) });
    expect(await recordAppRequest({ tenant_id: "T1", user_id: "U1", app_slug: "x", app_name: "X" }, d)).toEqual({ requested: true, emailed: false });
    expect(d.sgSend).not.toHaveBeenCalled();
  });

  it("test tenants and dogfood slugs never email but still record", async () => {
    for (const t of [
      { slug: "q", display_name: "Q", kind: "test" },
      { slug: "upcar-ai", display_name: "U", kind: "real" },
      { slug: "upcar-private", display_name: "P", kind: "real" },
      { slug: "apna-tutor-dogfood", display_name: "A", kind: "real" },
    ]) {
      const { d } = deps({ tenant: vi.fn(async () => t) });
      expect((await recordAppRequest({ tenant_id: "T", user_id: "U", app_slug: "x", app_name: "X" }, d)).emailed).toBe(false);
      expect(d.insertRequest).toHaveBeenCalled();
      expect(d.sgSend).not.toHaveBeenCalled();
    }
  });

  it("a failed email still reports the request as recorded", async () => {
    const { d } = deps({ sgSend: vi.fn(async () => { throw new Error("sendgrid down"); }) });
    expect(await recordAppRequest({ tenant_id: "T1", user_id: "U1", app_slug: "x", app_name: "X" }, d)).toEqual({ requested: true, emailed: false });
  });

  it("a failed insert throws (the request was not recorded)", async () => {
    const { d } = deps({ insertRequest: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(recordAppRequest({ tenant_id: "T1", user_id: "U1", app_slug: "x", app_name: "X" }, d)).rejects.toThrow("db down");
    expect(d.sgSend).not.toHaveBeenCalled();
  });
});

describe("renderAppRequestEmail", () => {
  it("escapes HTML in names", () => {
    const m = renderAppRequestEmail({ app: "<b>", company: "A&B", tenant_id: "T", email: null, at: new Date(0), count: 1 });
    expect(m.html).toContain("&lt;b&gt;");
    expect(m.html).toContain("A&amp;B");
    expect(m.text).toContain("Requested by: unknown");
  });
});
