
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@sendgrid/mail", () => ({
  default: { setApiKey: vi.fn(), send: vi.fn(async (msg: Record<string, unknown>) => void sent.push(msg)) },
}));

import { sgSend } from "../sendAuthEmail";
import * as templates from "../templates/creator-invite";
import { ZAVI_POSTAL_ADDRESS } from "../theme";
const { renderCreatorInviteEmail } = templates;

beforeEach(() => {
  sent.length = 0;
  process.env.SYSTEM_SENDGRID_API_KEY = "SG.test";
});

describe("sgSend options", () => {
  it("without options the payload is exactly what every caller always sent", async () => {
    await sgSend("a@b.example", "S", "<p>h</p>", "t");
    expect(Object.keys(sent[0]).sort()).toEqual(["from", "html", "subject", "text", "to"]);
  });

  it("carries customArgs and headers when given", async () => {
    await sgSend("a@b.example", "S", "<p>h</p>", "t", { email: "creators@zaviagent.com", name: "Zavi Creators" }, {
      customArgs: { creator_invite_id: "i1" },
      headers: { "List-Unsubscribe": "<https://api.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    expect(sent[0]).toMatchObject({
      from: { email: "creators@zaviagent.com", name: "Zavi Creators" },
      customArgs: { creator_invite_id: "i1" },
      headers: { "List-Unsubscribe": "<https://api.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  });
});

describe("creator invite templates", () => {
  it("the invite is the only email template: there is no reminder", () => {
    expect(Object.keys(templates)).toEqual(["renderCreatorInviteEmail"]);
  });

  const common = { siteUrl: "https://www.example", unsubscribeUrl: "https://api.example/api/creators/invite/unsubscribe?t=abc" };

  it("the invite links to signup and carries unsubscribe + postal address in html and text", () => {
    const m = renderCreatorInviteEmail({ ...common, name: "Ada", signupUrl: "https://www.example/creators/apply?src=invite" });
    expect(m.subject).toBe("Bring your creative work to Zavi");
    expect(m.text).toContain("Hi Ada,");
    for (const body of [m.html, m.text]) {
      expect(body).toContain("https://www.example/creators/apply?src=invite");
      expect(body).toContain("/api/creators/invite/unsubscribe?t=abc");
      expect(body).toContain(ZAVI_POSTAL_ADDRESS);
    }
  });

  it("the creator's name from the sheet is escaped in html", () => {
    const m = renderCreatorInviteEmail({ ...common, name: "<img src=x onerror=alert(1)>", signupUrl: "https://www.example/x" });
    expect(m.html).not.toContain("<img src=x");
  });

  it("the logo and footer links use the public site, not this laptop's WEB_BASE_URL", () => {
    const prev = process.env.WEB_BASE_URL;
    process.env.WEB_BASE_URL = "http://localhost:3000";
    const m = renderCreatorInviteEmail({ ...common, name: "Ada", signupUrl: "https://www.example/x" });
    if (prev === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = prev;
    expect(m.html).not.toContain("localhost");
    expect(m.html.match(/href="https:\/\/www\.example"/g)).toHaveLength(2);
  });

  it("quotes no fee, commission or amount", () => {
    const m = renderCreatorInviteEmail({ ...common, siteUrl: "http://localhost:3000", name: "Ada", signupUrl: "https://www.example/x" });
    const visible = m.html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    for (const body of [visible, m.text]) {
      expect(body).not.toMatch(/\$\d|\d+%|commission|rounds of changes/i);
    }
  });
});
