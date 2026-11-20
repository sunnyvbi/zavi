
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  settings: {} as Record<string, boolean>,
  recent: null as null | { id: string; public_id: string },
  tick: true as boolean | "throw",
  reserve: { ok: true, day: "2026-10-01", amount: 1 } as unknown,
  lookup: [{ address: "93.184.216.34", family: 4 }] as Array<{ address: string; family: number }>,
  pending: null as unknown,
  sent: true,
}));

vi.mock("node:dns", () => {
  const promises = { lookup: vi.fn(async () => H.lookup) };
  return { default: { promises }, promises };
});
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (k: string) => H.settings[k] ?? false),
}));
vi.mock("@/services/launch-video-public/captcha", () => ({
  verifyTurnstile: vi.fn(async ({ token }: { token: string | null }) =>
    token === "good" ? { ok: true } : { ok: false, reason: token ? "rejected" : "missing_token" },
  ),
  turnstileSiteKey: vi.fn(() => "site-key"),
}));
vi.mock("@/services/start-card/budget", () => ({
  reserveCardBudget: vi.fn(async () => H.reserve),
}));
vi.mock("@/services/start-card/queue", () => ({
  createAndStartCard: vi.fn(async () => ({ id: "card-new", public_id: "NEWPUBLICID00001", reused: false })),
  retentionCutoffIso: vi.fn(() => "2026-09-19T00:00:00.000Z"),
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendStartCardConfirmEmail: vi.fn(async () => ({ sent: H.sent })),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("@/services/start-card/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/start-card/store")>();
  const byPublicId = vi.fn(async (_id: string): Promise<any> => null);
  return {
    ...real,
    tickIpBucket: vi.fn(async () => {
      if (H.tick === "throw") throw new Error("ledger down");
      return H.tick;
    }),
    findRecentCardForDomain: vi.fn(async () => H.recent),
    getCardByPublicId: byPublicId,
    getPublicCardByPublicId: vi.fn(async (id: string) => {
      const r = await byPublicId(id);
      return r && !real.isHiddenSeedCard(r as Parameters<typeof real.isHiddenSeedCard>[0]) ? r : null;
    }),
    findPendingQueueRow: vi.fn(async () => H.pending),
    insertQueueRow: vi.fn(async () => "queue-1"),
    deleteQueueRow: vi.fn(async () => undefined),
    confirmQueueRow: vi.fn(async () => null),
  };
});

import { startCardCreate, startCardGet, startCardQueue } from "../start-card";
import { reserveCardBudget } from "@/services/start-card/budget";
import { createAndStartCard } from "@/services/start-card/queue";
import { deleteQueueRow, getCardByPublicId, insertQueueRow, tickIpBucket } from "@/services/start-card/store";
import { sendStartCardConfirmEmail } from "@/email/sendAuthEmail";

function mkRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res as unknown as import("express").Response & { statusCode: number; body: any; headers: Record<string, string> };
}

const req = (body: unknown, ip: string | null = "1.2.3.4") =>
  ({ ip, socket: { remoteAddress: ip }, body }) as unknown as import("express").Request;

beforeEach(() => {
  vi.clearAllMocks();
  H.settings = { start_card_enabled: true, start_card_captcha_required: false };
  H.recent = null;
  H.tick = true;
  H.reserve = { ok: true, day: "2026-10-01", amount: 1 };
  H.lookup = [{ address: "93.184.216.34", family: 4 }];
  H.pending = null;
  H.sent = true;
});

describe("POST /api/public/start-card", () => {
  it("creates a card: normalizes the url, reserves budget, starts the worker", async () => {
    const res = mkRes();
    await startCardCreate(req({ url: "http://www.Acme.com/pricing?x=1" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ state: "created", public_id: "NEWPUBLICID00001", reused: false });
    expect(reserveCardBudget).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAndStartCard).mock.calls[0][0]).toMatchObject({ domain: "acme.com", referrer_card_id: null });
  });

  it("404s while the kill switch is off", async () => {
    H.settings.start_card_enabled = false;
    const res = mkRes();
    await startCardCreate(req({ url: "acme.com" }), res);
    expect(res.statusCode).toBe(404);
    expect(tickIpBucket).not.toHaveBeenCalled();
  });

  it("refuses a junk url before any meter or spend", async () => {
    for (const url of ["", "not a url", "ftp://acme.com", "https://user:pw@acme.com", "localhost", "http://10.0.0.1/", "acme"]) {
      const res = mkRes();
      await startCardCreate(req({ url }), res);
      expect(res.statusCode, url).toBe(400);
    }
    expect(tickIpBucket).not.toHaveBeenCalled();
    expect(reserveCardBudget).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to a private address (SSRF), before any meter", async () => {
    H.lookup = [{ address: "169.254.169.254", family: 4 }];
    const res = mkRes();
    await startCardCreate(req({ url: "metadata.evil.example" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsafe_url");
    expect(tickIpBucket).not.toHaveBeenCalled();
  });

  it("dedupe: a card for the same domain in the last 24h is returned at $0", async () => {
    H.recent = { id: "card-old", public_id: "OLDPUBLICID00001" };
    const res = mkRes();
    await startCardCreate(req({ url: "https://acme.com" }), res);
    expect(res.body).toEqual({ state: "created", public_id: "OLDPUBLICID00001", reused: true });
    expect(reserveCardBudget).not.toHaveBeenCalled();
    expect(createAndStartCard).not.toHaveBeenCalled();
  });

  it("dedupe comes BEFORE the daily cap: re-opening a site's card works even after the 5/day are spent", async () => {
    H.recent = { id: "card-old", public_id: "OLDPUBLICID00001" };
    H.tick = false;
    const res = mkRes();
    await startCardCreate(req({ url: "https://acme.com" }), res);
    expect(res.body).toEqual({ state: "created", public_id: "OLDPUBLICID00001", reused: true });
    expect(tickIpBucket).not.toHaveBeenCalled();
  });

  it("rate limit: once the IP's 5/day are spent it is a 429 and nothing is reserved", async () => {
    H.tick = false;
    const res = mkRes();
    await startCardCreate(req({ url: "acme.com" }), res);
    expect(res.statusCode).toBe(429);
    expect(vi.mocked(tickIpBucket).mock.calls[0][1]).toBe(5);
    expect(vi.mocked(tickIpBucket).mock.calls[0][2]).toBe(86400);
    expect(reserveCardBudget).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the rate-limit ledger errors, or there is no client IP", async () => {
    H.tick = "throw";
    const a = mkRes();
    await startCardCreate(req({ url: "acme.com" }), a);
    expect(a.statusCode).toBe(500);

    H.tick = true;
    const b = mkRes();
    await startCardCreate(req({ url: "acme.com" }, null), b);
    expect(b.statusCode).toBe(500);
    expect(reserveCardBudget).not.toHaveBeenCalled();
  });

  it("a spent budget answers queued (no card, no worker)", async () => {
    H.reserve = { ok: false, reason: "full" };
    const res = mkRes();
    await startCardCreate(req({ url: "acme.com" }), res);
    expect(res.body).toEqual({ state: "queued" });
    expect(createAndStartCard).not.toHaveBeenCalled();
  });

  it("a broken budget ledger is a 503, never a queue or a free run", async () => {
    H.reserve = { ok: false, reason: "error" };
    const res = mkRes();
    await startCardCreate(req({ url: "acme.com" }), res);
    expect(res.statusCode).toBe(503);
    expect(createAndStartCard).not.toHaveBeenCalled();
  });

  it("Turnstile, when required, runs before the per-IP meter", async () => {
    H.settings.start_card_captcha_required = true;
    const bad = mkRes();
    await startCardCreate(req({ url: "acme.com" }), bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe("captcha_failed");
    expect(tickIpBucket).not.toHaveBeenCalled();

    const good = mkRes();
    await startCardCreate(req({ url: "acme.com", turnstile_token: "good" }), good);
    expect(good.statusCode).toBe(200);
  });

  it("a challenge ref resolves to the referrer's row id; an unknown ref is ignored", async () => {
    vi.mocked(getCardByPublicId).mockResolvedValueOnce({ id: "card-ref" } as never);
    const res = mkRes();
    await startCardCreate(req({ url: "acme.com", ref: "REFPUBLICID00001" }), res);
    expect(vi.mocked(createAndStartCard).mock.calls[0][0].referrer_card_id).toBe("card-ref");
  });

  it("passes a supported visitor country to the card and drops anything else", async () => {
    await startCardCreate(req({ url: "acme.com", visitor_country: "in" }), mkRes());
    await startCardCreate(req({ url: "beta.com", visitor_country: "JP" }), mkRes());
    await startCardCreate(req({ url: "gamma.com" }), mkRes());
    const calls = vi.mocked(createAndStartCard).mock.calls.map((c) => c[0].visitor_country);
    expect(calls).toEqual(["IN", null, null]);
  });
});

describe("GET /api/public/start-card/:public_id", () => {
  it("returns the public card without ip_hash, row id or cost fields", async () => {
    vi.mocked(getCardByPublicId).mockResolvedValueOnce({
      id: "row-id",
      public_id: "ABCDEFGHIJKLMNOP",
      domain: "acme.com",
      locale: "GB",
      search_term: "plumber leeds",
      status: "running",
      parts: {},
      score: null,
      scorer_version: "1",
      evidence: {},
      ip_hash: "secret-hash",
      referrer_card_id: null,
      budget_day: "2026-10-01",
      reserved_usd: 1,
      spent_usd: 0,
      revoked_at: null,
      error: null,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const res = mkRes();
    await startCardGet({ params: { public_id: "ABCDEFGHIJKLMNOP" } } as never, res);
    expect(res.statusCode).toBe(200);
    const json = JSON.stringify(res.body);
    for (const leaked of ["row-id", "secret-hash", "reserved_usd", "budget_day", "ip_hash"]) {
      expect(json).not.toContain(leaked);
    }
    expect(res.body).toMatchObject({ public_id: "ABCDEFGHIJKLMNOP", locale: "GB", status: "running" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("404s a malformed id without a query", async () => {
    const res = mkRes();
    await startCardGet({ params: { public_id: "../etc" } } as never, res);
    expect(res.statusCode).toBe(404);
    expect(getCardByPublicId).not.toHaveBeenCalled();
  });
});

describe("POST /api/public/start-card/queue", () => {
  it("stores the address and sends a confirm link (no card yet)", async () => {
    const res = mkRes();
    await startCardQueue(req({ url: "acme.com", email: "Founder@Acme.com" }), res);
    expect(res.body).toEqual({ state: "confirm_sent" });
    expect(vi.mocked(insertQueueRow).mock.calls[0][0]).toMatchObject({ email: "founder@acme.com", domain: "acme.com" });
    const call = vi.mocked(sendStartCardConfirmEmail).mock.calls[0][0];
    expect(call.confirmUrl).toMatch(/\/api\/public\/start-card\/queue\/confirm\?token=[a-f0-9]{64}$/);
  });

  it("does not mail an address again while it is already waiting for that site", async () => {
    H.pending = { id: "q-existing" };
    const res = mkRes();
    await startCardQueue(req({ url: "acme.com", email: "founder@acme.com" }), res);
    expect(res.body).toEqual({ state: "confirm_sent" });
    expect(sendStartCardConfirmEmail).not.toHaveBeenCalled();
  });

  it("with no SendGrid key: 503, and the unusable address is deleted, not kept", async () => {
    H.sent = false;
    const res = mkRes();
    await startCardQueue(req({ url: "acme.com", email: "founder@acme.com" }), res);
    expect(res.statusCode).toBe(503);
    expect(deleteQueueRow).toHaveBeenCalledWith("queue-1");
  });

  it("has its own per-IP bucket (3/day)", async () => {
    H.tick = false;
    const res = mkRes();
    await startCardQueue(req({ url: "acme.com", email: "founder@acme.com" }), res);
    expect(res.statusCode).toBe(429);
    expect(vi.mocked(tickIpBucket).mock.calls[0][0]).toMatch(/^start_card_queue:/);
    expect(vi.mocked(tickIpBucket).mock.calls[0][1]).toBe(3);
    expect(insertQueueRow).not.toHaveBeenCalled();
  });

  it("refuses a bad email before anything is stored", async () => {
    const res = mkRes();
    await startCardQueue(req({ url: "acme.com", email: "nope" }), res);
    expect(res.statusCode).toBe(400);
    expect(insertQueueRow).not.toHaveBeenCalled();
  });

describe("seed-scan cards (20261101170000)", () => {
  it("an unsent seed card's result page is not found; once its notice went out it is public", async () => {
    const row = {
      id: "row-id", public_id: "SEEDSEEDSEEDSEED", domain: "acme.com", locale: "US", search_term: null, status: "done",
      parts: {}, score: null, scorer_version: "1", evidence: {}, ip_hash: null, referrer_card_id: null, budget_day: null,
      reserved_usd: 0, spent_usd: 0, revoked_at: null, error: null, created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", funding_kind: "seed", seed_run_id: "run-1",
    };
    vi.mocked(getCardByPublicId).mockResolvedValueOnce({ ...row, notice_sent_at: null } as never);
    const hidden = mkRes();
    await startCardGet({ params: { public_id: "SEEDSEEDSEEDSEED" } } as never, hidden);
    expect(hidden.statusCode).toBe(404);
    vi.mocked(getCardByPublicId).mockResolvedValueOnce({ ...row, notice_sent_at: "2026-10-02T00:00:00.000Z" } as never);
    const shown = mkRes();
    await startCardGet({ params: { public_id: "SEEDSEEDSEEDSEED" } } as never, shown);
    expect(shown.statusCode).toBe(200);
  });
});
});
