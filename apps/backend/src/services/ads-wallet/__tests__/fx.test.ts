import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adsUsd, adsLocalMicros } from "../fx";
const fx = {
  currency: "EUR",
  units_per_usd: 0.8,
  as_of: null,
  source: "ExchangeRate-API" as const,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
});
function feed(age = 3600000) {
  return {
    result: "success",
    base_code: "USD",
    time_last_update_unix: (Date.now() - age) / 1000,
    time_next_update_unix: (Date.now() + 3600000) / 1000,
    rates: { USD: 1, EUR: 0.8, INR: 80 },
  };
}
it("converts and rounds obligations up and provider changes down using decimal arithmetic", () => {
  expect(adsUsd(80, fx)).toBe(100);
  expect(adsUsd(0.001, fx)).toBe(0.01);
  expect(adsUsd(80.000000001, fx)).toBe(100.01);
  expect(adsLocalMicros(25.01, fx)).toBe(20008000);
  expect(adsUsd(1e-9, fx)).toBe(0.01);
  expect(() => adsUsd(-1, fx)).toThrow();
  expect(() => adsUsd(Number.MAX_VALUE, fx)).toThrow();
  expect(() => adsLocalMicros(1, { ...fx, units_per_usd: 0 })).toThrow();
});
it("USD does not depend on a network quote", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { adsFx } = await import("../fx");
  expect(await adsFx("USD")).toMatchObject({ units_per_usd: 1, source: "USD" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("shares one daily reference read, returning only the requested quote", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => feed() }));
  vi.stubGlobal("fetch", fetcher);
  const { adsFx } = await import("../fx");
  const [eur, inr] = await Promise.all([adsFx("EUR"), adsFx("INR")]);
  expect(eur.units_per_usd).toBe(0.8);
  expect(inr.units_per_usd).toBe(80);
  await adsFx("EUR");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "https://open.er-api.com/v6/latest/USD",
    expect.anything(),
  );
});
it.each(["stale", "future", "missing", "network", "malformed"])(
  "refuses %s quotes without assuming parity",
  async (kind) => {
    const data = feed(
      kind === "stale" ? 49 * 3600000 : kind === "future" ? -3600000 : 3600000,
    );
    if (kind === "missing") delete (data.rates as any).EUR;
    if (kind === "malformed") data.rates.USD = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (kind === "network") throw new Error("offline");
        return { ok: true, json: async () => data };
      }),
    );
    const { adsFx } = await import("../fx");
    await expect(adsFx("EUR")).rejects.toMatchObject({
      code: "ads_fx_unavailable",
    });
  },
);
it("Review 34 P6: an exchange-rate outage after the hourly refresh keeps using the last rate while it is under 48 hours old", async () => {
  let down = false;
  const fetcher = vi.fn(async () => {
    if (down) throw new Error("offline");
    return { ok: true, json: async () => feed() };
  });
  vi.stubGlobal("fetch", fetcher);
  const { adsFx } = await import("../fx");
  expect((await adsFx("EUR")).units_per_usd).toBe(0.8);
  down = true;
  vi.setSystemTime(Date.now() + 3 * 3600000);
  expect(await adsFx("EUR")).toMatchObject({ currency: "EUR", units_per_usd: 0.8, source: "ExchangeRate-API" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await adsFx("EUR");
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 10 * 60000);
  await adsFx("EUR");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("Review 34 P6: a rate past 48 hours is never used, and the founder is told what happened and when to try again", async () => {
  let down = false;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (down) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => feed() };
  }));
  const { adsFx, ADS_FX_UNAVAILABLE } = await import("../fx");
  await adsFx("EUR");
  down = true;
  vi.setSystemTime(Date.now() + 48 * 3600000);
  const err = await adsFx("EUR").catch((e) => e);
  expect(err).toMatchObject({ code: "ads_fx_unavailable", message: ADS_FX_UNAVAILABLE });
  expect(err.message).toMatch(/try again in an hour/);
  expect(err.message).not.toMatch(/authorized|remains available/);
});
it("Review 34 P6: a currency the rate feed does not carry says so by name and points at a currency that works, instead of asking to try again", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => feed() })));
  const { adsFx } = await import("../fx");
  const err = await adsFx("GBP").catch((e) => e);
  expect(err.code).toBe("ads_fx_unavailable");
  expect(err.message).toMatch(/no exchange rate for GBP/);
  expect(err.message).toMatch(/another currency/);
  expect(err.message).not.toMatch(/try again/i);
});
