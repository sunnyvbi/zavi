import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertInput } from "@/services/logging/alert";

import { PLATFORM_KEYS, emptyPlatformKeys, reportEmptyPlatformKeys } from "../platform-keys";
import { resetZaviSideAlerts, withZaviSideNotice } from "../zavi-side-error";

const ctx = { tenant_id: "t-1", run_id: "r-1", agent_slug: "influencer" };
const errRes = (body: Record<string, unknown>) => ({ ok: false, is_error: true, ms: 3, content: JSON.stringify(body) });
const NOW = () => new Date("2026-10-22T18:00:00Z");

beforeEach(() => resetZaviSideAlerts());

describe("withZaviSideNotice: a missing Zavi key is Zavi's problem", () => {
  it("motivating example: youtube_api_key_missing tells the user it is on Zavi and alerts once", async () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    const res = withZaviSideNotice(ctx, "youtube", "channel_stats", errRes({
      error: "youtube_api_key_missing",
      message: "No YouTube Data API key is configured. Do NOT estimate a number.",
    }), { alert, now: NOW });
    const body = JSON.parse(res.content);
    expect(body.error).toBe("youtube_api_key_missing");
    expect(body.message).toMatch(/Zavi team has been told/);
    expect(body.message).toMatch(/ask you again later/);
    expect(body.message).toMatch(/never make it a task, card or to-do/i);
    expect(body.message.indexOf("Do NOT estimate")).toBeGreaterThan(body.message.indexOf("ZAVI-SIDE"));
    expect(body.meta).toMatchObject({ owner: "zavi", next_step: "zavi_alerted" });
    expect(res.is_error).toBe(true);
    await Promise.resolve();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toMatchObject({
      code: "youtube_api_key_missing",
      tenant_id: "t-1",
      email: { dedupeKey: "platform_config:youtube_api_key_missing:2026-10-22" },
    });
  });

  it("drops a 'set the key' message and meta.unblockers so nothing tells the user to add a key", () => {
    const apify = JSON.parse(withZaviSideNotice(ctx, "apify", "run", errRes({
      error: "apify_not_configured",
      message: "APIFY_TOKEN env var missing. Add to local .env + AWS Secrets Manager praxis-envprod-1.",
    }), { alert: vi.fn(async (_input: AlertInput) => undefined), now: NOW }).content);
    expect(apify.message).not.toMatch(/APIFY_TOKEN|Secrets Manager/);
    const ads = JSON.parse(withZaviSideNotice(ctx, "google_ads", "list", errRes({
      error: "google_ads_not_configured",
      message: "Set the GOOGLE_ADS_* env secrets.",
      meta: { next_step: "praxis_admin_action", unblockers: ["Set the GOOGLE_ADS_* env secrets"] },
    }), { alert: vi.fn(async (_input: AlertInput) => undefined), now: NOW }).content);
    expect(ads.meta.unblockers).toBeUndefined();
    expect(ads.meta.next_step).toBe("zavi_alerted");
    expect(ads.message).not.toMatch(/GOOGLE_ADS_/);
  });

  it("alerts once per code per day, again for another code or the next day", async () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    const yt = () => errRes({ error: "youtube_api_key_missing", message: "x" });
    withZaviSideNotice(ctx, "youtube", "a", yt(), { alert, now: NOW });
    withZaviSideNotice(ctx, "youtube", "b", yt(), { alert, now: NOW });
    withZaviSideNotice(ctx, "web_search", "q", errRes({ error: "web_search_not_configured", message: "x" }), { alert, now: NOW });
    withZaviSideNotice(ctx, "youtube", "a", yt(), { alert, now: () => new Date("2026-10-23T01:00:00Z") });
    expect(alert.mock.calls.map((c) => c[0].email?.dedupeKey)).toEqual([
      "platform_config:youtube_api_key_missing:2026-10-22",
      "platform_config:web_search_not_configured:2026-10-22",
      "platform_config:youtube_api_key_missing:2026-10-23",
    ]);
  });

  it("must-not-catch: founder-fixable errors, successes and non-JSON pass through untouched", () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    const cases = [
      errRes({ error: "google_ads_not_connected", message: "Connect Google Ads in Settings." }),
      errRes({ error: "youtube_analytics_not_connected", message: "Connect YouTube." }),
      errRes({ error: "google_analytics_not_configured", message: "x" }),
      { ok: true, is_error: false, ms: 1, content: JSON.stringify({ error: "youtube_api_key_missing" }) },
      { ok: false, is_error: true, ms: 1, content: "boom" },
    ];
    for (const c of cases) expect(withZaviSideNotice(ctx, "s", "t", c, { alert, now: NOW })).toBe(c);
    expect(alert).not.toHaveBeenCalled();
  });

  it("a failing alert never breaks the tool result, and the next hit retries the email", async () => {
    const alert = vi.fn(async (_input: AlertInput): Promise<void> => { throw new Error("sendgrid down"); });
    const yt = () => errRes({ error: "youtube_api_key_missing", message: "x" });
    const res = withZaviSideNotice(ctx, "youtube", "a", yt(), { alert, now: NOW });
    expect(JSON.parse(res.content).meta.owner).toBe("zavi");
    expect(alert.mock.calls[0]![0].email?.required).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    withZaviSideNotice(ctx, "youtube", "a", yt(), { alert, now: NOW });
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("rejected or out-of-credit Zavi accounts are Zavi-side too", () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    for (const code of ["apify_auth_failed", "apify_quota_exhausted", "web_search_auth_failed", "youtube_api_forbidden"]) {
      const body = JSON.parse(withZaviSideNotice(ctx, "s", "t", errRes({ error: code, message: "Check APIFY_TOKEN." }), { alert, now: NOW }).content);
      expect(body.meta.owner, code).toBe("zavi");
      expect(body.message, code).not.toMatch(/APIFY_TOKEN/);
    }
  });
});

describe("platform key registry", () => {
  it("Google app keys are satisfied by the shared Google Ads pair, and blanks count as empty", () => {
    const base = {
      YOUTUBE_DATA_API_KEY: "k", GOOGLE_ADS_CLIENT_ID: "id", GOOGLE_ADS_CLIENT_SECRET: "s",
      GOOGLE_ADS_DEVELOPER_TOKEN: "d", APIFY_TOKEN: "a", TAVILY_API_KEY: "t",
      DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p",
    };
    expect(emptyPlatformKeys(base)).toEqual([]);
    const missing = emptyPlatformKeys({ ...base, YOUTUBE_DATA_API_KEY: "  ", GOOGLE_ADS_CLIENT_SECRET: "" });
    expect(missing.map((e) => e.code)).toEqual(
      expect.arrayContaining(["youtube_api_key_missing", "google_ads_not_configured", "google_calendar_not_configured", "google_sheets_not_configured"]),
    );
    expect(missing.some((e) => e.code?.startsWith("chatgpt_ads"))).toBe(false);
  });

  it("every registry code is a real error code some backend file produces", () => {
    const src = join(__dirname, "..", "..", "..");
    const texts: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("platform-keys.ts")) texts.push(readFileSync(p, "utf8"));
      }
    };
    walk(src);
    const all = texts.join("\n");
    for (const e of PLATFORM_KEYS) if (e.code) expect(all.includes(`"${e.code}"`), e.code).toBe(true);
  });
});

describe("reportEmptyPlatformKeys (boot summary)", () => {
  const empty = { NODE_ENV: "production", PRAXIS_ROLE: "worker", PRAXIS_CONTAINER_ROLE: "canonical" };

  it("a prod-mode process that is not a canonical prod container never emails", async () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    await reportEmptyPlatformKeys({ NODE_ENV: "production" }, { alert, warn: vi.fn(), now: NOW });
    await reportEmptyPlatformKeys({ ...empty, PRAXIS_CONTAINER_ROLE: "probe" }, { alert, warn: vi.fn(), now: NOW });
    expect(alert).not.toHaveBeenCalled();
  });

  it("prod with empty keys: warns and emails one list keyed by role and day", async () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    const warn = vi.fn();
    const lines = await reportEmptyPlatformKeys(empty, { alert, warn, now: NOW });
    expect(lines.some((l) => l.startsWith("YOUTUBE_DATA_API_KEY"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0].email?.dedupeKey).toBe("platform_keys_boot:worker:2026-10-22");
  });

  it("staging and local dev warn but never email; nothing empty does nothing", async () => {
    const alert = vi.fn(async (_input: AlertInput) => undefined);
    const warn = vi.fn();
    await reportEmptyPlatformKeys({ ...empty, EXECUTION_ENV: "staging" }, { alert, warn, now: NOW });
    await reportEmptyPlatformKeys({ NODE_ENV: "development" }, { alert, warn, now: NOW });
    expect(alert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    const full = Object.fromEntries(PLATFORM_KEYS.flatMap((e) => e.env.map((g) => [g[0], "x"])));
    warn.mockClear();
    expect(await reportEmptyPlatformKeys({ ...full, NODE_ENV: "production" }, { alert, warn, now: NOW })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
