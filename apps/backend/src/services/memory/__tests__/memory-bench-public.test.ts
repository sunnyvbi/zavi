
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs sibling harness, no type decls (pure JS, intentional).
import { scoreRecall, makeLexicalCosineSearch, orderHolds } from "../../../../scripts/lib/memory-bench-public-score.mjs";
// @ts-expect-error — .mjs sibling harness, no type decls (pure JS, intentional).
import { loadFixtures } from "../../../../scripts/memory-bench-public.mjs";
import { runMemoryRecallEval, type Golden } from "../recall-eval";

const TENANT = "00000000-0000-4000-8000-000000000human";

type FixtureGolden = {
  id: string;
  query: string;
  expected_note_ids: string[];
  expected_order?: string[];
};

describe("public memory benchmark — scorer parity with internal recall-eval", () => {
  it("scoreRecall (public .mjs) == runMemoryRecallEval (canonical .ts) on the committed fixtures", async () => {
    const { corpus, goldens } = loadFixtures() as {
      corpus: Array<{ note_id: string; title: string; body: string }>;
      goldens: FixtureGolden[];
    };
    expect(goldens.length).toBeGreaterThan(0);

    const lex = makeLexicalCosineSearch(corpus);

    const publicResult = await scoreRecall({
      goldens,
      search: (query: string, k: number) => lex(query, k),
    });

    const canonGoldens: Golden[] = goldens.map((g) => ({
      id: g.id,
      tenant_id: TENANT,
      query: g.query,
      expected_note_ids: g.expected_note_ids,
      expected_order: g.expected_order,
    }));
    const canonResult = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens: canonGoldens, threshold: 0 },
      {
        search: async (_tid, query, k) => {
          const hits = await lex(query, k);
          return hits.map((h: { note_id: string }) => ({ note_id: h.note_id }));
        },
        verifyTenantNotes: async (_tid, ids) => new Set(ids),
      },
    );

    expect(publicResult.top3_recall).toBe(canonResult.top3_recall);
    expect(publicResult.mrr).toBe(canonResult.mrr);
    expect(publicResult.queries_run).toBe(canonResult.queries_run);
    expect(canonResult.cross_tenant_hits).toBe(0);
  });

  it("the committed fixtures DISCRIMINATE — lexical baseline recall@3 is strictly below 1.0", async () => {
    const { goldens, corpus } = loadFixtures() as {
      corpus: Array<{ note_id: string; title: string; body: string }>;
      goldens: FixtureGolden[];
    };
    const lex = makeLexicalCosineSearch(corpus);
    const r = await scoreRecall({ goldens, search: (q: string, k: number) => lex(q, k) });
    expect(r.top3_recall).toBeLessThan(1.0);
    expect(r.top3_recall).toBeGreaterThan(0.5);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("matches the canonical math on a hand-built KNOWN fixture (exact numbers)", async () => {
    const corpus = [
      { note_id: "n1", title: "blue widget pricing", body: "the blue widget costs ten dollars" },
      { note_id: "n2", title: "red widget pricing", body: "the red widget costs twenty dollars" },
      { note_id: "n3", title: "shipping policy", body: "orders ship within three days" },
      { note_id: "n4", title: "return policy", body: "returns accepted within thirty days" },
    ];
    const goldens = [
      { id: "g1", query: "how much is the blue widget", expected_note_ids: ["n1"] },
      { id: "g2", query: "shipping time for orders", expected_note_ids: ["n3"] },
      { id: "g3", query: "completely unrelated quantum chromodynamics", expected_note_ids: [] },
    ];
    const lex = makeLexicalCosineSearch(corpus);

    const pub = await scoreRecall({ goldens, search: (q: string, k: number) => lex(q, k) });
    expect(pub.top3_recall).toBe(1);
    expect(pub.mrr).toBe(1);

    const canon = await runMemoryRecallEval(
      {
        tenant_id: TENANT,
        mode: "eval",
        goldens: goldens.map((g) => ({ ...g, tenant_id: TENANT })) as Golden[],
        threshold: 0,
      },
      {
        search: async (_t, q, k) => (await lex(q, k)).map((h: { note_id: string }) => ({ note_id: h.note_id })),
        verifyTenantNotes: async (_t, ids) => new Set(ids),
      },
    );
    expect(pub.top3_recall).toBe(canon.top3_recall);
    expect(pub.mrr).toBe(canon.mrr);
  });

  it("orderHolds mirrors the canonical knowledge-update ordering check", () => {
    expect(orderHolds(["a", "b", "c"], ["a", "c"])).toBe(true);
    expect(orderHolds(["a", "b", "c"], ["c", "a"])).toBe(false);
    expect(orderHolds(["a", "b"], ["a", "x"])).toBe(false);
  });
});

describe("public memory benchmark — flag-OFF (hermetic) is pure + deterministic + offline", () => {
  it("hermetic lexical search is deterministic and never touches DB/network", async () => {
    const { corpus, goldens } = loadFixtures() as {
      corpus: Array<{ note_id: string; title: string; body: string }>;
      goldens: FixtureGolden[];
    };
    const lex = makeLexicalCosineSearch(corpus);

    const r1 = await scoreRecall({ goldens, search: (q: string, k: number) => lex(q, k) });
    const r2 = await scoreRecall({ goldens, search: (q: string, k: number) => lex(q, k) });
    expect(r1).toEqual(r2);

    const offTopic = await lex("recommended tire pressure for a toyota camry", 8);
    expect(offTopic.length).toBe(0);

    expect(r1.top3_recall).toBeGreaterThan(0.5);
  });
});
