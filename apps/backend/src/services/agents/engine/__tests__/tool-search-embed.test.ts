
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  _clearToolVectorCacheForTests,
  _toolVectorCacheSizeForTests,
  createToolSearch,
  type EmbedFn,
  type IndexedTool,
} from "../tool-search";
import { VoyageDimError, VoyageError } from "@/services/memory/embed";

const CONCEPTS: Record<string, number> = {
  message: 0, post: 0, send: 0, notify: 0, ping: 0, teammate: 0, colleague: 0, chat: 0, slack: 0,
  ad: 1, ads: 1, campaign: 1, spend: 1, roas: 1, marketing: 1, paid: 1, facebook: 1, meta: 1,
  code: 2, repository: 2, repo: 2, bug: 2, source: 2, github: 2, codebase: 2,
  refund: 3, charge: 3, payment: 3, money: 3, stripe: 3, customer: 3, back: 3,
  web: 4, page: 4, website: 4, url: 4, fetch: 4, site: 4, read: 4,
  database: 5, sql: 5, query: 5, rows: 5, table: 5, records: 5, bookings: 5,
};
const DIM = 6;

function fakeVec(text: string): number[] {
  const v = new Array(DIM).fill(0.01);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const d = CONCEPTS[w];
    if (d !== undefined) v[d] += 1;
  }
  return v;
}

function makeEmbed(): EmbedFn & { calls: Array<{ n: number; inputType: string }> } {
  const calls: Array<{ n: number; inputType: string }> = [];
  const fn = (async (texts: string[], inputType: "document" | "query") => {
    calls.push({ n: texts.length, inputType });
    return texts.map(fakeVec);
  }) as EmbedFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function t(name: string, description: string): IndexedTool {
  return { name, registeredName: name, serverId: name.split("__")[0], description, schemaText: "{}" };
}

const TOOLS: IndexedTool[] = [
  t("slack__post_message", "Post a message to a Slack channel"),
  t("meta_ads__get_insights", "Campaign spend and ROAS insights for Meta ads"),
  t("github__search_code", "Search source code in a GitHub repository"),
  t("stripe__create_refund", "Refund a Stripe charge"),
  t("web_fetch__fetch", "Fetch a web page by URL"),
  t("operator_db__query", "Run a read-only SQL query against the database"),
  ...Array.from({ length: 30 }, (_, i) => t(`misc__tool_${i}`, `Miscellaneous helper ${i}`)),
];

const QUERIES: Array<{ q: string; want: string }> = [
  { q: "notify a colleague", want: "slack__post_message" },
  { q: "how is our paid marketing doing", want: "meta_ads__get_insights" },
  { q: "find where the bug is in the codebase", want: "github__search_code" },
  { q: "give a customer their money back", want: "stripe__create_refund" },
  { q: "read this website", want: "web_fetch__fetch" },
  { q: "count bookings records", want: "operator_db__query" },
];

async function recallAt(k: number, embed?: EmbedFn): Promise<number> {
  let hit = 0;
  for (const { q, want } of QUERIES) {
    const s = createToolSearch({ tools: TOOLS, startingSet: [], embed, maxTools: 1000, maxDefChars: 1e9 });
    const txt = await s.search(q, k);
    if (txt.includes(`- ${want}:`)) hit++;
  }
  return hit / QUERIES.length;
}

beforeEach(() => _clearToolVectorCacheForTests());

describe("hybrid ranking", () => {
  it("beats keyword-only on the fixed query set (recall@3)", async () => {
    const kw = await recallAt(3);
    const hy = await recallAt(3, makeEmbed());
    expect(hy).toBeGreaterThan(kw);
    expect(hy).toBe(1);
  });

  it("keeps exact keyword hits on top", async () => {
    const s = createToolSearch({ tools: TOOLS, startingSet: [], embed: makeEmbed() });
    const txt = await s.search("stripe refund", 1);
    expect(txt).toContain("- stripe__create_refund:");
  });

  it("embeds tool text as 'document' and the search as 'query'", async () => {
    const embed = makeEmbed();
    const s = createToolSearch({ tools: TOOLS, startingSet: [], embed });
    await s.search("notify a colleague", 3);
    expect(embed.calls).toEqual([
      { n: TOOLS.length, inputType: "document" },
      { n: 1, inputType: "query" },
    ]);
  });
});

describe("vector cache", () => {
  it("vectors are reused across runs by text hash; only changed tools are re-embedded", async () => {
    const e1 = makeEmbed();
    await createToolSearch({ tools: TOOLS, startingSet: [], embed: e1 }).search("x ping", 3);
    expect(_toolVectorCacheSizeForTests()).toBe(TOOLS.length);

    const changed = TOOLS.map((x) =>
      x.name === "slack__post_message" ? { ...x, description: "Send a chat message" } : x,
    );
    const e2 = makeEmbed();
    await createToolSearch({ tools: changed, startingSet: [], embed: e2 }).search("ping", 3);
    expect(e2.calls[0]).toEqual({ n: 1, inputType: "document" });
  });

  it("a warm cache never leaks another run's tools into a search (tenant isolation)", async () => {
    const tenantA = [...TOOLS, t("tenant_skill__acme__payroll_export", "Export the payroll money ledger")];
    await createToolSearch({ tools: tenantA, startingSet: [], embed: makeEmbed() }).search("payroll money", 3);

    const sB = createToolSearch({ tools: TOOLS, startingSet: [], embed: makeEmbed(), maxTools: 1000, maxDefChars: 1e9 });
    const txt = await sB.search("payroll money ledger export", 15);
    expect(txt).not.toContain("tenant_skill__acme__payroll_export");
    expect([...sB.loaded].every((n) => TOOLS.some((x) => x.name === n))).toBe(true);
  });
});

describe("keyword fallback on any Voyage error", () => {
  const cases: Array<[string, () => Error]> = [
    ["missing key", () => new VoyageError(0, "VOYAGE_API_KEY not set")],
    ["non-200", () => new VoyageError(503, "voyage embed failed: 503")],
    ["bad dimension", () => new VoyageDimError(512, 1024)],
  ];
  for (const [label, mk] of cases) {
    it(`${label}: returns keyword results, logs once, stops calling Voyage for the run`, async () => {
      let calls = 0;
      const embed: EmbedFn = async () => {
        calls++;
        throw mk();
      };
      const log = vi.fn();
      const s = createToolSearch({ tools: TOOLS, startingSet: [], embed, log });
      const txt = await s.search("stripe refund", 3);
      expect(txt).toContain("- stripe__create_refund:");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatchObject({ event: "tool_search_embed_fallback" });
      const n = calls;
      expect(await s.search("github code", 3)).toContain("- github__search_code:");
      expect(calls).toBe(n);
    });
  }

  it("a wrong number of vectors is treated as a failure, not silently misaligned", async () => {
    const embed: EmbedFn = async (texts, type) => (type === "document" ? texts.slice(1).map(fakeVec) : texts.map(fakeVec));
    const log = vi.fn();
    const s = createToolSearch({ tools: TOOLS, startingSet: [], embed, log });
    expect(await s.search("stripe refund", 3)).toContain("- stripe__create_refund:");
    expect(log).toHaveBeenCalledTimes(1);
  });
});
