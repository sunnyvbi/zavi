import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  MAX_EXTRACTION_BYTES as SERVER_MAX_EXTRACTION_BYTES,
  SUPPORTED_ADAPTER_IDS,
  extractionSchema,
  normalizePageContext,
  pageContextSchema,
} from "../../../backend/src/services/agents/page-context";
import {
  MAX_JSON_BYTES as ADAPTER_MAX_JSON_BYTES,
  MAX_ROWS,
  META_ADS_ADAPTER_ID,
  pickAdapterForUrl,
} from "../adapters";
import { MAX_EXTRACTION_BYTES as CLIENT_MAX_EXTRACTION_BYTES } from "../shared/extraction-cap";

const FIXTURES = join(process.cwd(), "src/adapters/__tests__/fixtures");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const docOf = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

const US_URL = "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1";
const EU_URL = "https://business.facebook.com/adsmanager/manage/adsets";

function wireBody(url: string, html: string): Record<string, unknown> {
  const picked = pickAdapterForUrl(url, docOf(html));
  if (picked === null) throw new Error(`adapter did not claim ${url}`);
  return {
    url: new URL(url).origin + new URL(url).pathname,
    title: "Campaigns | Meta Ads Manager",
    adapter_id: picked.adapter_id,
    schema_version: picked.schema_version,
    extraction: picked.extraction,
  };
}

describe("adapter output satisfies the backend's extractionSchema", () => {
  for (const [name, url, file] of [
    ["US campaigns", US_URL, "meta-ads-campaigns-us.html"],
    ["EU ad sets", EU_URL, "meta-ads-adsets-eu.html"],
  ] as const) {
    it(`${name}: parses, and parsing changes NOTHING`, () => {
      const body = wireBody(url, fixture(file));
      const parsed = extractionSchema.parse(body.extraction);

      expect(parsed).toEqual(body.extraction);
    });
  }

  it("rows carry real numbers, so the schema check is not passing on an empty shell", () => {
    const body = wireBody(US_URL, fixture("meta-ads-campaigns-us.html"));
    const parsed = extractionSchema.parse(body.extraction);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.some((r) => typeof r.spend === "number")).toBe(true);
    expect(parsed.row_count_total).toBe(parsed.rows.length);
  });
});

describe("the full page_context body satisfies pageContextSchema", () => {
  it("parses the grounded (adapter hit) shape", () => {
    const body = wireBody(US_URL, fixture("meta-ads-campaigns-us.html"));
    const parsed = pageContextSchema.parse(body);
    expect(parsed.adapter_id).toBe(META_ADS_ADAPTER_ID);
    expect(parsed.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.extraction).toEqual(body.extraction);
  });

  it("parses the observation shape (url + title only)", () => {
    expect(() =>
      pageContextSchema.parse({ url: "https://example.com/x", title: "X" }),
    ).not.toThrow();
  });

  it("the adapter_id we send is one the server SUPPORTS", () => {
    expect([...SUPPORTED_ADAPTER_IDS]).toContain(META_ADS_ADAPTER_ID);
  });

  it("the schema_version we send is the one the server expects", () => {
    const picked = pickAdapterForUrl(US_URL, docOf(fixture("meta-ads-campaigns-us.html")));
    expect(picked?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("REJECTS a dom field — the retired shape must fail loudly", () => {
    const body = wireBody(US_URL, fixture("meta-ads-campaigns-us.html"));
    expect(() => pageContextSchema.parse({ ...body, dom: "<html></html>" })).toThrow();
  });
});

describe("normalizePageContext keeps our extraction, it does not downgrade it", () => {
  for (const [name, url, file] of [
    ["adsmanager host", US_URL, "meta-ads-campaigns-us.html"],
    ["business host", EU_URL, "meta-ads-adsets-eu.html"],
  ] as const) {
    it(`${name}: survives the server's host check as grounded`, () => {
      const normalized = normalizePageContext(
        pageContextSchema.parse(wireBody(url, fixture(file))),
      );
      expect(normalized.observation_only).toBe(false);
      expect(normalized.adapter_id).toBe(META_ADS_ADAPTER_ID);
      expect(normalized.extraction).not.toBeNull();
      expect(normalized.browser_observed).toBe(true);
    });
  }

  it("a host the client claims but the server does not allow is downgraded", () => {
    const body = wireBody(US_URL, fixture("meta-ads-campaigns-us.html"));
    const normalized = normalizePageContext(
      pageContextSchema.parse({ ...body, url: "https://www.facebook.com/adsmanager" }),
    );
    expect(normalized.observation_only).toBe(true);
    expect(normalized.extraction).toBeNull();
  });
});

describe("the byte caps agree in the right direction", () => {
  it("the client cap is STRICTLY below the server's", () => {
    expect(CLIENT_MAX_EXTRACTION_BYTES).toBeLessThan(SERVER_MAX_EXTRACTION_BYTES);
  });

  it("the null-filling growth really happens, and the headroom covers it", () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => ({
      name: `Campaign ${i}`,
      level: "campaign" as const,
    }));
    const ours = {
      rows,
      date_preset: null,
      account_name: null,
      truncated: false,
      row_count_total: MAX_ROWS,
    };
    const theirs = extractionSchema.parse(ours);

    const bytes = (v: unknown): number =>
      new TextEncoder().encode(JSON.stringify(v)).length;

    const added = bytes(theirs) - bytes(ours);
    expect(added).toBeGreaterThan(0);

    const headroom = SERVER_MAX_EXTRACTION_BYTES - CLIENT_MAX_EXTRACTION_BYTES;
    expect(added).toBeLessThan(headroom);

    expect(CLIENT_MAX_EXTRACTION_BYTES + added).toBeLessThanOrEqual(
      SERVER_MAX_EXTRACTION_BYTES,
    );
  });

  it("the caps are ordered adapter < panel < server", () => {
    expect(ADAPTER_MAX_JSON_BYTES).toBeLessThan(CLIENT_MAX_EXTRACTION_BYTES);
    expect(CLIENT_MAX_EXTRACTION_BYTES).toBeLessThan(SERVER_MAX_EXTRACTION_BYTES);
  });

  it("the row cap matches the server's", () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({
      name: `Campaign ${i}`,
      level: "campaign" as const,
    }));
    expect(() =>
      extractionSchema.parse({
        rows,
        date_preset: null,
        account_name: null,
        truncated: true,
        row_count_total: rows.length,
      }),
    ).toThrow();
  });
});
