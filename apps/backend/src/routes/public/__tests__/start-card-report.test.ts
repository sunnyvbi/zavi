
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  settings: {} as Record<string, boolean>,
  tick: true as boolean,
  card: null as null | { id: string; public_id: string; domain: string; revoked_at: string | null },
  sent: true,
  consumed: null as string | null,
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (k: string) => H.settings[k] ?? false),
}));
vi.mock("@/services/launch-video-public/captcha", () => ({
  verifyTurnstile: vi.fn(async ({ token }: { token: string | null }) =>
    token === "good" ? { ok: true } : { ok: false, reason: token ? "rejected" : "missing_token" },
  ),
  turnstileSiteKey: vi.fn(() => "site-key"),
}));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.example.test" }));
vi.mock("@/services/start-card/budget", () => ({ reserveCardBudget: vi.fn() }));
vi.mock("@/services/start-card/queue", () => ({
  createAndStartCard: vi.fn(),
  retentionCutoffIso: vi.fn(() => "2026-09-19T00:00:00.000Z"),
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendStartCardConfirmEmail: vi.fn(),
  sendStartCardRemoveEmail: vi.fn(async () => ({ sent: H.sent })),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("@/services/start-card/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/start-card/store")>();
  const byPublicId = vi.fn(async (_id: string): Promise<any> => H.card);
  return {
    ...real,
    tickIpBucket: vi.fn(async () => H.tick),
    getCardByPublicId: byPublicId,
    getPublicCardByPublicId: vi.fn(async (id: string) => {
      const r = await byPublicId(id);
      return r && !real.isHiddenSeedCard(r as Parameters<typeof real.isHiddenSeedCard>[0]) ? r : null;
    }),
    getCardById: vi.fn(async () => H.card),
    insertRemovalRequest: vi.fn(async () => "report-1"),
    insertStaffReport: vi.fn(async () => undefined),
    deleteReportRow: vi.fn(async () => undefined),
    findRemovalToken: vi.fn(async () => H.consumed),
    deleteRemovalToken: vi.fn(async () => undefined),
    revokeCard: vi.fn(async () => undefined),
  };
});

import { startCardReport, startCardReportConfirm, startCardReportConfirmPage } from "../start-card";
import {
  deleteRemovalToken,
  deleteReportRow,
  findRemovalToken,
  insertRemovalRequest,
  insertStaffReport,
  revokeCard,
  tickIpBucket,
} from "@/services/start-card/store";
import { sendStartCardRemoveEmail } from "@/email/sendAuthEmail";

function mkRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    location: null as string | null,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    redirect(code: number, url: string) {
      this.statusCode = code;
      this.location = url;
      return this;
    },
    setHeader() {},
    type() {
      return this;
    },
    set() {
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as import("express").Response & { statusCode: number; body: any; location: string | null };
}

const req = (body: unknown) =>
  ({ ip: "1.2.3.4", socket: { remoteAddress: "1.2.3.4" }, body }) as unknown as import("express").Request;
const pageReq = (token: string) => ({ query: { token } }) as unknown as import("express").Request;
const confirmReq = (token: string) => ({ body: { token } }) as unknown as import("express").Request;

const PUBLIC_ID = "fx7Kq2mZr9TbLw4N";
const TOKEN = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  H.settings = { start_card_captcha_required: false };
  H.tick = true;
  H.card = { id: "card-1", public_id: PUBLIC_ID, domain: "acme.com", revoked_at: null };
  H.sent = true;
  H.consumed = null;
});

describe("POST /api/public/start-card/report", () => {
  it("a domain email gets a removal link; only a token hash is stored, no email or reason", async () => {
    const res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "Owner@acme.com", reason: "please remove" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ state: "verify_sent" });
    expect(vi.mocked(insertRemovalRequest).mock.calls[0]).toEqual(["card-1", expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(insertStaffReport).not.toHaveBeenCalled();
    const sent = vi.mocked(sendStartCardRemoveEmail).mock.calls[0][0];
    expect(sent.email).toBe("owner@acme.com");
    expect(sent.removeUrl).toMatch(/\/api\/public\/start-card\/report\/confirm\?token=[a-f0-9]{64}$/);
    const raw = sent.removeUrl.split("token=")[1];
    expect(vi.mocked(insertRemovalRequest).mock.calls[0][1]).not.toBe(raw);
  });

  it("a non-domain email cannot remove: it is stored as a staff report and no email is sent", async () => {
    const res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "someone@gmail.com", reason: "wrong competitors" }), res);
    expect(res.body).toEqual({ state: "received" });
    expect(insertStaffReport).toHaveBeenCalledWith({ card_id: "card-1", email: "someone@gmail.com", reason: "wrong competitors" });
    expect(insertRemovalRequest).not.toHaveBeenCalled();
    expect(sendStartCardRemoveEmail).not.toHaveBeenCalled();
  });

  it("a look-alike domain is a report, not a removal", async () => {
    const res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "x@acme.com.evil.io", reason: "remove" }), res);
    expect(res.body).toEqual({ state: "received" });
    expect(sendStartCardRemoveEmail).not.toHaveBeenCalled();
  });

  it("an email that could not be sent keeps no row and says so", async () => {
    H.sent = false;
    const res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "owner@acme.com", reason: "remove" }), res);
    expect(res.statusCode).toBe(503);
    expect(deleteReportRow).toHaveBeenCalledWith("report-1");
  });

  it("refuses without a solved captcha when one is required, before any write or meter", async () => {
    H.settings.start_card_captcha_required = true;
    const res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "owner@acme.com", reason: "remove" }), res);
    expect(res.statusCode).toBe(400);
    expect(tickIpBucket).not.toHaveBeenCalled();
    expect(insertRemovalRequest).not.toHaveBeenCalled();
  });

  it("is rate-limited per IP before anything is written", async () => {
    H.tick = false;
    const res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "owner@acme.com", reason: "remove" }), res);
    expect(res.statusCode).toBe(429);
    expect(insertRemovalRequest).not.toHaveBeenCalled();
    expect(insertStaffReport).not.toHaveBeenCalled();
  });

  it("404s an unknown card and a malformed id; 400s a bad email or empty reason", async () => {
    H.card = null;
    let res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "owner@acme.com", reason: "x" }), res);
    expect(res.statusCode).toBe(404);
    res = mkRes();
    await startCardReport(req({ public_id: "../etc", email: "owner@acme.com", reason: "x" }), res);
    expect(res.statusCode).toBe(404);
    res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "nope", reason: "x" }), res);
    expect(res.statusCode).toBe(400);
    res = mkRes();
    await startCardReport(req({ public_id: PUBLIC_ID, email: "owner@acme.com", reason: "   " }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/public/start-card/report/confirm (the emailed link)", () => {
  it("only shows a confirm page: a link-scanning GET removes nothing", async () => {
    H.consumed = "card-1";
    const res = mkRes();
    await startCardReportConfirmPage(pageReq(TOKEN), res);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('method="post"');
    expect(String(res.body)).toContain(TOKEN);
    expect(revokeCard).not.toHaveBeenCalled();
    expect(deleteRemovalToken).not.toHaveBeenCalled();
  });

  it("an unknown or stale token goes back to /start as invalid", async () => {
    const res = mkRes();
    await startCardReportConfirmPage(pageReq(TOKEN), res);
    expect(res.location).toBe("https://www.example.test/start?card_remove=invalid");
  });
});

describe("POST /api/public/start-card/report/confirm (the button)", () => {
  it("revokes the card, THEN deletes the token, and lands on its result page", async () => {
    H.consumed = "card-1";
    const res = mkRes();
    await startCardReportConfirm(confirmReq(TOKEN), res);
    expect(findRemovalToken).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), "2026-09-19T00:00:00.000Z");
    expect(revokeCard).toHaveBeenCalledWith("card-1");
    expect(vi.mocked(revokeCard).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deleteRemovalToken).mock.invocationCallOrder[0]);
    expect(res.location).toBe(`https://www.example.test/r/${PUBLIC_ID}`);
  });

  it("a failed revoke keeps the token so the link still works", async () => {
    H.consumed = "card-1";
    vi.mocked(revokeCard).mockRejectedValueOnce(new Error("db down"));
    const res = mkRes();
    await startCardReportConfirm(confirmReq(TOKEN), res);
    expect(deleteRemovalToken).not.toHaveBeenCalled();
    expect(res.location).toContain("card_remove=error");
  });

  it("an unknown, used or stale token removes nothing", async () => {
    const res = mkRes();
    await startCardReportConfirm(confirmReq(TOKEN), res);
    expect(revokeCard).not.toHaveBeenCalled();
    expect(res.location).toBe("https://www.example.test/start?card_remove=invalid");
  });

  it("a malformed token never reaches the store", async () => {
    const res = mkRes();
    await startCardReportConfirm(confirmReq("not-a-token"), res);
    expect(findRemovalToken).not.toHaveBeenCalled();
    expect(res.location).toContain("card_remove=invalid");
  });
});
