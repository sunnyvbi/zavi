import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  create: vi.fn(),
  tenantClient: vi.fn(),
  card: { data: null as unknown, error: null as unknown },
  facts: { data: [] as unknown[], error: null as unknown },
  filters: [] as [string, string, unknown][],
}));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/anthropic", () => ({
  createMessageWithFailover: m.create,
  DEFAULT_FAST_MODEL: "fast",
  cachedSystemBlock: (t: string) => ({ type: "text", text: t }),
}));
vi.mock("@/services/tenant-client", () => ({ tenantClient: m.tenantClient }));

import { channelBlankSuggestions, parseSuggestions } from "../blank-suggestions";
import { resetTenantPlan } from "@/__tests__/helpers/tenant-plan";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const CARD = "0b6f6f9e-2f6c-4c55-9f3e-6a3c1f0b9c11";

function table(name: string) {
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => {
      m.filters.push([name, col, v]);
      return q;
    },
    in: (col: string, v: unknown) => {
      m.filters.push([name, col, v]);
      return Promise.resolve(m.facts);
    },
    maybeSingle: () => Promise.resolve(m.card),
  };
  return q;
}

function res() {
  const r: { _status?: number; _body?: Record<string, unknown>; status: (n: number) => unknown; json: (b: Record<string, unknown>) => unknown } = {
    status(n) {
      r._status = n;
      return r;
    },
    json(b) {
      r._body = b;
      return r;
    },
  };
  return r;
}
const req = (body: unknown, slug = "linkedin_ads", id = CARD) => ({ params: { slug, id }, body }) as never;
const reply = (text: string) => ({ content: [{ type: "text", text }] });
const BLANKS = { blanks: [{ blank: "[fill in: the countries you serve]", label: "Locations" }, { blank: "[fill in: the visit window you want]" }] };

beforeEach(() => {
  resetTenantPlan();
  m.filters = [];
  m.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "u" });
  m.tenantClient.mockReset().mockImplementation(() => ({ from: table }));
  m.card = { data: { id: CARD, channel_slug: "linkedin_ads", title: "Two audiences", body: { step: { body: "b", deliverable: { content: "AUDIENCE 1: x" } } } }, error: null };
  m.facts = { data: [{ key: "company_name", value_text: "Tinnitus Relief" }, { key: "country", value_text: "United States" }], error: null };
  m.create.mockReset().mockResolvedValue(reply('{"suggestions":{"0":["United States; Canada"],"1":["Last 90 days"]}}'));
});

describe("POST /api/channels/:slug/actions/:id/blank-suggestions", () => {
  it("must catch: answers come back keyed by gap, read only through this tenant's scoped client, with the business facts and card in the prompt", async () => {
    const r = res();
    await channelBlankSuggestions(req(BLANKS), r as never);
    expect(r._status).toBeUndefined();
    expect(r._body).toEqual({ suggestions: { "0": ["United States; Canada"], "1": ["Last 90 days"] } });
    expect(m.tenantClient).toHaveBeenCalledWith(TENANT);
    expect(m.filters).toContainEqual(["channel_actions", "id", CARD]);
    expect(m.filters).toContainEqual(["channel_actions", "channel_slug", "linkedin_ads"]);
    const sent = String(m.create.mock.calls[0][0].messages[0].content);
    expect(sent).toContain("company_name: Tinnitus Relief");
    expect(sent).toContain("0. Locations: [fill in: the countries you serve]");
    expect(sent).toContain("AUDIENCE 1: x");
  });

  it("must catch: a card from another channel or another tenant answers 404 and never reaches the model", async () => {
    m.card = { data: null, error: null };
    const r = res();
    await channelBlankSuggestions(req(BLANKS), r as never);
    expect(r._status).toBe(404);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("refuses bad input and unknown channels before any read or model call", async () => {
    for (const [body, slug, id] of [
      [{ blanks: [] }, "linkedin_ads", CARD],
      [{ blanks: Array.from({ length: 13 }, () => ({ blank: "[fill in: x]" })) }, "linkedin_ads", CARD],
      [BLANKS, "not_a_channel", CARD],
      [BLANKS, "linkedin_ads", "nope"],
    ] as const) {
      const r = res();
      await channelBlankSuggestions(req(body, slug, id), r as never);
      expect(r._status).toBe(400);
    }
    expect(m.tenantClient).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("returns nothing for an unauthenticated caller", async () => {
    m.requireAuth.mockResolvedValue(null);
    const r = res();
    await channelBlankSuggestions(req(BLANKS), r as never);
    expect(m.create).not.toHaveBeenCalled();
    expect(r._body).toBeUndefined();
  });

  it("maps model failures to a plain retryable error", async () => {
    for (const [err, code] of [[Object.assign(new Error("t"), { name: "TimeoutError" }), 504], [Object.assign(new Error("o"), { status: 529 }), 503], [new Error("x"), 502]] as const) {
      m.create.mockRejectedValueOnce(err);
      const r = res();
      await channelBlankSuggestions(req(BLANKS), r as never);
      expect(r._status).toBe(code);
      expect(r._body).toMatchObject({ error: { code: "llm_failed" } });
    }
  });
});

describe("parseSuggestions", () => {
  it("keeps strings only, trims, dedupes, caps at three, drops gaps out of range and junk", () => {
    const raw = 'Sure:\n{"suggestions":{"0":["  A  ","A","B",4,"C","D"],"1":[],"2":["x"],"5":["out"]}}';
    expect(parseSuggestions(raw, 3)).toEqual({ "0": ["A", "B", "C"], "2": ["x"] });
    expect(parseSuggestions("not json", 2)).toEqual({});
    expect(parseSuggestions('{"suggestions":{"0":["' + "y".repeat(200) + '"]}}', 1)).toEqual({});
  });
});
