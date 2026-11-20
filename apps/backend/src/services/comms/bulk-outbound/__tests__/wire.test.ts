import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tools/email/safety-net", () => ({
  unsubscribeUrl: (t: string) => `https://api.zaviagent.com/api/email/unsubscribe?token=${t}`,
  unsubscribeHeaders: (t: string) => ({
    "List-Unsubscribe": `<https://api.zaviagent.com/api/email/unsubscribe?token=${t}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }),
}));

import { buildBulkPayload, sendBulkEmail, type BulkWireMessage } from "../wire";

const MSG: BulkWireMessage = {
  tenantId: "tenant-a",
  sendId: "send-1",
  to: "ada@example.com",
  from: { email: "hello@acme.com", name: "Acme" },
  replyTo: "founder@acme.com",
  subject: "Hello",
  bodyText: "Come back.",
  unsubToken: "tok-1",
  postalAddress: "1 Main St, Austin TX",
};
const KEYS = ["BULK_SENDGRID_API_KEY", "SYSTEM_SENDGRID_API_KEY", "PROVISION_EMAIL_SENDGRID_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

describe("bulk wire sender", () => {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.BULK_SENDGRID_API_KEY = "bulk-key";
    process.env.SYSTEM_SENDGRID_API_KEY = "system-key";
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "provision-key";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("one recipient, From the founder's domain, unsubscribe header, and a visible footer in text AND html", () => {
    const p = buildBulkPayload(MSG) as any;
    expect(p.personalizations).toEqual([{ to: [{ email: "ada@example.com" }] }]);
    expect(p.from).toEqual({ email: "hello@acme.com", name: "Acme" });
    expect(p.reply_to).toEqual({ email: "founder@acme.com" });
    expect(p.headers["List-Unsubscribe"]).toBe("<https://api.zaviagent.com/api/email/unsubscribe?token=tok-1>");
    expect(p.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(p.custom_args).toEqual({ tenant_id: "tenant-a", bulk_send_id: "send-1" });
    expect(p.tracking_settings).toEqual({ open_tracking: { enable: true }, click_tracking: { enable: false, enable_text: false } });
    const text = p.content.find((c: any) => c.type === "text/plain").value;
    const html = p.content.find((c: any) => c.type === "text/html").value;
    for (const part of [text, html]) {
      expect(part).toContain("https://api.zaviagent.com/api/email/unsubscribe?token=tok-1");
      expect(part).toContain("1 Main St, Austin TX");
      expect(part).toContain("Unsubscribe");
    }
    expect(JSON.stringify(p)).not.toMatch(/bypass/i);
  });

  it("the text part carries the footer after the body", () => {
    const p = buildBulkPayload(MSG) as any;
    expect(p.content[0].value).toMatch(/1 Main St, Austin TX\nUnsubscribe: https:/);
  });

  it("what is sent is exactly the approved text: the HTML is rendered from it, escaped, with no model HTML", () => {
    const text = "Hi <b>there</b>,\n\nSee <a href=\"https://evil.example\">this</a> & more.\nBye";
    const p = buildBulkPayload({ ...MSG, bodyText: text }) as any;
    const [plain, html] = p.content;
    expect(plain.value.startsWith(text)).toBe(true);
    expect(html.value).toContain("Hi &lt;b&gt;there&lt;/b&gt;,");
    expect(html.value).not.toContain('href="https://evil.example"');
    expect(html.value).toContain("<br>Bye");
    expect(html.value.indexOf("evil.example")).toBeLessThan(html.value.indexOf("Unsubscribe</a>"));
    expect(html.value.match(/<a /g)).toHaveLength(1);
  });

  it("sends with the bulk key only", async () => {
    const fetch = vi.fn(async () => ({ status: 202 }));
    expect(await sendBulkEmail(MSG, { fetch })).toEqual({ kind: "sent" });
    expect((fetch.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer bulk-key");
  });

  it("with the bulk key unset it sends nothing and never uses another key", async () => {
    delete process.env.BULK_SENDGRID_API_KEY;
    const fetch = vi.fn(async () => ({ status: 202 }));
    expect(await sendBulkEmail(MSG, { fetch })).toEqual({ kind: "stop_all", status: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [202, "sent"],
    [400, "rejected"],
    [413, "rejected"],
    [401, "stop_all"],
    [403, "stop_all"],
    [429, "throttled"],
    [500, "unknown"],
    [503, "unknown"],
  ])("HTTP %i is read as %s", async (status, kind) => {
    const out = await sendBulkEmail(MSG, { fetch: async () => ({ status }) });
    expect(out.kind).toBe(kind);
  });

  it("a network error or a timeout is unknown, never sent and never failed", async () => {
    const out = await sendBulkEmail(MSG, {
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(out).toEqual({ kind: "unknown" });
  });
});
