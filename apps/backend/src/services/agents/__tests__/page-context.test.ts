import { describe, it, expect } from "vitest";
import {
  pageContextSchema,
  normalizePageContext,
  stripUrlQuery,
  PAGE_CONTEXT_SURFACE,
  CURRENT_SCHEMA_VERSION,
  MAX_EXTRACTION_BYTES,
  MAX_LABEL_CHARS,
  pageContextRequestSchema,
  normalizeScreenshotPageContext,
  isScreenshotPageContext,
  screenshotPageContextSchema,
} from "@/services/agents/page-context";

const ADS_URL = "https://adsmanager.facebook.com/adsmanager/manage/campaigns";

const extraction = (rows: unknown[] = []) => ({
  rows,
  truncated: false,
  row_count_total: rows.length,
});

const row = (over: Record<string, unknown> = {}) => ({
  name: "Retargeting - US",
  level: "campaign" as const,
  spend: 4201.55,
  cpa: 84.02,
  roas: 1.4,
  currency: "USD",
  ...over,
});

const parseOk = (o: unknown) => pageContextSchema.parse(o);

describe("the retired DOM shape is refused, loudly", () => {
  it("rejects a body carrying a raw dom field", () => {
    expect(
      pageContextSchema.safeParse({
        url: ADS_URL,
        dom: "<div><span>$4,201.55</span></div>",
      }).success,
    ).toBe(false);
  });

  it("rejects any unknown field, so a future shape drift cannot ride along", () => {
    expect(
      pageContextSchema.safeParse({ url: ADS_URL, html: "<p>x</p>" }).success,
    ).toBe(false);
  });
});

describe("typed extraction survives intact — the thing the DOM path destroyed", () => {
  it("keeps the actual numbers and the campaign name", () => {
    const out = normalizePageContext(
      parseOk({
        url: ADS_URL,
        title: "Campaigns",
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row()]),
      }),
    );
    expect(out.observation_only).toBe(false);
    expect(out.extraction?.rows[0].spend).toBe(4201.55);
    expect(out.extraction?.rows[0].cpa).toBe(84.02);
    expect(out.extraction?.rows[0].name).toBe("Retargeting - US");
  });

  it("never coerces an unreadable metric to zero", () => {
    const out = normalizePageContext(
      parseOk({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row({ spend: null, roas: undefined })]),
      }),
    );
    expect(out.extraction?.rows[0].spend).toBeNull();
    expect(out.extraction?.rows[0].roas).toBeNull();
  });

  it("rejects NaN and Infinity rather than storing a broken number", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        pageContextSchema.safeParse({
          url: ADS_URL,
          adapter_id: "meta_ads",
          schema_version: CURRENT_SCHEMA_VERSION,
          extraction: extraction([row({ spend: bad })]),
        }).success,
      ).toBe(false);
    }
  });
});

describe("provenance validation", () => {
  it("refuses an extraction with no adapter_id or schema_version", () => {
    expect(
      pageContextSchema.safeParse({
        url: ADS_URL,
        extraction: extraction([row()]),
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown adapter_id", () => {
    expect(
      pageContextSchema.safeParse({
        url: ADS_URL,
        adapter_id: "totally_trusted_vendor",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row()]),
      }).success,
    ).toBe(false);
  });

  it("refuses a schema_version this server does not speak", () => {
    expect(
      pageContextSchema.safeParse({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: 99,
        extraction: extraction([row()]),
      }).success,
    ).toBe(false);
  });

  it("DOWNGRADES to observation-only when the adapter claims the wrong host", () => {
    const out = normalizePageContext(
      parseOk({
        url: "https://evil.example.com/fake-ads-manager",
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row({ spend: 999999 })]),
      }),
    );
    expect(out.observation_only).toBe(true);
    expect(out.extraction).toBeNull();
    expect(out.adapter_id).toBeNull();
  });

  it("keeps any accepted extraction under the byte cap", () => {
    const many = Array.from({ length: 60 }, () =>
      row({ name: "x".repeat(MAX_LABEL_CHARS * 4) }),
    );
    const parsed = pageContextSchema.safeParse({
      url: ADS_URL,
      adapter_id: "meta_ads",
      schema_version: CURRENT_SCHEMA_VERSION,
      extraction: extraction(many),
    });
    if (parsed.success) {
      expect(
        Buffer.byteLength(JSON.stringify(parsed.data.extraction), "utf8"),
      ).toBeLessThanOrEqual(MAX_EXTRACTION_BYTES);
    } else {
      expect(parsed.success).toBe(false);
    }
  });
});

describe("observation mode", () => {
  it("is how an unrecognized page arrives — not an error", () => {
    const parsed = pageContextSchema.safeParse({
      url: "https://news.ycombinator.com/",
      title: "Hacker News",
    });
    expect(parsed.success).toBe(true);
    const out = normalizePageContext(parsed.data!);
    expect(out.observation_only).toBe(true);
    expect(out.extraction).toBeNull();
    expect(out.title).toBe("Hacker News");
  });

  it("always marks the surface as browser-observed, never verified", () => {
    const out = normalizePageContext(
      parseOk({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row()]),
      }),
    );
    expect(out.browser_observed).toBe(true);
  });
});

describe("stripUrlQuery", () => {
  it("drops query, fragment and credentials but keeps the path", () => {
    expect(stripUrlQuery(`${ADS_URL}?act=123456&session_token=abc#tab=2`)).toBe(
      ADS_URL,
    );
  });

  it("returns null for a non-http scheme or unparseable input", () => {
    expect(stripUrlQuery("javascript:alert(1)")).toBeNull();
    expect(stripUrlQuery("file:///etc/passwd")).toBeNull();
    expect(stripUrlQuery("not a url")).toBeNull();
  });
});

describe("label cleaning (untrusted third-party text)", () => {
  it("PRESERVES currency and punctuation — a label is not a slug", () => {
    const name = "Q4 Sale - $4,201.55 (US) 50% off";
    const out = normalizePageContext(
      parseOk({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row({ name })]),
      }),
    );
    expect(out.extraction?.rows[0].name).toBe(name);
  });

  it("strips control characters and collapses whitespace", () => {
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const CR = String.fromCharCode(13);
    const DEL = String.fromCharCode(127);
    const dirty = `Bad${NUL}Name${BEL}with${CR}junk${DEL}   and   spaces`;
    const out = normalizePageContext(
      parseOk({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row({ name: dirty })]),
      }),
    );
    const cleaned = out.extraction!.rows[0].name;
    expect(cleaned).toBe("Bad Name with junk and spaces");
    expect(/[\u0000-\u001f\u007f]/.test(cleaned)).toBe(false);
  });

  it("caps a label so a hostile client cannot stuff a document into a name", () => {
    const out = normalizePageContext(
      parseOk({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row({ name: "n".repeat(400) })]),
      }),
    );
    expect(out.extraction!.rows[0].name).toHaveLength(MAX_LABEL_CHARS);
  });
});

describe("persisted shape", () => {
  it("carries provenance and the observed flag, and never a dom", () => {
    const normalized = normalizePageContext(
      parseOk({
        url: `${ADS_URL}?token=nope`,
        title: "Campaigns",
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row()]),
      }),
    );
    const persisted = {
      surface: PAGE_CONTEXT_SURFACE,
      page_context: {
        url: normalized.url,
        title: normalized.title,
        adapter_id: normalized.adapter_id,
        schema_version: normalized.schema_version,
        extraction: normalized.extraction,
        observation_only: normalized.observation_only,
        browser_observed: normalized.browser_observed,
      },
    };
    expect(Object.keys(persisted.page_context).sort()).toEqual([
      "adapter_id",
      "browser_observed",
      "extraction",
      "observation_only",
      "schema_version",
      "title",
      "url",
    ]);
    expect(persisted.page_context).not.toHaveProperty("dom");
    expect(persisted.page_context).not.toHaveProperty("dom_scrubbed");
    expect(persisted.page_context.url).not.toContain("token=");
    expect(persisted).not.toHaveProperty("trigger");
  });
});

describe("route-parser scoping (guards the 640KB body limit in app.ts)", () => {
  const matches = (p: string) => /^\/api\/agents\/[^/]+\/chat\/?$/.test(p);

  it("covers the chat route with and without a trailing slash", () => {
    expect(matches("/api/agents/meta_ads/chat")).toBe(true);
    expect(matches("/api/agents/meta_ads/chat/")).toBe(true);
  });

  it("does not over-match sibling routes", () => {
    expect(matches("/api/agents/meta_ads/chat/history")).toBe(false);
    expect(matches("/api/agents/meta_ads/clarify-submit")).toBe(false);
    expect(matches("/api/agents/a/b/chat")).toBe(false);
  });
});

describe("the extraction shape is strict at EVERY level", () => {
  it("refuses an unknown key on the extraction itself", () => {
    const bad = pageContextSchema.safeParse({
      url: ADS_URL,
      adapter_id: "meta_ads",
      schema_version: CURRENT_SCHEMA_VERSION,
      extraction: { ...extraction([row()]), vendor: "meta_ads" },
    });
    expect(bad.success).toBe(false);
  });

  it("refuses an unknown key on a row", () => {
    const bad = pageContextSchema.safeParse({
      url: ADS_URL,
      adapter_id: "meta_ads",
      schema_version: CURRENT_SCHEMA_VERSION,
      extraction: extraction([{ ...row(), frequency: 1.7 }]),
    });
    expect(bad.success).toBe(false);
  });

  it("still accepts a MINIMAL row — every metric is genuinely optional", () => {
    const ok = pageContextSchema.safeParse({
      url: ADS_URL,
      adapter_id: "meta_ads",
      schema_version: CURRENT_SCHEMA_VERSION,
      extraction: {
        rows: [{ name: "A", level: "campaign" }],
        truncated: false,
        row_count_total: 1,
      },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts an extraction with only the required envelope fields", () => {
    const ok = pageContextSchema.safeParse({
      url: ADS_URL,
      adapter_id: "meta_ads",
      schema_version: CURRENT_SCHEMA_VERSION,
      extraction: { rows: [] },
    });
    expect(ok.success).toBe(true);
  });
});

describe("screenshot-mode page_context", () => {
  const SHOT = {
    mode: "screenshot",
    url: "https://app.slack.com/client/T1?token=x#y",
    title: `Slack${String.fromCharCode(7)} | DM`,
  };

  it("the request schema accepts screenshot mode and still accepts the typed shape", () => {
    expect(pageContextRequestSchema.safeParse(SHOT).success).toBe(true);
    expect(
      pageContextRequestSchema.safeParse({
        url: ADS_URL,
        adapter_id: "meta_ads",
        schema_version: CURRENT_SCHEMA_VERSION,
        extraction: extraction([row()]),
      }).success,
    ).toBe(true);
  });

  it("is STRICT: no extraction/adapter fields may ride along with mode", () => {
    for (const extra of [
      { adapter_id: "meta_ads" },
      { schema_version: CURRENT_SCHEMA_VERSION },
      { extraction: extraction([]) },
      { dom: "<p>x</p>" },
    ]) {
      expect(pageContextRequestSchema.safeParse({ ...SHOT, ...extra }).success).toBe(false);
    }
  });

  it("rejects an unknown mode and a non-http(s) url", () => {
    expect(pageContextRequestSchema.safeParse({ ...SHOT, mode: "dom" }).success).toBe(false);
    expect(
      screenshotPageContextSchema.safeParse({ ...SHOT, url: "chrome://settings" }).success,
    ).toBe(false);
  });

  it("normalizes url (query/fragment stripped) and title (control chars removed)", () => {
    const n = normalizeScreenshotPageContext(screenshotPageContextSchema.parse(SHOT));
    expect(n).toEqual({
      mode: "screenshot",
      url: "https://app.slack.com/client/T1",
      title: "Slack | DM",
    });
  });

  it("isScreenshotPageContext reads a body or run payload, and is total", () => {
    expect(isScreenshotPageContext({ page_context: SHOT })).toBe(true);
    expect(isScreenshotPageContext({ page_context: { url: ADS_URL } })).toBe(false);
    for (const v of [null, undefined, 0, "x", {}, { page_context: null }]) {
      expect(isScreenshotPageContext(v)).toBe(false);
    }
  });
});
