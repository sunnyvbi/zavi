import { describe, expect, it } from "vitest";
import { latestDueSlot, minIntervalMinutes, nextFire, parseCron } from "../cron";
import { adminFunctions, functionNames, FunctionsManifestError, parseFunctionsManifest } from "../manifest";
import { detectDedicatedCapabilities, FUNCTION_SERVED_CAPABILITIES, SITE_FUNCTIONS_SERVE_CAPABILITIES } from "@/services/site-shards/capabilities";

const NOW = new Date("2026-10-02T12:00:30Z");

describe("cron", () => {
  it("next fire for common shapes (UTC)", () => {
    expect(nextFire(parseCron("0 3 * * *"), NOW).toISOString()).toBe("2026-10-03T03:00:00.000Z");
    expect(nextFire(parseCron("*/15 * * * *"), NOW).toISOString()).toBe("2026-10-02T12:15:00.000Z");
    expect(nextFire(parseCron("30 9 1 * *"), NOW).toISOString()).toBe("2026-11-01T09:30:00.000Z");
    expect(nextFire(parseCron("0 8 * * 1"), NOW).toISOString()).toBe("2026-10-05T08:00:00.000Z");
    expect(nextFire(parseCron("0 8 * * 7"), NOW).toISOString()).toBe("2026-10-04T08:00:00.000Z");
    expect(nextFire(parseCron("0 0 13 * 5"), NOW).toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(nextFire(parseCron("0 0 29 2 *"), NOW).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("refuses malformed expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "MON * * * *", "*/0 * * * *", "5-1 * * * *"]) {
      expect(() => parseCron(bad), bad).toThrow();
    }
    expect(() => nextFire(parseCron("0 0 31 2 *"), NOW)).toThrow(/never fires/);
  });

  it("latest due slot skips older missed slots", () => {
    const c = parseCron("*/5 * * * *");
    expect(latestDueSlot(c, new Date("2026-10-02T11:00:00Z"), NOW)?.toISOString()).toBe("2026-10-02T12:00:00.000Z");
    expect(latestDueSlot(parseCron("0 3 * * *"), new Date("2026-10-02T12:01:00Z"), NOW)).toBeNull();
    expect(minIntervalMinutes(parseCron("*/5 * * * *"), NOW)).toBe(5);
    expect(minIntervalMinutes(parseCron("0,1 * * * *"), NOW)).toBe(1);
  });
});

describe("functions manifest", () => {
  const ok = {
    functions: {
      endpoints: {
        checkout: { type: "http" },
        "my-orders": { type: "http", principals: ["signed_in"] },
        "stripe-webhook": { type: "webhook", asAdmin: true },
      },
      schedules: { "nightly-cleanup": { cron: "0 3 * * *" }, reconcile: { cron: "*/30 * * * *", asAdmin: true } },
      secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      allowedHosts: ["api.example.com", "hooks.example.org"],
    },
  };

  it("parses the S8b shape with safe defaults", () => {
    const s = parseFunctionsManifest(ok, NOW)!;
    expect(s.endpoints.checkout).toEqual({ type: "http", principals: ["anyone"], data: "function" });
    expect(s.endpoints["stripe-webhook"]).toEqual({ type: "webhook", principals: [], data: "admin" });
    expect(s.schedules["nightly-cleanup"]).toEqual({ cron: "0 3 * * *", data: "function" });
    expect(functionNames(s)).toEqual(["checkout", "my-orders", "nightly-cleanup", "reconcile", "stripe-webhook"]);
    expect(adminFunctions(s)).toEqual(["reconcile", "stripe-webhook"]);
  });

  it("no block = no functions", () => {
    expect(parseFunctionsManifest({ collections: {} })).toBeNull();
    expect(parseFunctionsManifest(null)).toBeNull();
  });

  it("admin is never a default and webhooks take no principals", () => {
    const s = parseFunctionsManifest({ functions: { endpoints: { a: { type: "webhook" } } } }, NOW)!;
    expect(s.endpoints.a.data).toBe("function");
    expect(() => parseFunctionsManifest({ functions: { endpoints: { a: { type: "webhook", principals: ["anyone"] } } } }, NOW)).toThrow(FunctionsManifestError);
  });

  it("refuses everything malformed, listing every problem", () => {
    const bad = {
      functions: {
        endpoints: { Bad_Name: { type: "http" }, x: { type: "rpc" }, y: { type: "http", asAdmin: "yes" }, z: { type: "http", principals: ["everyone"] } },
        schedules: { fast: { cron: "* * * * *" }, broken: { cron: "nope" } },
        secrets: ["lower", "ZAVI_TOKEN"],
        allowedHosts: ["10.0.0.1", "api.zaviagent.com", "https://x.com/", "metadata.internal"],
        extra: true,
      },
    };
    try {
      parseFunctionsManifest(bad, NOW);
      throw new Error("expected a refusal");
    } catch (e) {
      const p = (e as FunctionsManifestError).problems.join("\n");
      for (const frag of ["Bad_Name", "x.type", "y.asAdmin", "z.principals", "fast.cron runs more often", "broken.cron", "functions.secrets", "10.0.0.1", "api.zaviagent.com", "https://x.com/", "metadata.internal", "unknown key functions.extra"]) {
        expect(p, frag).toContain(frag);
      }
    }
  });

  it("an empty block is refused", () => {
    expect(() => parseFunctionsManifest({ functions: {} }, NOW)).toThrow(/no endpoints and no schedules/);
  });
});

describe("capabilities switch (services/site-shards/capabilities.ts)", () => {
  const manifest = { capabilities: ["payments", "webhooks", "jobs", "secrets", "server_compute", "payouts", "interval_overlap"] };

  it("is OFF today: every declared capability still routes to a dedicated database", () => {
    expect(SITE_FUNCTIONS_SERVE_CAPABILITIES).toBe(false);
    const d = detectDedicatedCapabilities({ manifestRaw: manifest });
    expect(d.capabilities).toEqual(expect.arrayContaining(["payments", "webhooks", "jobs", "secrets", "server_compute", "payouts", "interval_overlap"]));
    expect(d.functionServed).toEqual([]);
  });

  it("ON: the five function-served capabilities stop routing; the rest do not change", () => {
    const d = detectDedicatedCapabilities({ manifestRaw: manifest, functionsServe: true });
    expect(d.functionServed.sort()).toEqual([...FUNCTION_SERVED_CAPABILITIES].sort());
    expect(d.capabilities.sort()).toEqual(["interval_overlap", "payouts"]);
    const sql = detectDedicatedCapabilities({ manifestRaw: {}, paths: ["supabase/x.sql"], functionsServe: true });
    expect(sql.rawSql).toBe(true);
    expect(sql.capabilities).not.toContain("raw_sql");
  });
});
