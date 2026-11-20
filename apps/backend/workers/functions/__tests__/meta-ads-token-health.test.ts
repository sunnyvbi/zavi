
import { describe, it, expect, vi, beforeEach } from "vitest";

const debugTokenMock = vi.fn();
const exchangeMock = vi.fn();
vi.mock("@/services/connectors/meta-ads/oauth", () => ({
  debugToken: (t: string) => debugTokenMock(t),
  exchangeForLongLivedToken: (t: string) => exchangeMock(t),
}));

const persistMock = vi.fn(
  async (_a: { tenant_id: string; access_token: string; expires_at: Date }) => true,
);
vi.mock("@/services/connectors/meta-ads/expiry", () => ({
  persistMetaAdsExpiry: (a: { tenant_id: string; access_token: string; expires_at: Date }) =>
    persistMock(a),
  META_ADS_SLUG: "meta_ads",
  META_ADS_TOKEN_KEY: "meta_ads.access_token",
}));

const getSecretMock = vi.fn(async (_t: string, _k: string) => "tok-live" as string | null);
vi.mock("@/services/secrets/vault", () => ({
  getSecret: (t: string, k: string) => getSecretMock(t, k),
}));

type EnqueueArgs = {
  tenant_id: string;
  channel_id: string;
  thread_ts: string | null;
  kind: string;
  body: string;
  idempotency_key: string;
  depends_on_answer: boolean;
};
const enqueueMock = vi.fn(async (_a: EnqueueArgs) => 1);
vi.mock("@/services/slack/outbox", () => ({
  enqueueSlackOutbox: (a: EnqueueArgs) => enqueueMock(a),
}));

const resolveChannelMock = vi.fn(async (_t: string, _s: string) => "C123" as string | null);
vi.mock("@/services/slack/resolve-zavi-channel", () => ({
  resolveZaviChannel: (t: string, s: string) => resolveChannelMock(t, s),
}));

const logMock = vi.fn(async (_e: unknown) => {});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: unknown) => logMock(e) }));

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("../../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, h: unknown) => ({ handler: h }) },
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => true }));

const runsAds = { value: false };
const alertFounderMock = vi.fn(async (_t: string, _why: string): Promise<{ sent: number; urgent_ids: string[] } | null> =>
  runsAds.value ? { sent: 1, urgent_ids: ["connector:meta_ads"] } : { sent: 0, urgent_ids: [] },
);
vi.mock("@/services/growth/cgo-blockers", () => ({ alertFounderSafely: (t: string, why: string) => alertFounderMock(t, why) }));

import { checkTenantTokenHealth } from "../meta-ads-token-health";

const TENANT = "33333333-3333-3333-3333-333333333333";
const DAY = 86400 * 1000;

beforeEach(() => {
  debugTokenMock.mockReset();
  exchangeMock.mockReset();
  persistMock.mockReset().mockResolvedValue(true);
  getSecretMock.mockReset().mockResolvedValue("tok-live");
  enqueueMock.mockReset().mockResolvedValue(1);
  resolveChannelMock.mockReset().mockResolvedValue("C123");
  logMock.mockReset();
  runsAds.value = false;
  alertFounderMock.mockClear();
});

describe("healthy token, far from expiry", () => {
  it("persists Meta's expiry and does NOT re-exchange or notify", async () => {
    debugTokenMock.mockResolvedValue({
      is_valid: true,
      expires_at: new Date(Date.now() + 55 * DAY),
    });
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).toBe("ok");
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a never-expiring (system-user) token", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: true, expires_at: null });
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).toBe("never_expires");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("rolling re-exchange — the unverified Meta behaviour, measured not assumed", () => {
  it("persists the NEW expiry when the re-exchange actually moves it forward", async () => {
    debugTokenMock
      .mockResolvedValueOnce({ is_valid: true, expires_at: new Date(Date.now() + 15 * DAY) })
      .mockResolvedValueOnce({ is_valid: true, expires_at: new Date(Date.now() + 60 * DAY) });
    exchangeMock.mockResolvedValue({ access_token: "tok-fresh", expires_in: 60 * 86400 });

    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).toBe("refreshed");
    expect(debugTokenMock).toHaveBeenCalledWith("tok-fresh");
    const call = persistMock.mock.calls[persistMock.mock.calls.length - 1][0];
    expect(call.access_token).toBe("tok-fresh");
    expect(call.expires_at.getTime()).toBeGreaterThan(Date.now() + 55 * DAY);
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.rolling_refresh_ok" }),
    );
  });

  it("does NOT write a bogus expiry when the re-exchange returns the SAME expiry", async () => {
    debugTokenMock.mockResolvedValue({
      is_valid: true,
      expires_at: new Date(Date.now() + 15 * DAY),
    });
    exchangeMock.mockResolvedValue({ access_token: "tok-same", expires_in: 15 * 86400 });

    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).not.toBe("refreshed");
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.rolling_refresh_ineffective" }),
    );
    for (const c of persistMock.mock.calls) {
      expect(c[0].access_token).not.toBe("tok-same");
    }
    expect(status).toBe("ok");
  });

  it("does NOT trust expires_in — a generous expires_in with an unmoved authoritative expiry is rejected", async () => {
    debugTokenMock
      .mockResolvedValueOnce({ is_valid: true, expires_at: new Date(Date.now() + 15 * DAY) })
      .mockResolvedValueOnce({ is_valid: true, expires_at: new Date(Date.now() + 15 * DAY) });
    exchangeMock.mockResolvedValue({ access_token: "tok-liar", expires_in: 60 * 86400 });

    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).not.toBe("refreshed");
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.rolling_refresh_ineffective" }),
    );
    for (const c of persistMock.mock.calls) {
      expect(c[0].access_token).not.toBe("tok-liar");
    }
  });

  it("rejects the refresh when the returned token cannot be verified", async () => {
    debugTokenMock
      .mockResolvedValueOnce({ is_valid: true, expires_at: new Date(Date.now() + 15 * DAY) })
      .mockRejectedValueOnce(new Error("graph 503"));
    exchangeMock.mockResolvedValue({ access_token: "tok-unverified", expires_in: 60 * 86400 });

    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).not.toBe("refreshed");
    for (const c of persistMock.mock.calls) {
      expect(c[0].access_token).not.toBe("tok-unverified");
    }
  });

  it("treats a failed re-exchange as a warning, never as a dead token", async () => {
    debugTokenMock.mockResolvedValue({
      is_valid: true,
      expires_at: new Date(Date.now() + 10 * DAY),
    });
    exchangeMock.mockRejectedValue(new Error("graph 500"));
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.rolling_refresh_failed" }),
    );
    expect(status).toBe("warned_14d");
  });
});

describe("notice buckets", () => {
  it.each([
    [13, "warned_14d", "14d"],
    [5, "warned_7d", "7d"],
    [1, "warned_2d", "2d"],
  ])("at %i days remaining fires the %s bucket", async (days, expected, bucket) => {
    debugTokenMock.mockResolvedValue({
      is_valid: true,
      expires_at: new Date(Date.now() + days * DAY),
    });
    exchangeMock.mockResolvedValue({ access_token: "same", expires_in: days * 86400 });
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).toBe(expected);
    const args = enqueueMock.mock.calls[enqueueMock.mock.calls.length - 1][0];
    expect(args.kind).toBe("connector_alert");
    expect(args.thread_ts).toBeNull();
    expect(args.idempotency_key).toContain(`:${bucket}`);
    expect(args.idempotency_key).toContain(TENANT);
  });
});

describe("invalid token — the anti-spam invariant", () => {
  it("stamps expiry and notifies on FIRST detection", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    const future = new Date(Date.now() + 20 * DAY).toISOString();
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: future });
    expect(status).toBe("invalid");
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("does NOT re-stamp on later passes, keeping the dedupe cycle frozen", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    const past = new Date(Date.now() - 3 * DAY);
    const status = await checkTenantTokenHealth({
      tenant_id: TENANT,
      token_expires_at: past.toISOString(),
    });
    expect(status).toBe("invalid");
    expect(persistMock).not.toHaveBeenCalled();
    const args = enqueueMock.mock.calls[0][0];
    expect(args.idempotency_key).toBe(
      `meta_ads_expiry:${TENANT}:${past.getTime()}:invalid`,
    );
  });

  it("does NOT notify when the expiry stamp fails to persist (fail closed)", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    persistMock.mockResolvedValue(false);
    const status = await checkTenantTokenHealth({
      tenant_id: TENANT,
      token_expires_at: new Date(Date.now() + 20 * DAY).toISOString(),
    });
    expect(status).toBe("invalid_stamp_failed");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("keeps a STABLE dedupe key across two consecutive passes", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    const past = new Date(Date.now() - 3 * DAY).toISOString();
    await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: past });
    await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: past });
    const k1 = enqueueMock.mock.calls[0][0].idempotency_key;
    const k2 = enqueueMock.mock.calls[1][0].idempotency_key;
    expect(k1).toBe(k2);
  });
});

describe("dead token: ONE founder message (#3979, Ravi 2026-10-08)", () => {
  it("while cgo runs the ads: the direct founder alert only, no Slack connector notice", async () => {
    runsAds.value = true;
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: new Date(Date.now() + 20 * DAY).toISOString() });
    expect(status).toBe("invalid");
    expect(alertFounderMock).toHaveBeenCalledTimes(1);
    expect(alertFounderMock).toHaveBeenCalledWith(TENANT, "meta ads token");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ code: "meta_ads.token_invalid" }));
  });

  it("when cgo does not run the ads: the Slack notice is the one message", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: new Date(Date.now() + 20 * DAY).toISOString() });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("a day later, already told through cgo: still no Slack notice", async () => {
    runsAds.value = true;
    alertFounderMock.mockResolvedValueOnce({ sent: 0, urgent_ids: ["connector:meta_ads"] });
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: new Date(Date.now() - 1 * DAY).toISOString() });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("the alert path failed: the Slack notice goes out, never zero messages", async () => {
    runsAds.value = true;
    alertFounderMock.mockResolvedValueOnce(null);
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: new Date(Date.now() + 20 * DAY).toISOString() });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});

describe("degraded surfaces", () => {
  it("logs and continues when the tenant has no Slack channel (banner is the surface)", async () => {
    resolveChannelMock.mockResolvedValue(null);
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).toBe("invalid");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.expiry_notice_no_slack_channel" }),
    );
  });

  it("exits quietly when the vault has no token", async () => {
    getSecretMock.mockResolvedValue(null);
    const status = await checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null });
    expect(status).toBe("no_token");
    expect(debugTokenMock).not.toHaveBeenCalled();
  });

  it("propagates a transient Graph error instead of declaring the token dead", async () => {
    debugTokenMock.mockRejectedValue(new Error("graph 503"));
    await expect(
      checkTenantTokenHealth({ tenant_id: TENANT, token_expires_at: null }),
    ).rejects.toThrow();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
