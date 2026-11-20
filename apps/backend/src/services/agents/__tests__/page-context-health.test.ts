
import { describe, it, expect, vi, beforeEach } from "vitest";

const logEventMock = vi.fn();
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  LOG_META_KEYS: [] as const,
}));

import {
  detectAdapterBreakage,
  recordAdapterHealth,
  DETECTED_FIELDS,
} from "../page-context-health";
import { normalizePageContext, type PageContextInput } from "../page-context";

const META_URL = "https://adsmanager.facebook.com/adsmanager/manage/campaigns";

type RowIn = {
  name: string;
  spend?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  cpa?: number | null;
  roas?: number | null;
  status?: string | null;
};

function row(over: RowIn) {
  return {
    level: "campaign" as const,
    status: null,
    spend: null,
    impressions: null,
    clicks: null,
    cpa: null,
    roas: null,
    currency: "USD",
    ...over,
  };
}

function ctxOf(over: Partial<PageContextInput> = {}) {
  const input = {
    url: META_URL,
    title: "Ads Manager",
    adapter_id: "meta_ads" as const,
    schema_version: 1 as const,
    extraction: {
      rows: [],
      date_preset: "last_7d",
      account_name: null,
      truncated: false,
      row_count_total: 0,
    },
    ...over,
  } as PageContextInput;
  return normalizePageContext(input);
}

describe("detectAdapterBreakage — FIRES", () => {
  it("zero rows on a supported host (signals 1 + 2: header rename / ARIA roles gone)", () => {
    const found = detectAdapterBreakage(ctxOf());
    expect(found).toEqual([
      {
        kind: "zero_rows",
        outcome: "empty_or_broken",
        adapter_id: "meta_ads",
        row_count_total: 0,
      },
    ]);
  });

  it("names `spend` when every row's spend is null but other columns still map (signal 4)", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [
          row({ name: "Prospecting — US", impressions: 41_000, clicks: 310, roas: 2.4 }),
          row({ name: "Retargeting — US", impressions: 9_100, clicks: 88, roas: 1.1 }),
        ],
        date_preset: "last_7d",
        account_name: "Acme",
        truncated: false,
        row_count_total: 2,
      },
    });
    const found = detectAdapterBreakage(ctx);
    const spend = found.filter((f) => f.kind === "field_all_null" && f.field === "spend");
    expect(spend).toEqual([
      {
        kind: "field_all_null",
        outcome: "unmapped_or_absent",
        adapter_id: "meta_ads",
        field: "spend",
        rows_present: 2,
      },
    ]);
  });

  it("reports EVERY degraded field when the whole numeric band goes null", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [row({ name: "A" }), row({ name: "B" })],
        date_preset: null,
        account_name: null,
        truncated: false,
        row_count_total: 2,
      },
    });
    const fields = detectAdapterBreakage(ctx).map((f) =>
      f.kind === "field_all_null" ? f.field : f.kind,
    );
    expect(fields).toEqual([...DETECTED_FIELDS]);
  });
});

describe("detectAdapterBreakage — STAYS SILENT", () => {
  it("a healthy extraction fires nothing", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [
          row({ name: "Prospecting", spend: 4201.55, impressions: 120_400, clicks: 980, cpa: 18.2, roas: 2.9 }),
          row({ name: "Retargeting", spend: 611.2, impressions: 18_900, clicks: 240, cpa: 12.0, roas: 4.1 }),
        ],
        date_preset: "last_7d",
        account_name: "Acme",
        truncated: false,
        row_count_total: 2,
      },
    });
    expect(detectAdapterBreakage(ctx)).toEqual([]);
  });

  it("an unrecognized page (observation_only) fires nothing — no adapter ran", () => {
    const ctx = normalizePageContext({ url: "https://example.test/dashboard", title: "Other" });
    expect(ctx.observation_only).toBe(true);
    expect(detectAdapterBreakage(ctx)).toEqual([]);
  });

  it("a supported adapter claimed on the WRONG host fires nothing (server downgrade)", () => {
    const ctx = ctxOf({ url: "https://evil.test/adsmanager" });
    expect(ctx.observation_only).toBe(true);
    expect(detectAdapterBreakage(ctx)).toEqual([]);
  });

  it("a truncated extraction fires nothing, even when every sampled row is null", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [row({ name: "A" }), row({ name: "B" })],
        date_preset: null,
        account_name: null,
        truncated: true,
        row_count_total: 60,
      },
    });
    expect(detectAdapterBreakage(ctx)).toEqual([]);
  });

  it("a truncated extraction with ZERO rows fires nothing", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [],
        date_preset: null,
        account_name: null,
        truncated: true,
        row_count_total: 12,
      },
    });
    expect(detectAdapterBreakage(ctx)).toEqual([]);
  });

  it("a SINGLE row with a real value fires nothing for that field", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [
          row({ name: "Only campaign", spend: 12.34, impressions: 900, clicks: 7, cpa: 1.76, roas: 0.5 }),
        ],
        date_preset: "today",
        account_name: "Solo",
        truncated: false,
        row_count_total: 1,
      },
    });
    expect(detectAdapterBreakage(ctx)).toEqual([]);
  });

  it("does not fire on a field that is null on SOME rows but not all", () => {
    const ctx = ctxOf({
      extraction: {
        rows: [row({ name: "A", spend: 10 }), row({ name: "B" })],
        date_preset: null,
        account_name: null,
        truncated: false,
        row_count_total: 2,
      },
    });
    const spendFindings = detectAdapterBreakage(ctx).filter(
      (f) => f.kind === "field_all_null" && f.field === "spend",
    );
    expect(spendFindings).toEqual([]);
  });

  it("is pure — the same input twice yields the same findings and no throw", () => {
    const ctx = ctxOf();
    expect(detectAdapterBreakage(ctx)).toEqual(detectAdapterBreakage(ctx));
  });
});

describe("recordAdapterHealth — the emitted payload", () => {
  beforeEach(() => {
    logEventMock.mockReset();
  });

  const PAGE_DERIVED = [
    "Retarget — jane.doe@client.example",
    "ACME Holdings LLC",
    "adsmanager.facebook.com",
    "/adsmanager/manage/campaigns",
    "ACTIVE",
    "last_7d",
    "4201.55",
  ];

  function hostileCtx() {
    return ctxOf({
      extraction: {
        rows: [
          row({
            name: "Retarget — jane.doe@client.example",
            status: "ACTIVE",
            impressions: 4201.55,
          }),
        ],
        date_preset: "last_7d",
        account_name: "ACME Holdings LLC",
        truncated: false,
        row_count_total: 1,
      },
    });
  }

  it("emits a stable, groupable code + counters and NOTHING page-derived", () => {
    recordAdapterHealth({ ctx: hostileCtx(), run_id: "run-1", tenant_id: "tenant-A" });

    expect(logEventMock).toHaveBeenCalledTimes(4);

    for (const call of logEventMock.mock.calls) {
      const arg = call[0] as {
        level: string;
        source: string;
        code: string;
        run_id: string;
        tenant_id: string;
        message?: string;
        meta: Record<string, unknown>;
      };

      expect(arg.source).toBe("review");
      expect(arg.code).toBe("review.extension_adapter.field_all_null");
      expect(arg.run_id).toBe("run-1");
      expect(arg.tenant_id).toBe("tenant-A");
      expect(arg.message).toBeUndefined();

      expect(Object.keys(arg.meta).sort()).toEqual([
        "adapter_id",
        "null_field",
        "review_outcome",
        "rows_present",
      ]);

      expect(arg.meta.adapter_id).toBe("meta_ads");
      expect(arg.meta.review_outcome).toBe("unmapped_or_absent");
      expect(DETECTED_FIELDS).toContain(arg.meta.null_field);
      expect(arg.meta.rows_present).toBe(1);
      expect(typeof arg.meta.rows_present).toBe("number");

      const serialized = JSON.stringify(arg);
      for (const leak of PAGE_DERIVED) {
        expect(serialized).not.toContain(leak);
      }
      expect(Object.keys(arg).sort()).toEqual([
        "code",
        "level",
        "meta",
        "run_id",
        "source",
        "tenant_id",
      ]);
    }

    const named = logEventMock.mock.calls.map((c) => (c[0] as { meta: { null_field: string } }).meta.null_field);
    expect(named.sort()).toEqual(["clicks", "cpa", "roas", "spend"]);
  });

  it("emits the zero-rows record with row_count_total and rows_present:0", () => {
    recordAdapterHealth({ ctx: ctxOf(), run_id: "run-2", tenant_id: "tenant-A" });
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const arg = logEventMock.mock.calls[0][0] as {
      code: string;
      meta: Record<string, unknown>;
    };
    expect(arg.code).toBe("review.extension_adapter.zero_rows");
    expect(Object.keys(arg.meta).sort()).toEqual([
      "adapter_id",
      "review_outcome",
      "row_count_total",
      "rows_present",
    ]);
    expect(arg.meta.review_outcome).toBe("empty_or_broken");
    expect(arg.meta.rows_present).toBe(0);
    expect(arg.meta.row_count_total).toBe(0);
  });

  it("emits nothing at all on a healthy page or an unrecognized one", () => {
    recordAdapterHealth({
      ctx: ctxOf({
        extraction: {
          rows: [row({ name: "A", spend: 1, impressions: 2, clicks: 3, cpa: 4, roas: 5 })],
          date_preset: null,
          account_name: null,
          truncated: false,
          row_count_total: 1,
        },
      }),
      run_id: "run-3",
      tenant_id: "tenant-A",
    });
    recordAdapterHealth({
      ctx: normalizePageContext({ url: "https://example.test/x" }),
      run_id: "run-4",
      tenant_id: "tenant-A",
    });
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it("never throws, so it can never fail the customer's turn", () => {
    logEventMock.mockImplementation(() => {
      throw new Error("log sink down");
    });
    expect(() =>
      recordAdapterHealth({ ctx: ctxOf(), run_id: "run-5", tenant_id: "tenant-A" }),
    ).not.toThrow();
  });
});
