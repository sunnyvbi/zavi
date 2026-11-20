import { describe, expect, it, vi } from "vitest";
import { brandKeywordAction, brandTermOf, ensureBrandKeyword, parseSuggestions, suggestRedditSetup } from "../suggest";

const base = {
  takenKeywords: new Set<string>(),
  takenCompetitors: new Set<string>(),
  ownNames: ["Upcar", "upcar.ai", "upcar"],
  keywordRoom: 10,
  competitorRoom: 5,
};

describe("parseSuggestions", () => {
  it("caps the reason at six words so it fits one line", () => {
    const raw = JSON.stringify({
      keywords: [{ term: "p2p car rental", type: "category", why: "Abbreviated form commonly used in Reddit threads by tech-savvy renters." }],
      competitors: [{ name: "Getaround", domain: null, why: "Same buyers." }],
    });
    const out = parseSuggestions(raw, base);
    expect(out.keywords[0]?.why).toBe("Abbreviated form commonly used in Reddit");
    expect(out.competitors[0]?.why).toBe("Same buyers");
  });

  it("keeps valid rows, normalizes type and domain", () => {
    const raw = JSON.stringify({
      keywords: [
        { term: "  rent   my car out ", type: "problem", why: "from query" },
        { term: "turo alternative", type: "made_up_type", why: null },
      ],
      competitors: [{ name: "Turo", domain: "https://www.turo.com/us", why: "p2p rival" }],
    });
    const out = parseSuggestions(raw, base);
    expect(out.keywords).toEqual([
      { term: "rent my car out", type: "problem", why: "from query" },
      { term: "turo alternative", type: "problem", why: null },
    ]);
    expect(out.competitors).toEqual([{ name: "Turo", domain: "turo.com", why: "p2p rival" }]);
  });

  it("never re-suggests anything already saved or dismissed, and dedupes case-insensitively", () => {
    const raw = JSON.stringify({
      keywords: [{ term: "Car Sharing" }, { term: "car sharing" }, { term: "peer to peer car rental" }],
      competitors: [{ name: "turo" }, { name: "Getaround" }],
    });
    const out = parseSuggestions(raw, {
      ...base,
      takenKeywords: new Set(["peer to peer car rental"]),
      takenCompetitors: new Set(["turo"]),
    });
    expect(out.keywords.map((k) => k.term)).toEqual(["Car Sharing"]);
    expect(out.competitors.map((c) => c.name)).toEqual(["Getaround"]);
  });

  it("drops anything naming the company itself", () => {
    const raw = JSON.stringify({
      keywords: [{ term: "upcar reviews" }, { term: "is Upcar legit" }, { term: "car rental app" }],
      competitors: [{ name: "Upcar Rentals" }],
    });
    const out = parseSuggestions(raw, base);
    expect(out.keywords.map((k) => k.term)).toEqual(["car rental app"]);
    expect(out.competitors).toEqual([]);
  });

  it("respects room and length limits, and survives garbage", () => {
    const raw = JSON.stringify({
      keywords: [{ term: "a" }, { term: "x".repeat(81) }, { term: "one two" }, { term: "three four" }],
      competitors: "nope",
    });
    const out = parseSuggestions(raw, { ...base, keywordRoom: 1 });
    expect(out.keywords.map((k) => k.term)).toEqual(["one two"]);
    expect(out.competitors).toEqual([]);
    expect(parseSuggestions("not json", base)).toEqual({ keywords: [], competitors: [] });
  });
});

function fakeSb(seed: { keywords?: Array<Record<string, unknown>>; competitors?: Array<Record<string, unknown>> } = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const all = [...(seed.keywords ?? []), ...(seed.competitors ?? [])];
  const sb = {
    from(table: string) {
      let rows = table === "channel_settings" ? [...all] : [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = c === "field_id" ? rows.filter((r) => r[c] === v) : rows), q),
        in: (c: string, v: unknown[]) => ((rows = c === "field_id" ? rows.filter((r) => v.includes(r[c])) : rows), q),
        order: () => q,
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
      };
      return q;
    },
  };
  return { sb: sb as never, inserts };
}

const setting = (o: Record<string, unknown>) => ({
  tenant_id: "t1",
  channel_slug: "reddit_organic",
  item_type: null,
  status: "tracking",
  position: 0,
  note: null,
  origin: "custom",
  detail: null,
  updated_at: "2026-09-01T00:00:00.000Z",
  updated_by: null,
  ...o,
});
const onField = (field: string) => (i: { table: string; row: Record<string, unknown> }) =>
  i.table === "channel_settings" && i.row.field_id === field;

const facts = {
  name: "Upcar",
  nameIsWorkspaceLabel: false,
  website: "https://upcar.ai",
  competitors: ["Turo", "Getaround"],
  facts: { what_we_sell: { value: "P2P car rental", source: "human_confirmed", verified_at: null } },
};

describe("suggestRedditSetup", () => {
  it("tracks the brand and suggests profile competitors without a model, then the model's rows as suggested", async () => {
    const { sb, inserts } = fakeSb({
      competitors: [setting({ id: "c", field_id: "competitors", item: "Turo" })],
    });
    const callModel = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        keywords: [{ term: "rent my car out", type: "problem", why: "gsc" }],
        competitors: [{ name: "HyreCar", domain: "hyrecar.com", why: "rival" }],
      }),
    });
    const res = await suggestRedditSetup(sb, "t1", {
      callModel: callModel as never,
      companyFacts: async () => facts as never,
      searchConsoleQueries: async () => ["how to rent my car"],
      geoPrompts: async () => [],
    });
    expect(res).toMatchObject({ ok: true, keywords_added: 2, competitors_added: 2 });
    expect(callModel.mock.calls[0][0].messages[0].content).toContain("how to rent my car");
    const kw = inserts.filter(onField("keywords")).map((i) => i.row);
    const comp = inserts.filter(onField("competitors")).map((i) => i.row);
    expect(kw.map((r) => [r.item, r.item_type])).toEqual([
      ["Upcar", "brand"],
      ["rent my car out", "problem"],
    ]);
    expect(comp.map((r) => r.item)).toEqual(["Getaround", "HyreCar"]);
    expect(kw[0]).toMatchObject({
      tenant_id: "t1",
      channel_slug: "reddit_organic",
      field_id: "keywords",
      item: "Upcar",
      item_type: "brand",
      origin: "suggested",
      status: "tracking",
    });
    for (const r of [...kw.slice(1), ...comp]) {
      expect(r).toMatchObject({ tenant_id: "t1", origin: "suggested", status: "suggested" });
    }
  });

  it("tracks the website stem, never the workspace label, when the name is only the label", async () => {
    const { sb, inserts } = fakeSb();
    await suggestRedditSetup(sb, "t4", {
      callModel: vi.fn().mockResolvedValue({ text: "{}" }) as never,
      companyFacts: async () =>
        ({ ...facts, name: "Mohit's Workspace", nameIsWorkspaceLabel: true, website: "https://www.upcar.ai" }) as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    const kw = inserts.filter(onField("keywords")).map((i) => i.row);
    expect(kw).toHaveLength(1);
    expect(kw[0]).toMatchObject({ item: "upcar", item_type: "brand", status: "suggested" });
    expect(kw.map((r) => r.item)).not.toContain("Mohit's Workspace");
  });

  it("tracks nothing when the name is only the label and there is no website", async () => {
    const { sb, inserts } = fakeSb();
    await suggestRedditSetup(sb, "t5", {
      callModel: vi.fn().mockResolvedValue({ text: "{}" }) as never,
      companyFacts: async () =>
        ({ ...facts, name: "Mohit's Workspace", nameIsWorkspaceLabel: true, website: null }) as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    expect(inserts.filter(onField("keywords"))).toEqual([]);
  });

  it("a workspace label is not sent as the name and does not filter suggestions", async () => {
    const { sb, inserts } = fakeSb();
    const callModel = vi.fn().mockResolvedValue({
      text: JSON.stringify({ keywords: [{ term: "plumbing invoices", type: "problem" }] }),
    });
    const res = await suggestRedditSetup(sb, "t6", {
      callModel: callModel as never,
      companyFacts: async () => ({ ...facts, name: "Plumbing", nameIsWorkspaceLabel: true, website: null, competitors: [] }) as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    expect(res).toMatchObject({ ok: true, keywords_added: 1 });
    const prompt = callModel.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("name: \n");
    expect(prompt).not.toContain("Plumbing");
    expect(inserts.map((i) => i.row.item)).toEqual(["plumbing invoices"]);
  });

  it("a workspace label alone is not business context", async () => {
    const { sb } = fakeSb();
    const callModel = vi.fn();
    const res = await suggestRedditSetup(sb, "t7", {
      callModel: callModel as never,
      companyFacts: async () => ({ name: "Ravi's workspace", nameIsWorkspaceLabel: true, website: null, competitors: [], facts: {} }) as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    expect(res).toMatchObject({ ok: false, code: "context_missing" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("the tracked brand does not use up a pending suggestion slot", async () => {
    const pending = Array.from({ length: 14 }, (_, i) =>
      setting({ id: `k${i}`, field_id: "keywords", item: `idea ${i}`, item_type: "problem", origin: "suggested", status: "suggested" }),
    );
    const { sb } = fakeSb({ keywords: pending });
    const callModel = vi.fn().mockResolvedValue({ text: JSON.stringify({ keywords: [{ term: "one more idea" }] }) });
    await suggestRedditSetup(sb, "t5", {
      callModel: callModel as never,
      companyFacts: async () => facts as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    expect(callModel.mock.calls[0][0].messages[0].content).toContain("Return up to 1 keywords");
  });

  it("refuses without business context and never calls the model", async () => {
    const { sb } = fakeSb();
    const callModel = vi.fn();
    const res = await suggestRedditSetup(sb, "t2", {
      callModel: callModel as never,
      companyFacts: async () => ({ name: null, nameIsWorkspaceLabel: false, website: null, competitors: [], facts: {} }) as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    expect(res).toMatchObject({ ok: false, code: "context_missing" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("still saves the profile rows when the model call fails", async () => {
    const { sb, inserts } = fakeSb();
    const res = await suggestRedditSetup(sb, "t3", {
      callModel: vi.fn().mockRejectedValue(new Error("429")) as never,
      companyFacts: async () => facts as never,
      searchConsoleQueries: async () => [],
      geoPrompts: async () => [],
    });
    expect(res).toMatchObject({ ok: true, keywords_added: 1, competitors_added: 2 });
    expect(inserts).toHaveLength(3);
  });
});

describe("competitor look-alikes", () => {
  const deps = (callModel: unknown, f: Record<string, unknown> = {}) => ({
    callModel: callModel as never,
    companyFacts: async () => ({ ...facts, competitors: [], ...f }) as never,
    searchConsoleQueries: async () => [],
    geoPrompts: async () => [],
  });

  it("drops a Cyrillic or spaced look-alike of a tracked rival from the model and from the profile", async () => {
    const { sb, inserts } = fakeSb({ competitors: [setting({ id: "c", field_id: "competitors", item: "drivemobi" })] });
    const callModel = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        competitors: [{ name: "Driveмоbi" }, { name: "Drive Mobi" }, { name: "drive-mobi" }, { name: "DRIVÉMOBI" }, { name: "Getaround" }],
      }),
    });
    const res = await suggestRedditSetup(sb, "t-look", deps(callModel, { competitors: ["Drive.Mobi"] }));
    expect(res).toMatchObject({ ok: true, competitors_added: 1 });
    expect(inserts.filter(onField("competitors")).map((i) => i.row.item)).toEqual(["Getaround"]);
  });

  it("drops a suggestion whose domain stem is a tracked rival's, under any name", async () => {
    const { sb, inserts } = fakeSb({ competitors: [setting({ id: "c", field_id: "competitors", item: "DriveMobi" })] });
    const callModel = vi.fn().mockResolvedValue({
      text: JSON.stringify({ competitors: [{ name: "DM Rentals", domain: "https://www.drivemobi.com" }, { name: "Turo" }] }),
    });
    await suggestRedditSetup(sb, "t-stem", deps(callModel));
    expect(inserts.filter(onField("competitors")).map((i) => i.row.item)).toEqual(["Turo"]);
  });

  it("parseSuggestions keeps C++ and C# apart, and dedupes two names on one domain", () => {
    const raw = JSON.stringify({
      competitors: [
        { name: "C++" },
        { name: "C#" },
        { name: "HyreCar", domain: "hyrecar.com" },
        { name: "Hyre Car Inc", domain: "https://hyrecar.com/about" },
        { name: "hyrecar" },
      ],
    });
    expect(parseSuggestions(raw, base).competitors.map((c) => c.name)).toEqual(["C++", "C#", "HyreCar"]);
  });
});

describe("suggestRedditSetup and the rate-limit claim", () => {
  const deps = (callModel: unknown, f: Record<string, unknown> = {}) => ({
    callModel: callModel as never,
    companyFacts: async () => ({ ...facts, ...f }) as never,
    searchConsoleQueries: async () => [],
    geoPrompts: async () => [],
  });

  it("claims exactly once, before the model call", async () => {
    const order: string[] = [];
    const claim = vi.fn(async () => (order.push("claim"), true));
    const callModel = vi.fn(async () => (order.push("model"), { text: "{}" }));
    const res = await suggestRedditSetup(fakeSb().sb, "t-c1", deps(callModel), { claim });
    expect(res.ok).toBe(true);
    expect(order).toEqual(["claim", "model"]);
  });

  it("a refused claim with nothing free to save is rate_limited: no model call, no writes", async () => {
    const { sb, inserts } = fakeSb({
      keywords: [setting({ id: "b", field_id: "keywords", item: "Upcar", item_type: "brand" })],
    });
    const claim = vi.fn(async () => false);
    const callModel = vi.fn();
    const res = await suggestRedditSetup(sb, "t-c2", deps(callModel, { competitors: [] }), { claim });
    expect(res).toEqual({ ok: false, code: "rate_limited", message: "Zavi has drafted suggestions a lot this hour. Try again later." });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(callModel).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("a refused claim still saves the free profile rows but makes no model call", async () => {
    const { sb, inserts } = fakeSb();
    const claim = vi.fn(async () => false);
    const callModel = vi.fn();
    const res = await suggestRedditSetup(sb, "t-c3", deps(callModel), { claim });
    expect(res).toMatchObject({ ok: false, code: "rate_limited" });
    expect(callModel).not.toHaveBeenCalled();
    expect(inserts.map((i) => i.row.item)).toEqual(["Upcar", "Turo", "Getaround"]);
  });

  it("never claims without business context", async () => {
    const claim = vi.fn(async () => true);
    const res = await suggestRedditSetup(
      fakeSb().sb,
      "t-c4",
      deps(vi.fn(), { name: null, website: null, competitors: [], facts: {} }),
      { claim },
    );
    expect(res).toMatchObject({ ok: false, code: "context_missing" });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("brandKeywordAction", () => {
  const f = { name: "  Upcar ", nameIsWorkspaceLabel: false, website: null };
  const row = (status: "suggested" | "tracking" | "paused" | "dismissed") => [{ id: "k1", term: "upcar", status }];

  it("inserts a tracked brand row when the name is not saved", () => {
    expect(brandKeywordAction(f, [])).toEqual({
      kind: "insert",
      row: { term: "Upcar", type: "brand", status: "tracking", why: expect.any(String) },
    });
  });

  it("promotes a pending suggestion, and leaves the founder's own choices alone", () => {
    expect(brandKeywordAction(f, row("suggested"))).toEqual({ kind: "promote", id: "k1", term: "upcar" });
    expect(brandKeywordAction(f, row("tracking"))).toBeNull();
    expect(brandKeywordAction(f, row("paused"))).toBeNull();
    expect(brandKeywordAction(f, row("dismissed"))).toBeNull();
  });

  it("skips only when neither a stated name nor a website can name the brand", () => {
    expect(brandKeywordAction({ name: "Workspace", nameIsWorkspaceLabel: true, website: null }, [])).toBeNull();
    expect(brandKeywordAction({ name: null, nameIsWorkspaceLabel: false, website: null }, [])).toBeNull();
    expect(brandKeywordAction({ name: "x", nameIsWorkspaceLabel: false, website: null }, [])).toBeNull();
    expect(brandKeywordAction({ name: "Upcar", nameIsWorkspaceLabel: true, website: "not a url" }, [])).toBeNull();
  });

  it("falls back to the website stem, but only as a SUGGESTION a human must accept", () => {
    expect(
      brandKeywordAction({ name: "UpcarAI", nameIsWorkspaceLabel: true, website: "https://www.upcar.ai" }, []),
    ).toEqual({
      kind: "insert",
      row: { term: "upcar", type: "brand", status: "suggested", why: expect.any(String) },
    });
  });

  it("a stated name is tracked outright — the two sources are not equal evidence", () => {
    expect(
      brandKeywordAction({ name: "Upcar", nameIsWorkspaceLabel: false, website: null }, []),
    ).toMatchObject({ row: { status: "tracking" } });
  });

  it("never auto-promotes a pending row on the strength of a guessed website stem", () => {
    const pending = [{ id: "k1", term: "upcar", status: "suggested" as const }];
    expect(
      brandKeywordAction({ name: "UpcarAI", nameIsWorkspaceLabel: true, website: "https://upcar.ai" }, pending),
    ).toBeNull();
    expect(
      brandKeywordAction({ name: "Upcar", nameIsWorkspaceLabel: false, website: null }, pending),
    ).toEqual({ kind: "promote", id: "k1", term: "upcar" });
  });

  it("prefers a stated name over the website, and never tracks the workspace label itself", () => {
    const stated = brandKeywordAction(
      { name: "Upcar", nameIsWorkspaceLabel: false, website: "https://rental-platform.example.com" },
      [],
    );
    expect(stated).toEqual({
      kind: "insert",
      row: { term: "Upcar", type: "brand", status: "tracking", why: expect.any(String) },
    });
    const labelled = brandKeywordAction(
      { name: "Mohit's Workspace", nameIsWorkspaceLabel: true, website: "https://www.upcar.ai" },
      [],
    );
    expect(labelled).toMatchObject({ row: { term: "upcar" } });
  });
});

describe("brand mention backfill on seed", () => {
  const f5 = { name: "Upcar", nameIsWorkspaceLabel: false, website: "https://upcar.ai" };
  const stub = (rows: unknown[]) =>
    ({
      from() {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          update: () => q,
          insert: () => q,
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
        };
        return q;
      },
    }) as never;

  it("backfills exactly once when the brand row is first inserted", async () => {
    const backfillBrand = vi.fn().mockResolvedValue(3);
    const r = await ensureBrandKeyword(stub([]), "t1", { companyFacts: async () => f5 as never, backfillBrand });
    expect(r).toBe("inserted");
    expect(backfillBrand).toHaveBeenCalledTimes(1);
    expect(backfillBrand.mock.calls[0][2]).toBe("Upcar");
  });

  it("backfills with the STORED term when a suggestion is promoted, not the row id", async () => {
    const backfillBrand = vi.fn().mockResolvedValue(0);
    const r = await ensureBrandKeyword(stub([{ id: "k1", item: "UPCAR", status: "suggested" }]), "t1", {
      companyFacts: async () => f5 as never,
      backfillBrand,
    });
    expect(r).toBe("promoted");
    expect(backfillBrand.mock.calls[0][2]).toBe("UPCAR");
  });

  it("does not backfill a website-derived row, because nothing tracks it yet", async () => {
    const backfillBrand = vi.fn();
    const r = await ensureBrandKeyword(stub([]), "t1", {
      companyFacts: async () =>
        ({ ...f5, name: "Mohit's Workspace", nameIsWorkspaceLabel: true }) as never,
      backfillBrand,
    });
    expect(r).toBe("inserted");
    expect(backfillBrand).not.toHaveBeenCalled();
  });

  it("never backfills when the brand row is already tracked — every panel load hits this", async () => {
    const backfillBrand = vi.fn();
    const r = await ensureBrandKeyword(stub([{ id: "k1", item: "upcar", status: "tracking" }]), "t1", {
      companyFacts: async () => f5 as never,
      backfillBrand,
    });
    expect(r).toBe("unchanged");
    expect(backfillBrand).not.toHaveBeenCalled();
  });
});

describe("brandTermOf", () => {
  it("reduces a website to its registrable label, across hosts and multi-part TLDs", () => {
    const cases: Array<[string, string]> = [
      ["https://www.upcar.ai", "upcar"],
      ["http://upcar.ai/pricing?ref=x", "upcar"],
      ["UPCAR.AI", "upcar"],
      ["https://shop.example.co.uk", "example"],
      ["https://www.example.co.uk", "example"],
    ];
    for (const [website, term] of cases) {
      expect(brandTermOf({ name: null, nameIsWorkspaceLabel: false, website })).toMatchObject({
        term,
        from: "website",
      });
    }
  });

  it("refuses a website that cannot name a brand", () => {
    for (const website of [null, "", "localhost", "https://", "x.y", "http://192.168.0.1"]) {
      expect(brandTermOf({ name: null, nameIsWorkspaceLabel: false, website })).toBeNull();
    }
  });
});

describe("ensureBrandKeyword", () => {
  function sbWith(rows: unknown[], opts: { insertError?: { code?: string; message: string }; readError?: boolean } = {}) {
    const ops: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }> = [];
    const sb = {
      from(table: string) {
        const rec = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, unknown]> };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (rec.filters.push([c, v]), q),
          update: (p: unknown) => ((rec.op = "update"), (rec.payload = p), q),
          insert: (p: unknown) => ((rec.op = "insert"), (rec.payload = p), q),
          then: (res: (v: unknown) => unknown) => {
            ops.push(rec);
            if (rec.op === "select") return Promise.resolve(opts.readError ? { data: null, error: { message: "down" } } : { data: rows, error: null }).then(res);
            if (rec.op === "insert") return Promise.resolve({ error: opts.insertError ?? null }).then(res);
            return Promise.resolve({ error: null }).then(res);
          },
        };
        return q;
      },
    };
    return { sb: sb as never, ops };
  }
  const companyFacts = async () => facts as never;

  it("inserts the brand as tracked, tenant-scoped", async () => {
    const { sb, ops } = sbWith([]);
    expect(await ensureBrandKeyword(sb, "t1", { companyFacts })).toBe("inserted");
    expect(ops[0].filters).toEqual([["tenant_id", "t1"], ["channel_slug", "reddit_organic"], ["field_id", "keywords"]]);
    expect(ops[1]).toMatchObject({
      table: "channel_settings",
      op: "insert",
      payload: {
        tenant_id: "t1",
        channel_slug: "reddit_organic",
        field_id: "keywords",
        item: "Upcar",
        item_type: "brand",
        status: "tracking",
        origin: "suggested",
      },
    });
  });

  it("promotes a pending suggestion only while it is still pending", async () => {
    const { sb, ops } = sbWith([{ id: "k1", item: "UPCAR", status: "suggested" }]);
    expect(await ensureBrandKeyword(sb, "t1", { companyFacts })).toBe("promoted");
    expect(ops[1]).toMatchObject({ op: "update", payload: { status: "tracking", item_type: "brand" } });
    expect(ops[1].filters).toEqual([
      ["tenant_id", "t1"],
      ["channel_slug", "reddit_organic"],
      ["field_id", "keywords"],
      ["id", "k1"],
      ["status", "suggested"],
    ]);
  });

  it("never resurrects a brand the founder dismissed (deleted) or paused", async () => {
    for (const status of ["dismissed", "paused"]) {
      const { sb, ops } = sbWith([{ id: "k1", item: "Upcar", status }]);
      expect(await ensureBrandKeyword(sb, "t1", { companyFacts })).toBe("unchanged");
      expect(ops.filter((o) => o.op !== "select")).toEqual([]);
    }
  });

  it("is idempotent and never throws", async () => {
    expect(await ensureBrandKeyword(sbWith([{ id: "k1", item: "Upcar", status: "tracking" }]).sb, "t1", { companyFacts })).toBe("unchanged");
    expect(await ensureBrandKeyword(sbWith([], { insertError: { code: "23505", message: "dup" } }).sb, "t1", { companyFacts })).toBe("unchanged");
    expect(
      await ensureBrandKeyword(sbWith([]).sb, "t1", { companyFacts: async () => ({ ...facts, nameIsWorkspaceLabel: true, website: null }) as never }),
    ).toBe("skipped");
    expect(
      await ensureBrandKeyword(sbWith([]).sb, "t1", { companyFacts: async () => ({ ...facts, name: "Mohit's Workspace", nameIsWorkspaceLabel: true }) as never }),
    ).toBe("inserted");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ensureBrandKeyword(sbWith([], { readError: true }).sb, "t1", { companyFacts })).toBe("error");
    expect(await ensureBrandKeyword(sbWith([]).sb, "t1", { companyFacts: async () => { throw new Error("x"); } })).toBe("error");
    spy.mockRestore();
  });
});
