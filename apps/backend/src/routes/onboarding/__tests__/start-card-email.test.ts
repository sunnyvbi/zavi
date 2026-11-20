import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyBearer = vi.fn();
const enabled = vi.fn();
const byPublicId = vi.fn();
const insertRow = vi.fn();
const tickBucket = vi.fn();
const reachable = vi.fn();
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: (...a: unknown[]) => verifyBearer(...a) }));
vi.mock("@/services/settings", () => ({ getBoolSetting: (...a: unknown[]) => enabled(...a) }));
vi.mock("@/services/start-card/store", () => ({
  getPublicCardByPublicId: async (...a: unknown[]) => {
    const r = (await byPublicId(...a)) as { funding_kind?: string; notice_sent_at?: string | null } | null;
    return r && !(r.funding_kind === "seed" && !r.notice_sent_at) ? r : null;
  },
  tickIpBucket: (...a: unknown[]) => tickBucket(...a),
  hashIp: (ip: string) => `hash-${ip}`,
  hashToken: (value: string) => `hash-${value}`,
  insertAccountQueueRow: (...a: unknown[]) => insertRow(...a),
  isTenantFunded: (r: { funding_kind?: string }) => r.funding_kind === "tenant_credits",
}));
const inngestSend = vi.fn();
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }));
vi.mock("@/services/start-card/request", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/start-card/request")>(),
  checkSiteReachable: (...a: unknown[]) => reachable(...a),
}));

import { onboardingStartCardEmail } from "../start-card-email";

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown };
  return Object.assign(res, {
    status(c: number) {
      res.statusCode = c;
      return this;
    },
    json(b: unknown) {
      res.body = b;
      return this;
    },
  });
}

const card = { id: "c1", public_id: "PUBLICID00000001", domain: "acme.com", status: "running", revoked_at: null };
const call = async (body: unknown = { public_id: card.public_id }, ip: string | undefined = "203.0.113.1") => {
  const res = mockRes();
  await onboardingStartCardEmail({ body, ip } as never, res as never);
  return res;
};

beforeEach(() => {
  vi.resetAllMocks();
  verifyBearer.mockResolvedValue({ user_id: "u1", email: "Founder@Acme.com" });
  enabled.mockResolvedValue(true);
  byPublicId.mockResolvedValue(card);
  insertRow.mockResolvedValue(true);
  tickBucket.mockResolvedValue(true);
  reachable.mockResolvedValue(null);
  inngestSend.mockResolvedValue(undefined);
});

describe("POST /api/onboarding/start-card-email", () => {
  it("401s without a bearer and writes nothing", async () => {
    verifyBearer.mockResolvedValue(null);
    const res = await call();
    expect(res.statusCode).toBe(401);
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("queues a running card for the session's own address, never the body's", async () => {
    const res = await call({ public_id: card.public_id, email: "someone@else.com" });
    expect(insertRow).toHaveBeenCalledWith({ email: "founder@acme.com", domain: "acme.com", card_id: "c1" });
    expect(tickBucket.mock.calls).toEqual([["start_card_account_queue:hash-u1", 3, 86400]]);
    expect(res.body).toEqual({ state: "queued" });
  });

  it("queues a finished card without waiting for the email worker", async () => {
    byPublicId.mockResolvedValue({ ...card, status: "done" });
    inngestSend.mockImplementationOnce(() => new Promise(() => {}));
    const res = await call();
    expect(insertRow).toHaveBeenCalledWith({ email: "founder@acme.com", domain: "acme.com", card_id: "c1" });
    expect(inngestSend).toHaveBeenCalledWith({ name: "start-card/queue.drain", data: {} });
    expect(insertRow.mock.invocationCallOrder[0]).toBeLessThan(inngestSend.mock.invocationCallOrder[0]);
    expect(res.body).toEqual({ state: "queued" });
  });

  it("keeps durable delivery queued when the drain kick fails", async () => {
    inngestSend.mockRejectedValueOnce(new Error("unavailable"));
    const res = await call();
    expect(res.body).toEqual({ state: "queued" });
  });

  it.each([
    ["missing", null],
    ["failed", { ...card, status: "failed" }],
    ["removed", { ...card, revoked_at: "2026-10-01T00:00:00Z" }],
    ["tenant-funded", { ...card, funding_kind: "tenant_credits" }],
  ])("a %s card is unavailable and queues nothing", async (_n, row) => {
    byPublicId.mockResolvedValue(row);
    const res = await call();
    expect(res.body).toEqual({ state: "unavailable" });
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("is unavailable while the growth card is switched off", async () => {
    enabled.mockResolvedValue(false);
    const res = await call();
    expect(res.body).toEqual({ state: "unavailable" });
    expect(byPublicId).not.toHaveBeenCalled();
  });

  it("with no card (budget spent) queues the site for the session's address and kicks the drain", async () => {
    const res = await call({ url: "https://www.Acme.com/pricing" });
    expect(insertRow).toHaveBeenCalledWith({ email: "founder@acme.com", domain: "acme.com", card_id: null });
    expect(inngestSend).toHaveBeenCalledWith({ name: "start-card/queue.drain", data: {} });
    expect(byPublicId).not.toHaveBeenCalled();
    expect(res.body).toEqual({ state: "queued" });
  });

  it("an unusable site queues nothing", async () => {
    const res = await call({ url: "http://127.0.0.1:8080" });
    expect(res.body).toEqual({ state: "unavailable" });
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("400s on a missing public_id", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(400);
  });

  it("checks the account and shared public IP limits before admitting a site", async () => {
    await call({ url: "acme.com" });
    expect(tickBucket.mock.calls).toEqual([
      ["start_card_account_queue:hash-u1", 3, 86400],
      ["start_card_queue:hash-203.0.113.1", 3, 86400],
    ]);
    expect(reachable).toHaveBeenCalledWith({ url: "https://acme.com/", domain: "acme.com" });
    expect(tickBucket.mock.invocationCallOrder[1]).toBeLessThan(reachable.mock.invocationCallOrder[0]);
  });

  it.each(["account", "ip"])("rejects a URL job when the %s allowance is exhausted", async (limit) => {
    if (limit === "ip") tickBucket.mockResolvedValueOnce(true);
    tickBucket.mockResolvedValueOnce(false);
    const res = await call({ url: "acme.com" });
    expect(res.statusCode).toBe(429);
    expect(insertRow).not.toHaveBeenCalled();
    expect(reachable).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("bounds one account across different domains", async () => {
    const counts = new Map<string, number>();
    tickBucket.mockImplementation(async (key: string, limit: number) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= limit;
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await call({ url: `site${i}.com` }, `203.0.113.${i + 1}`)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(insertRow).toHaveBeenCalledTimes(3);
  });

  it("applies the account limit to a public_id request", async () => {
    tickBucket.mockResolvedValueOnce(false);
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(insertRow).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("fails closed when the rate ledger is unavailable", async () => {
    tickBucket.mockRejectedValueOnce(new Error("ledger unavailable"));
    expect((await call({ url: "acme.com" })).statusCode).toBe(500);
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("fails closed on a public_id request when the rate ledger is unavailable", async () => {
    tickBucket.mockRejectedValueOnce(new Error("ledger unavailable"));
    expect((await call()).statusCode).toBe(500);
    expect(insertRow).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("fails closed without a client IP", async () => {
    expect((await call({ url: "acme.com" }, "")).statusCode).toBe(500);
    expect(insertRow).not.toHaveBeenCalled();
  });

  it.each(["unsafe_url", "unreachable"])("does not queue a site that is %s", async (reason) => {
    reachable.mockResolvedValueOnce(reason);
    expect((await call({ url: "internal.example.com" })).body).toEqual({ state: "unavailable" });
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("does not kick delivery when the queue write fails", async () => {
    insertRow.mockRejectedValueOnce(new Error("queue unavailable"));
    expect((await call()).statusCode).toBe(500);
    expect(inngestSend).not.toHaveBeenCalled();
  });

});
