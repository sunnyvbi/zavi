import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  suppressEmail: vi.fn(),
  row: null as null | { tenant_id: string; email: string },
  lookups: 0,
  lookupError: null as null | { message: string; code: string },
}));
vi.mock("@/services/tools/email/safety-net", () => ({
  suppressEmail: h.suppressEmail,
  unsubscribeAndCount: (tenantId: string, email: string) => h.suppressEmail(tenantId, email, "unsubscribe"),
}));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            h.lookups += 1;
            return h.lookupError ? { data: null, error: h.lookupError } : { data: h.row, error: null };
          },
        }),
      }),
    }),
  }),
}));

import { emailUnsubscribe, TEST_UNSUBSCRIBE_LINE } from "@/routes/email/unsubscribe";

const TOKEN = "11111111-1111-4111-8111-111111111111";

function req(method: "GET" | "POST", token: string, accept = ""): Request {
  return { method, query: { token }, headers: { accept } } as unknown as Request;
}

function res() {
  const r = { statusCode: 200, body: undefined as unknown, html: "", headersSent: false } as Record<string, any>;
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), (r.headersSent = true), r);
  r.type = () => r;
  r.send = (s: string) => ((r.html = s), (r.headersSent = true), r);
  r.setHeader = () => r;
  return r as unknown as Response & { statusCode: number; body: any; html: string };
}

beforeEach(() => {
  h.suppressEmail.mockReset().mockResolvedValue("tok");
  h.row = { tenant_id: "tenant-a", email: "ada@example.com" };
  h.lookups = 0;
  h.lookupError = null;
});

describe("GET /api/email/unsubscribe", () => {
  it("does NOT unsubscribe: it shows a confirm page whose button posts back", async () => {
    for (const accept of ["text/html", "*/*", ""]) {
      const r = res();
      await emailUnsubscribe(req("GET", TOKEN, accept), r);
      expect(r.statusCode).toBe(200);
      expect(r.html).toContain(`<form method="post" action="/api/email/unsubscribe?token=${TOKEN}">`);
      expect(r.html).toContain("Unsubscribe</button>");
      expect(r.html).not.toMatch(/You have been unsubscribed/);
    }
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(h.lookups).toBe(0);
  });

  it("a malformed token is a 400 and still unsubscribes nobody", async () => {
    const r = res();
    await emailUnsubscribe(req("GET", "not-a-token", "text/html"), r);
    expect(r.statusCode).toBe(400);
    expect(h.suppressEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/email/unsubscribe", () => {
  it("the mail provider's one-click POST unsubscribes and gets a bare 200", async () => {
    const r = res();
    await emailUnsubscribe(req("POST", TOKEN), r);
    expect(h.suppressEmail).toHaveBeenCalledWith("tenant-a", "ada@example.com", "unsubscribe");
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, message: "You have been unsubscribed. You will not receive further emails." });
  });

  it("the confirm page's button unsubscribes and gets a page back", async () => {
    const r = res();
    await emailUnsubscribe(req("POST", TOKEN, "text/html,application/xhtml+xml"), r);
    expect(h.suppressEmail).toHaveBeenCalledTimes(1);
    expect(r.html).toContain("You have been unsubscribed.");
  });

  it("an unknown token is not claimed as unsubscribed, on either flow", async () => {
    h.row = null;
    const provider = res();
    await emailUnsubscribe(req("POST", TOKEN), provider);
    expect(provider.statusCode).toBe(404);
    expect(provider.body).toEqual({ ok: false, message: "This unsubscribe link is not valid or has expired." });
    const browser = res();
    await emailUnsubscribe(req("POST", TOKEN, "text/html"), browser);
    expect(browser.statusCode).toBe(404);
    expect(browser.html).toContain("This unsubscribe link is not valid or has expired.");
    expect(browser.html).not.toMatch(/unsubscribed/i);
    expect(h.suppressEmail).not.toHaveBeenCalled();
  });

  it("never says unsubscribed when the write failed, and answers 5xx so the provider retries", async () => {
    h.suppressEmail.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = res();
    await emailUnsubscribe(req("POST", TOKEN), r);
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.body.ok).toBe(false);
    expect(r.body.message).not.toMatch(/have been unsubscribed/i);
    spy.mockRestore();
  });
});

describe("a database error while resolving the token", () => {
  const LOOKUP_ERROR = { message: 'connection to server at "db.internal" failed: timeout for ada@example.com', code: "57014" };

  it("answers the one-click POST with a 5xx so the mail provider retries, and suppresses nothing", async () => {
    h.lookupError = LOOKUP_ERROR;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = res();
    await emailUnsubscribe(req("POST", TOKEN), r);
    expect(h.lookups).toBe(1);
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.statusCode).toBeLessThan(600);
    expect(r.body.ok).toBe(false);
    expect(r.body.message).not.toMatch(/unsubscribed\./i);
    expect(r.body.message).toMatch(/could not record/i);
    expect(h.suppressEmail).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("shows the browser an honest try-again page, never the success page", async () => {
    h.lookupError = LOOKUP_ERROR;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = res();
    await emailUnsubscribe(req("POST", TOKEN, "text/html,application/xhtml+xml"), r);
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.html).toContain("We could not record that unsubscribe. Please try again");
    expect(r.html).toContain("Nothing was changed.");
    expect(r.html).not.toMatch(/You have been unsubscribed/);
    expect(r.html).not.toContain("You can close this window.");
    expect(h.suppressEmail).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs a fixed code without the address or the database text", async () => {
    h.lookupError = LOOKUP_ERROR;
    const spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
    await emailUnsubscribe(req("POST", TOKEN), res());
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join("\n");
    expect(logged).toContain("email_unsubscribe_lookup_failed");
    expect(logged).not.toContain("ada@example.com");
    expect(logged).not.toContain("db.internal");
    for (const s of spies) s.mockRestore();
  });

  it("a GET still asks to confirm and never touches the database, even while it is down", async () => {
    h.lookupError = LOOKUP_ERROR;
    const r = res();
    await emailUnsubscribe(req("GET", TOKEN, "text/html"), r);
    expect(r.statusCode).toBe(200);
    expect(r.html).toContain("Stop these emails?");
    expect(h.lookups).toBe(0);
    expect(h.suppressEmail).not.toHaveBeenCalled();
  });
});

describe("a failed unsubscribe write is logged without the address or the database text", () => {
  it("logs a fixed code and the error class only", async () => {
    h.suppressEmail.mockRejectedValue(new Error('email_unsubscribe_and_count failed: duplicate key (tenant_id, email)=(tenant-a, ada@example.com) violates "email_suppression_pkey"'));
    const spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
    const r = res();
    await emailUnsubscribe(req("POST", TOKEN, "text/html"), r);
    expect(r.statusCode).toBe(503);
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join("\n");
    expect(logged).toContain("email_unsubscribe_failed");
    expect(logged).not.toContain("ada@example.com");
    expect(logged).not.toContain("duplicate key");
    expect(logged).not.toContain("email_suppression_pkey");
    expect(r.html).not.toContain("ada@example.com");
    for (const s of spies) s.mockRestore();
  });
});

describe("the unsubscribe pages", () => {
  it("the link in a test email says it is a test: 200 for GET and POST, no lookup, nobody unsubscribed, no confirm button", async () => {
    for (const method of ["GET", "POST"] as const) {
      const r = res();
      await emailUnsubscribe(req(method, "test-send", "text/html"), r);
      expect(r.statusCode).toBe(200);
      expect(r.html).toContain("This is a test email");
      expect(r.html).not.toContain("is not valid");
      expect(r.html).not.toContain("<button");
      expect(h.lookups).toBe(0);
      expect(h.suppressEmail).not.toHaveBeenCalled();
    }
    const oneClick = res();
    await emailUnsubscribe(req("POST", "test-send"), oneClick);
    expect(oneClick.body).toEqual({ ok: true, message: TEST_UNSUBSCRIBE_LINE });
    const junk = res();
    await emailUnsubscribe(req("GET", "test-sendx", "text/html"), junk);
    expect(junk.statusCode).toBe(400);
  });

  it("the confirm page and every result page carry dark-mode styling and the color-scheme hint", async () => {
    h.row = null;
    h.lookupError = null;
    const pages: Array<Response & { html: string }> = [];
    for (const [method, token] of [["GET", TOKEN], ["GET", "nope"], ["POST", TOKEN], ["POST", "test-send"]] as const) {
      const r = res();
      await emailUnsubscribe(req(method, token, "text/html"), r);
      pages.push(r);
    }
    h.row = { tenant_id: "tenant-a", email: "ada@example.com" };
    const ok = res();
    await emailUnsubscribe(req("POST", TOKEN, "text/html"), ok);
    pages.push(ok);
    h.lookupError = { message: "x", code: "x" };
    const down = res();
    await emailUnsubscribe(req("POST", TOKEN, "text/html"), down);
    pages.push(down);
    expect(pages).toHaveLength(6);
    for (const p of pages) {
      expect(p.html).toContain('<meta name="color-scheme" content="light dark">');
      expect(p.html).toContain("@media (prefers-color-scheme:dark)");
      expect(p.html).not.toMatch(/<(body|h1|p|button)[^>]* style=/);
    }
  });
});
