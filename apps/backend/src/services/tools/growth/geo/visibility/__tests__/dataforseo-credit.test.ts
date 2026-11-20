
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const alertMock = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock("@/services/logging/alert", () => ({ alert: alertMock }));

import { isOutOfCredit, reportIfOutOfCredit, __resetOutOfCreditAlertForTests } from "../dataforseo-credit";
import { askEngine } from "../dataforseo";
import { engineDef } from "../engines";
import { fetchSerp } from "@/services/channels/reddit/google-rank";

const res402 = (body?: unknown) =>
  ({ ok: false, status: 402, json: async () => (body === undefined ? Promise.reject(new Error("no body")) : body) }) as unknown as Response;

describe("isOutOfCredit", () => {
  it("matches HTTP 402 and 402xx vendor codes only", () => {
    for (const c of ["dataforseo_http_402", "dataforseo_40200", "dataforseo_task_40210"]) expect(isOutOfCredit(c)).toBe(true);
    for (const c of ["dataforseo_http_403", "dataforseo_40104", "dataforseo_timeout", "dataforseo_not_configured", "", null, undefined])
      expect(isOutOfCredit(c)).toBe(false);
  });
});

describe("reportIfOutOfCredit", () => {
  beforeEach(() => {
    alertMock.mockClear();
    __resetOutOfCreditAlertForTests();
  });

  it("pages once per UTC day, with an email dedupe key for that day", () => {
    const d1 = new Date("2026-09-28T10:00:00Z");
    reportIfOutOfCredit("dataforseo_http_402", "dataforseo.serp", d1);
    reportIfOutOfCredit("dataforseo_40200", "dataforseo.llm_scraper", d1);
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toMatchObject({
      source: "dataforseo",
      code: "dataforseo_out_of_credit",
      email: { dedupeKey: "dataforseo_out_of_credit:2026-09-28" },
    });
    reportIfOutOfCredit("dataforseo_http_402", "dataforseo.serp", new Date("2026-09-29T00:01:00Z"));
    expect(alertMock).toHaveBeenCalledTimes(2);
  });

  it("stays quiet for any other failure", () => {
    reportIfOutOfCredit("dataforseo_timeout", "dataforseo.serp");
    reportIfOutOfCredit("dataforseo_not_configured", "dataforseo.serp");
    expect(alertMock).not.toHaveBeenCalled();
  });
});

describe("both clients report a 402", () => {
  const saved = { l: process.env.DATAFORSEO_LOGIN, p: process.env.DATAFORSEO_PASSWORD };
  beforeEach(() => {
    alertMock.mockClear();
    __resetOutOfCreditAlertForTests();
    process.env.DATAFORSEO_LOGIN = "l";
    process.env.DATAFORSEO_PASSWORD = "p";
  });
  afterEach(() => {
    process.env.DATAFORSEO_LOGIN = saved.l;
    process.env.DATAFORSEO_PASSWORD = saved.p;
  });

  it("askEngine: 402 with a vendor code in the body", async () => {
    const out = await askEngine(
      engineDef("chatgpt")!,
      "q",
      { locationCode: 2840, languageCode: "en", country: "US", models: { claude: "c", perplexity: "s" } },
      { fetch: async () => res402({ status_code: 40200 }) },
    );
    expect(out).toMatchObject({ ok: false, error_code: "dataforseo_40200" });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it("fetchSerp: bare HTTP 402", async () => {
    const out = await fetchSerp("plumber", { fetch: async () => res402() });
    expect(out).toMatchObject({ ok: false, error_code: "dataforseo_http_402" });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });
});
