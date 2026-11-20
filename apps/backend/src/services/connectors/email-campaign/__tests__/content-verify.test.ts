import { beforeEach, describe, expect, it, vi } from "vitest";

const alerts = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, logs: [] as Array<Record<string, unknown>>, names: [] as string[], fail: false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
    alerts.names.push(name);
    alerts.calls.push(args);
    return alerts.fail ? { data: null, error: { message: "down" } } : { data: true, error: null };
  },
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (e: Record<string, unknown>) => {
    alerts.logs.push(e);
  },
}));
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { render, type EmailContent, type EmailTemplate } from "@/services/email-templates/render";
import { compareContent, normalizePart, readAndCompare, readVerifyMode, reportContentVerdict, resetVerifyModeCache, trackingRewrite, verdictCode, verifyModeFrom } from "../content-verify";
import { EMAIL_PROVIDERS, EmailToolError, type ProviderCall } from "../providers";
import { sendgridHttpCall } from "../providers-sendgrid";

const TEMPLATE: EmailTemplate = { logo_url: null, brand_color: "#1f6feb", button_color: "#1f6feb", font_key: "system", sign_off: "The Brightloop team", postal_address: "1 Example Way, Springfield", show_cards: false };
const CONTENT: EmailContent = {
  subject: "Shared workspaces",
  preview_text: "Work together",
  title: "Work together",
  paragraphs: ["Invite your team & share boards."],
  button: { label: "Try it", url: "https://www.brightloop.test/workspaces?ref=email" },
} as EmailContent;
const SEALED = (() => {
  const r = render(TEMPLATE, CONTENT, { route: "mailchimp", campaignSlug: "shared-workspaces-20261012", ownHost: "www.brightloop.test", companyName: "Brightloop" });
  return { html: r.html, text: r.text };
})();

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });
const fail = (status = 500): ComposioExecResult => ({ ok: false, status, data: null, error: "down", outcome_unknown: false });

describe("the comparison", () => {
  it("the sealed render carries entity-escaped hrefs (the fixture is real)", () => {
    expect(SEALED.html).toMatch(/href="https:\/\/www\.brightloop\.test\/workspaces\?ref=email&amp;utm_source=email/);
  });

  it("line endings and trailing whitespace are the only differences forgiven", () => {
    expect(normalizePart("a  \r\nb\t\n\n")).toBe("a\nb");
    const stored = { proof: "ok" as const, html: SEALED.html.replace(/\n/g, "\r\n") + "\n\n", text: `${SEALED.text}   ` };
    expect(compareContent("mailchimp", SEALED, stored)).toEqual({ status: "match" });
  });

  it("any other change, in the html or the plain text, is a change", () => {
    const word = { proof: "ok" as const, html: SEALED.html.replace("Invite your team", "Invite your friends"), text: SEALED.text };
    expect(compareContent("mailchimp", SEALED, word)).toEqual({ status: "changed", parts: ["html"], canonicalized: [] });
    const text = { proof: "ok" as const, html: SEALED.html, text: `${SEALED.text}\nP.S. new line` };
    expect(compareContent("mailchimp", SEALED, text)).toMatchObject({ status: "changed", parts: ["text"] });
    const markup = { proof: "ok" as const, html: SEALED.html.replace("<body", '<body data-x="1"'), text: SEALED.text };
    expect(compareContent("mailchimp", SEALED, markup).status).toBe("changed");
  });

  it("unprovable content is never a match, and has its own code", () => {
    const v = compareContent("klaviyo", SEALED, { proof: "unprovable", why: "the template is not a code template (SIMPLE)" });
    expect(v).toEqual({ status: "unprovable", why: "the template is not a code template (SIMPLE)" });
    expect(verdictCode(v)).toBe("email_content_unverifiable");
    expect(verdictCode({ status: "changed", parts: ["html"], canonicalized: [] })).toBe("email_content_changed");
    expect(verdictCode({ status: "match" })).toBeNull();
  });
});

describe("a narrow tracking-rewrite canonicalizer (the mechanism a recorded probe would use)", () => {
  const rule = trackingRewrite("example-tracking", "__fixtures__/example.json", /^https:\/\/track\.example\.test\/c\?u=/, (href) => {
    try {
      return decodeURIComponent(new URL(href).searchParams.get("u") ?? "");
    } catch {
      return null;
    }
  });
  const sealedHref = /href="([^"]+)"/.exec(SEALED.html)![1];
  const decoded = sealedHref.replace(/&amp;/g, "&");
  const tracked = (dest: string) => `https://track.example.test/c?u=${encodeURIComponent(dest)}`.replace(/&/g, "&amp;");

  it("accepted only when the tracked link decodes to the sealed destination", () => {
    const stored = { proof: "ok" as const, html: SEALED.html.split(`href="${sealedHref}"`).join(`href="${tracked(decoded)}"`), text: SEALED.text };
    expect(compareContent("mailchimp", SEALED, stored, [rule])).toEqual({ status: "match" });
  });

  it("a tracked link to anywhere else is a change", () => {
    const stored = { proof: "ok" as const, html: SEALED.html.split(`href="${sealedHref}"`).join(`href="${tracked("https://evil.test/")}"`), text: SEALED.text };
    expect(compareContent("mailchimp", SEALED, stored, [rule]).status).toBe("changed");
  });

  it("a link added or removed proves nothing", () => {
    const stored = { proof: "ok" as const, html: SEALED.html.replace("</body>", `<a href="${tracked(decoded)}">extra</a></body>`), text: SEALED.text };
    expect(compareContent("mailchimp", SEALED, stored, [rule]).status).toBe("changed");
  });
});

describe("each tool's reader", () => {
  it("SendGrid: only a present, contrary flag makes it unprovable; an omitted or false flag does not", async () => {
    const at = (cfg: Record<string, unknown>) => {
      const fetchImpl = (async () => new Response(JSON.stringify({ id: "s1", email_config: cfg }), { status: 200 })) as unknown as typeof fetch;
      return EMAIL_PROVIDERS.sendgrid.readContent(sendgridHttpCall("SG.k", fetchImpl), "s1");
    };
    expect(await at({ html_content: "<p>x</p>", plain_content: "x" })).toEqual({ proof: "ok", html: "<p>x</p>", text: "x" });
    expect(await at({ html_content: "<p>x</p>", plain_content: "x", editor: "code", generate_plain_content: false, design_id: null })).toMatchObject({ proof: "ok" });
    expect(await at({ html_content: "<p>x</p>", plain_content: "x", editor: "design" })).toMatchObject({ proof: "unprovable" });
    expect(await at({ html_content: "<p>x</p>", plain_content: "x", design_id: "d-1" })).toMatchObject({ proof: "unprovable" });
    expect(await at({ html_content: "<p>x</p>", plain_content: "x", generate_plain_content: true })).toMatchObject({ proof: "unprovable" });
    expect(await at({ plain_content: "x" })).toMatchObject({ proof: "unprovable" });
  });

  it("Mailchimp: html + plain_text under Composio's data; A/B variants are unprovable", async () => {
    const at = (body: unknown): ProviderCall => async () => ok({ data: body });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>", plain_text: "x", _links: [] }), "c1")).toEqual({ proof: "ok", html: "<p>x</p>", text: "x" });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>", plain_text: "x", variate_contents: [{ html: "a" }] }), "c1")).toMatchObject({ proof: "unprovable" });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>" }), "c1")).toMatchObject({ proof: "unprovable" });
  });

  it("Klaviyo: campaign, its one message, that message's code template; a second message or a drag-and-drop template is unprovable", async () => {
    const at = (messages: number, editor = "CODE"): ProviderCall => async (slug) =>
      slug === "KLAVIYO_GET_CAMPAIGN"
        ? ok({ data: { data: { id: "K1", attributes: {}, relationships: { "campaign-messages": { data: Array.from({ length: messages }, (_, i) => ({ type: "campaign-message", id: `m${i}` })) } } } } })
        : ok({ data: { data: { type: "template", id: "t", attributes: { editor_type: editor, html: "<p>x</p>", text: "x" } } } });
    expect(await EMAIL_PROVIDERS.klaviyo.readContent(at(1), "K1")).toEqual({ proof: "ok", html: "<p>x</p>", text: "x" });
    expect(await EMAIL_PROVIDERS.klaviyo.readContent(at(2), "K1")).toMatchObject({ proof: "unprovable", why: "the campaign has more than one message" });
    expect(await EMAIL_PROVIDERS.klaviyo.readContent(at(1, "SYSTEM_DRAGGABLE"), "K1")).toMatchObject({ proof: "unprovable" });
  });
});

describe("reading back with a deadline", () => {
  const connectedCall = (html: string, text: string): ProviderCall => async () => ok({ data: { html, plain_text: text } });

  it("a read that fails is retried a couple of times with jitter, then unreadable (never a throw)", async () => {
    let n = 0;
    const waits: number[] = [];
    const flaky: ProviderCall = async () => (++n < 3 ? fail() : ok({ data: { html: SEALED.html, plain_text: SEALED.text } }));
    expect(await readAndCompare("mailchimp", flaky, "c1", SEALED, { sleep: async (ms) => void waits.push(ms), random: () => 0.5 })).toEqual({ status: "match" });
    expect(waits).toHaveLength(2);
    const down: ProviderCall = async () => fail();
    expect(await readAndCompare("mailchimp", down, "c1", SEALED, { sleep: async () => undefined })).toMatchObject({ status: "unreadable" });
  });

  it("an unprovable answer is not retried", async () => {
    let n = 0;
    const call: ProviderCall = async () => (n++, ok({ data: { html: "<p>x</p>" } }));
    expect(await readAndCompare("mailchimp", call, "c1", SEALED, { sleep: async () => undefined })).toMatchObject({ status: "unprovable" });
    expect(n).toBe(1);
  });

  it("a read that hangs past the deadline is unreadable, in time", async () => {
    const hang: ProviderCall = () => new Promise(() => undefined);
    const t0 = Date.now();
    expect(await readAndCompare("mailchimp", hang, "c1", SEALED, { deadlineMs: 50, sleep: async () => undefined })).toMatchObject({ status: "unreadable" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a match end to end through the Mailchimp reader", async () => {
    expect(await readAndCompare("mailchimp", connectedCall(SEALED.html, SEALED.text), "c1", SEALED)).toEqual({ status: "match" });
  });

  it("EmailToolError on a refused read is caught as unreadable", async () => {
    const refusing: ProviderCall = async () => {
      throw new EmailToolError("nope", false);
    };
    expect(await readAndCompare("mailchimp", refusing, "c1", SEALED, { sleep: async () => undefined })).toMatchObject({ status: "unreadable" });
  });
});

describe("mode per tool", () => {
  it("shadow by default and for anything but an exact 'enforce'", () => {
    expect(verifyModeFrom(null, "sendgrid")).toBe("shadow");
    expect(verifyModeFrom({ email_content_verify: { sendgrid: "enforce" } }, "sendgrid")).toBe("enforce");
    expect(verifyModeFrom({ email_content_verify: { sendgrid: "enforce" } }, "klaviyo")).toBe("shadow");
    expect(verifyModeFrom({ email_content_verify: { sendgrid: "ENFORCE" } }, "sendgrid")).toBe("shadow");
  });
});

describe("the mode read keeps the last known mode and is bounded", () => {
  beforeEach(() => resetVerifyModeCache());

  it("a failed config read keeps the last mode read for that tool; with none read yet it is shadow", async () => {
    let t = 0;
    const now = () => t;
    expect(await readVerifyMode("sendgrid", { readBlob: async () => ({ email_content_verify: { sendgrid: "enforce" } }), now })).toBe("enforce");
    t += 120_000;
    expect(await readVerifyMode("sendgrid", { readBlob: async () => Promise.reject(new Error("down")), now })).toBe("enforce");
    expect(await readVerifyMode("klaviyo", { readBlob: async () => Promise.reject(new Error("down")), now })).toBe("shadow");
  });

  it("a hanging config read gives up in time", async () => {
    const t0 = Date.now();
    expect(await readVerifyMode("mailchimp", { readBlob: () => new Promise(() => undefined) })).toBe("shadow");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("one config read at a time, shared by every send", () => {
  beforeEach(() => resetVerifyModeCache());

  it("concurrent sends on every tool share one pending read; none starts its own", async () => {
    let reads = 0;
    let release: (b: unknown) => void = () => undefined;
    const readBlob = () => {
      reads += 1;
      return new Promise<unknown>((r) => {
        release = r;
      });
    };
    const modes = Promise.all([
      readVerifyMode("sendgrid", { readBlob }),
      readVerifyMode("sendgrid", { readBlob }),
      readVerifyMode("mailchimp", { readBlob }),
      readVerifyMode("klaviyo", { readBlob }),
    ]);
    await Promise.resolve();
    release({ email_content_verify: { sendgrid: "enforce" } });
    expect(await modes).toEqual(["enforce", "enforce", "shadow", "shadow"]);
    expect(reads).toBe(1);
  });

  it("at the deadline the read is aborted and dropped: the next send starts a fresh one", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const hang = (signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<unknown>(() => undefined);
      };
      const first = readVerifyMode("sendgrid", { readBlob: hang });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await first).toBe("shadow");
      expect(signals[0].aborted).toBe(true);
      const second = readVerifyMode("sendgrid", { readBlob: async () => ({ email_content_verify: { sendgrid: "enforce" } }) });
      expect(await second).toBe("enforce");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reporting", () => {
  beforeEach(() => {
    resetVerifyModeCache();
    alerts.calls.length = 0;
    alerts.logs.length = 0;
    alerts.names.length = 0;
    alerts.fail = false;
  });

  it("an unreadable read carries a reason code, never the tool's own text", async () => {
    const leaky: ProviderCall = async () => ({ ok: false, status: 500, data: null, error: "secret sk-abcdefghijklmnopqrstuvwxyz owner@realco.com", outcome_unknown: false });
    const v = await readAndCompare("mailchimp", leaky, "c1", SEALED, { sleep: async () => undefined });
    expect(v).toEqual({ status: "unreadable", why: "read_failed" });
  });

  it("one alert per tenant and tool per rolling hour (every event is still logged); messages are codes only", async () => {
    await reportContentVerdict("t1", "klaviyo", "before_send", { status: "changed", parts: ["html"], canonicalized: [] }, "shadow");
    await reportContentVerdict("t1", "klaviyo", "before_send", { status: "unreadable", why: "read_timeout" }, "shadow");
    await reportContentVerdict("t1", "mailchimp", "after_send", { status: "unprovable", why: "the campaign has A/B variants" }, "shadow");
    await reportContentVerdict("t2", "klaviyo", "before_send", { status: "changed", parts: ["text"], canonicalized: [] }, "shadow");
    expect(alerts.logs).toHaveLength(4);
    expect(alerts.names.every((n) => n === "enqueue_ops_alert_windowed")).toBe(true);
    expect(alerts.calls.map((c) => c.p_key)).toEqual(["email_content:t1:klaviyo", "email_content:t1:mailchimp", "email_content:t2:klaviyo"]);
    expect(alerts.calls.every((c) => c.p_window_s === 3600)).toBe(true);
    expect(alerts.calls[0].p_msg).toBe("klaviyo before_send shadow: changed:html");
    expect(alerts.calls[1].p_msg).toBe("mailchimp after_send shadow: unprovable");
  });
});

describe("a failed alert enqueue never silences the next one", () => {
  beforeEach(() => {
    resetVerifyModeCache();
    alerts.calls.length = 0;
    alerts.names.length = 0;
    alerts.fail = false;
  });

  it("the hour is recorded only after the enqueue succeeded", async () => {
    alerts.fail = true;
    await reportContentVerdict("t1", "sendgrid", "before_send", { status: "changed", parts: ["html"], canonicalized: [] }, "enforce");
    alerts.fail = false;
    await reportContentVerdict("t1", "sendgrid", "before_send", { status: "changed", parts: ["html"], canonicalized: [] }, "enforce");
    await reportContentVerdict("t1", "sendgrid", "before_send", { status: "changed", parts: ["html"], canonicalized: [] }, "enforce");
    expect(alerts.calls).toHaveLength(2);
  });
});

describe("type drift never proves", () => {
  it("SendGrid: an editor or a plain-text flag of an unexpected type is unprovable", async () => {
    const at = (cfg: Record<string, unknown>) => {
      const fetchImpl = (async () => new Response(JSON.stringify({ id: "s1", email_config: cfg }), { status: 200 })) as unknown as typeof fetch;
      return EMAIL_PROVIDERS.sendgrid.readContent(sendgridHttpCall("SG.k", fetchImpl), "s1");
    };
    expect(await at({ html_content: "<p>x</p>", plain_content: "x", editor: 1 })).toMatchObject({ proof: "unprovable" });
    expect(await at({ html_content: "<p>x</p>", plain_content: "x", generate_plain_content: "false" })).toMatchObject({ proof: "unprovable" });
  });

  it("Mailchimp: a variants field present and not an empty list (null included) is unprovable", async () => {
    const at = (body: unknown): ProviderCall => async () => ok({ data: body });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>", plain_text: "x", variate_contents: {} }), "c1")).toMatchObject({ proof: "unprovable" });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>", plain_text: "x", variate_contents: null }), "c1")).toMatchObject({ proof: "unprovable" });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>", plain_text: "x" }), "c1")).toMatchObject({ proof: "ok" });
    expect(await EMAIL_PROVIDERS.mailchimp.readContent(at({ html: "<p>x</p>", plain_text: "x", variate_contents: [] }), "c1")).toMatchObject({ proof: "ok" });
  });
});
