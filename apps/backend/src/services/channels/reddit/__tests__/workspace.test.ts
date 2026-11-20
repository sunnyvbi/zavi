import { describe, expect, it } from "vitest";
import {
  communityCreateSchema,
  communityUpdateSchema,
  competitorCreateSchema,
  createKeyword,
  deleteRow,
  domainStem,
  inferKeywordType,
  keywordCreateSchema,
  keywordUpdateSchema,
  normalizeDomain,
  mergedTrackedCompetitors,
  seedCompetitorsFromRecord,
  normalizeSubreddit,
  workspaceRunContext,
} from "../workspace";

describe("normalizeSubreddit", () => {
  it.each([
    ["smallbusiness", "smallbusiness"],
    ["r/SmallBusiness", "SmallBusiness"],
    ["/r/carsharing/", "carsharing"],
    ["https://www.reddit.com/r/Frugal/comments/abc/x/", "Frugal"],
  ])("%s → %s", (input, out) => {
    expect(normalizeSubreddit(input)).toBe(out);
  });

  it.each(["a", "has space", "r/../api", "x".repeat(22), ""])("rejects %j", (input) => {
    expect(normalizeSubreddit(input)).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("strips scheme, www and path", () => {
    expect(normalizeDomain("https://www.HubSpot.com/pricing?x=1")).toBe("hubspot.com");
  });
  it("rejects non-domains and empties", () => {
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("  ")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });
});

describe("schemas", () => {
  it("collapses whitespace in keywords and leaves a missing type for inference", () => {
    expect(keywordCreateSchema.parse({ term: "  rent   out my car " })).toEqual({ term: "rent out my car" });
    expect(keywordCreateSchema.parse({ term: "Upcar", type: "brand" })).toEqual({ term: "Upcar", type: "brand" });
    expect(keywordCreateSchema.safeParse({ term: "x" }).success).toBe(false);
    expect(keywordCreateSchema.safeParse({ term: "ok term", type: "nope" }).success).toBe(false);
  });

  it("PATCH can still change a keyword's type", () => {
    expect(keywordUpdateSchema.parse({ type: "competitor" })).toEqual({ type: "competitor" });
  });

  it("requires something to update", () => {
    expect(keywordUpdateSchema.safeParse({}).success).toBe(false);
    expect(communityUpdateSchema.safeParse({}).success).toBe(false);
    expect(communityUpdateSchema.parse({ rules_verdict: null })).toEqual({ rules_verdict: null });
  });

  it("rejects a verdict Zavi does not define", () => {
    expect(communityUpdateSchema.safeParse({ rules_verdict: "maybe" }).success).toBe(false);
  });

  it("normalizes competitor domains and community names", () => {
    expect(competitorCreateSchema.parse({ name: "Turo", domain: "https://turo.com/" })).toEqual({
      name: "Turo",
      domain: "turo.com",
    });
    expect(competitorCreateSchema.safeParse({ name: "Turo", domain: "nope" }).success).toBe(false);
    expect(communityCreateSchema.parse({ name: "r/carsharing" })).toEqual({ name: "carsharing" });
    expect(competitorCreateSchema.parse({ name: "Turo" })).toEqual({ name: "Turo", domain: null });
    expect(communityCreateSchema.safeParse({ name: "bad name!" }).success).toBe(false);
  });
});

describe("workspaceRunContext", () => {
  it("passes only tracked terms and selected communities, keeping banned verdicts", () => {
    const ctx = workspaceRunContext({
      keywords: [
        { id: "1", term: "a b", type: "problem", origin: "custom", status: "tracking", why: null, created_at: "" },
        { id: "2", term: "c d", type: "problem", origin: "custom", status: "dismissed", why: null, created_at: "" },
        { id: "8", term: "e f", type: "problem", origin: "suggested", status: "suggested", why: "x", created_at: "" },
      ],
      competitors: [
        { id: "3", name: "Turo", domain: "turo.com", origin: "custom", status: "tracking", why: null, created_at: "" },
        { id: "4", name: "Old", domain: null, origin: "custom", status: "paused", why: null, created_at: "" },
        { id: "7", name: "Getaround", domain: null, origin: "suggested", status: "suggested", why: "x", created_at: "" },
      ],
      communities: [
        { id: "5", name: "smallbusiness", selected: true, rules_verdict: "banned", rules_verdict_at: "x", created_at: "" },
        { id: "6", name: "Frugal", selected: false, rules_verdict: null, rules_verdict_at: null, created_at: "" },
      ],
    });
    expect(ctx.tracked_keywords).toEqual([{ term: "a b", type: "problem" }]);
    expect(ctx.tracked_competitors).toEqual([{ name: "Turo", domain: "turo.com" }]);
    expect(ctx.selected_communities).toEqual([{ name: "smallbusiness", selected: true, rules_verdict: "banned" }]);
  });
});

describe("competitor typed as a domain", () => {
  it.each([
    ["hubspot.com", "Hubspot", "hubspot.com"],
    ["HubSpot.com", "Hubspot", "hubspot.com"],
    ["https://www.hubspot.com/pricing", "Hubspot", "hubspot.com"],
    ["app.pipedrive.com", "Pipedrive", "app.pipedrive.com"],
    ["monzo.co.uk", "Monzo", "monzo.co.uk"],
  ])("%s → %s + %s", (name, outName, outDomain) => {
    expect(competitorCreateSchema.parse({ name })).toEqual({ name: outName, domain: outDomain });
  });

  it("leaves a name alone when a domain is given or it is not a domain", () => {
    expect(competitorCreateSchema.parse({ name: "hubspot.com", domain: "hubspot.io" })).toEqual({ name: "hubspot.com", domain: "hubspot.io" });
    expect(competitorCreateSchema.parse({ name: "Zoho CRM" })).toEqual({ name: "Zoho CRM", domain: null });
    expect(competitorCreateSchema.parse({ name: "Mr. Cooper" })).toEqual({ name: "Mr. Cooper", domain: null });
  });

  it("domainStem takes the registrable label", () => {
    expect(domainStem("hubspot.com")).toBe("hubspot");
    expect(domainStem("app.hubspot.com")).toBe("hubspot");
    expect(domainStem("foo.co.uk")).toBe("foo");
  });
});

describe("inferKeywordType", () => {
  const ctx = {
    companyName: "Upcar",
    website: "https://www.upcar.ai/",
    competitors: [
      { name: "Turo", domain: "turo.com" },
      { name: "Getaround", domain: null },
    ],
  };
  it.each([
    ["Upcar", "brand"],
    ["  UPCAR ", "brand"],
    ["upcar.ai", "brand"],
    ["turo", "competitor"],
    ["turo.com", "competitor"],
    ["Getaround", "competitor"],
    ["upcar pricing", "problem"],
    ["rent out my car", "problem"],
  ])("%j → %s", (term, type) => {
    expect(inferKeywordType(term, ctx)).toBe(type);
  });

  it("is problem with no context", () => {
    expect(inferKeywordType("Upcar", { companyName: null, website: null, competitors: [] })).toBe("problem");
  });
});

describe("createKeyword type inference", () => {
  type Op = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> };
  function fakeSb(seed: Record<string, unknown[]>) {
    const ops: Op[] = [];
    const ci = (v: unknown) => String(v).toLowerCase();
    const matches = (row: Record<string, unknown>, [kind, col, val]: [string, string, unknown]) => {
      if (kind === "eq") return row[col] === val;
      if (kind === "in") return (val as unknown[]).includes(row[col]);
      return ci(row[col]) === ci(String(val).replace(/\\(.)/g, "$1"));
    };
    const sb = {
      from(table: string) {
        const rec: Op = { table, op: "select", filters: [] };
        const done = () => {
          ops.push(rec);
          if (rec.op === "select") {
            const rows = (seed[table] ?? []) as Array<Record<string, unknown>>;
            return { data: rows.filter((r) => rec.filters.every((f) => matches(r, f))), error: null };
          }
          const p = (rec.payload ?? {}) as Record<string, unknown>;
          return { data: { id: "new", ...p }, error: null };
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (rec.filters.push(["eq", c, v]), q),
          in: (c: string, v: unknown) => (rec.filters.push(["in", c, v]), q),
          ilike: (c: string, v: unknown) => (rec.filters.push(["ilike", c, v]), q),
          limit: () => q,
          insert: (p: unknown) => ((rec.op = "insert"), (rec.payload = p), q),
          update: (p: unknown) => ((rec.op = "update"), (rec.payload = p), q),
          single: () => Promise.resolve(done()),
          maybeSingle: () => Promise.resolve(done()),
          then: (res: (v: unknown) => unknown) => Promise.resolve(done()).then(res),
        };
        return q;
      },
    };
    return { sb: sb as never, ops };
  }
  const companyFacts = async () =>
    ({ name: "Upcar", nameIsWorkspaceLabel: false, website: "upcar.ai", competitors: [], facts: {} }) as never;

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
  const readsCompetitors = (o: Op) =>
    o.filters.some(([kind, col, val]) => kind === "eq" && col === "field_id" && val === "competitors");

  it("infers brand and competitor for new rows, reading tracked + suggested competitors for this tenant", async () => {
    const a = fakeSb({
      channel_settings: [setting({ id: "c1", field_id: "competitors", item: "Turo", detail: null })],
    });
    const brand = await createKeyword(a.sb, "t1", "u1", { term: "upcar" }, { companyFacts });
    expect(brand.type).toBe("brand");
    const comp = await createKeyword(a.sb, "t1", "u1", { term: "Turo" }, { companyFacts });
    expect(comp.type).toBe("competitor");
    const other = await createKeyword(a.sb, "t1", "u1", { term: "car hire tips" }, { companyFacts });
    expect(other.type).toBe("problem");
    const read = a.ops.find(readsCompetitors)!;
    expect(read.table).toBe("channel_settings");
    expect(read.filters).toEqual([
      ["eq", "tenant_id", "t1"],
      ["eq", "channel_slug", "reddit_organic"],
      ["eq", "field_id", "competitors"],
      ["in", "status", ["tracking", "suggested"]],
    ]);
    expect(a.ops.filter((o) => o.op === "insert")).toHaveLength(3);
  });

  it("an explicit type wins, and a facts failure only loses the brand match", async () => {
    const a = fakeSb({ channel_settings: [] });
    expect((await createKeyword(a.sb, "t1", "u1", { term: "upcar", type: "industry" }, { companyFacts })).type).toBe("industry");
    expect(a.ops.some(readsCompetitors)).toBe(false);
    const failing = async () => {
      throw new Error("facts down");
    };
    expect((await createKeyword(a.sb, "t1", "u1", { term: "upcar" }, { companyFacts: failing })).type).toBe("problem");
  });

  it("promoting a suggestion without a type keeps the suggestion's type", async () => {
    const a = fakeSb({
      channel_settings: [
        setting({ id: "k1", field_id: "keywords", item: "Turo alternative", item_type: "comparison", status: "suggested" }),
      ],
    });
    await createKeyword(a.sb, "t1", "u1", { term: "turo alternative" }, { companyFacts });
    const upd = a.ops.find((o) => o.op === "update")!;
    expect(upd.payload).not.toHaveProperty("item_type");
    expect(upd.payload).toMatchObject({ status: "tracking" });
    expect(a.ops.some((o) => o.op === "insert")).toBe(false);
  });
});

describe("workspaceRunContext keeps bans through a pause", () => {
  it("still sends a banned community after the founder pauses it", () => {
    const ctx = workspaceRunContext({
      keywords: [],
      competitors: [],
      communities: [
        { id: "a", name: "smallbusiness", selected: false, rules_verdict: "banned", rules_verdict_at: "x", created_at: "" },
        { id: "b", name: "Frugal", selected: false, rules_verdict: "unclear", rules_verdict_at: "x", created_at: "" },
      ],
    } as never);
    expect(ctx.selected_communities).toEqual([{ name: "smallbusiness", selected: false, rules_verdict: "banned" }]);
  });
});

describe("communityCreateSchema with a verdict", () => {
  it("accepts a verdict and selection in the create request", () => {
    expect(communityCreateSchema.parse({ name: "r/x_y", rules_verdict: "banned", selected: false })).toEqual({
      name: "x_y",
      rules_verdict: "banned",
      selected: false,
    });
    expect(communityCreateSchema.safeParse({ name: "x_y", rules_verdict: "maybe" }).success).toBe(false);
  });
});

describe("createKeyword with a workspace-label name", () => {
  it("does not type the label as brand", async () => {
    const ops: Array<{ op: string; payload?: unknown }> = [];
    const sb = {
      from() {
        const rec = { op: "select", payload: undefined as unknown };
        const done = () => (ops.push(rec), rec.op === "select" ? { data: [], error: null } : { data: { id: "n", ...(rec.payload as object) }, error: null });
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          in: () => q,
          ilike: () => q,
          limit: () => q,
          insert: (p: unknown) => ((rec.op = "insert"), (rec.payload = p), q),
          single: () => Promise.resolve(done()),
          then: (res: (v: unknown) => unknown) => Promise.resolve(done()).then(res),
        };
        return q;
      },
    };
    const companyFacts = async () =>
      ({ name: "Plumbing", nameIsWorkspaceLabel: true, website: null, competitors: [], facts: {} }) as never;
    const row = await createKeyword(sb as never, "t1", "u1", { term: "plumbing" }, { companyFacts });
    expect(row.type).toBe("problem");
  });
});

describe("deleteRow", () => {
  type Op = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };
  function fakeSb(brandIds: string[], existing: string[]) {
    const ops: Op[] = [];
    const sb = {
      from(table: string) {
        const rec: Op = { table, op: "select", filters: [] };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (rec.filters.push([c, v]), q),
          update: (p: unknown) => ((rec.op = "update"), (rec.payload = p), q),
          delete: () => ((rec.op = "delete"), q),
          then: (res: (v: unknown) => unknown) => {
            ops.push(rec);
            const id = rec.filters.find(([c]) => c === "id")?.[1] as string;
            const f = Object.fromEntries(rec.filters);
            let hit = false;
            if (rec.op === "update") hit = brandIds.includes(id) && f.item_type === "brand";
            if (rec.op === "delete") hit = existing.includes(id);
            return Promise.resolve({ data: hit ? [{ id }] : [], error: null }).then(res);
          },
        };
        return q;
      },
    };
    return { sb: sb as never, ops };
  }

  const scoped = (id: string, field: string): Array<[string, unknown]> => [
    ["tenant_id", "t1"],
    ["channel_slug", "reddit_organic"],
    ["field_id", field],
    ["id", id],
  ];

  it("dismisses a brand keyword instead of deleting it, whoever added it (ensureBrandKeyword would re-insert it)", async () => {
    const { sb, ops } = fakeSb(["b1"], ["b1"]);
    expect(await deleteRow(sb, "t1", "keywords", "b1")).toBe(true);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ table: "channel_settings", op: "update", payload: { status: "dismissed" } });
    expect(ops[0].filters).toEqual([...scoped("b1", "keywords"), ["item_type", "brand"]]);
  });

  it("deletes any other keyword, tenant- AND field-scoped, and 404s a missing one", async () => {
    const { sb, ops } = fakeSb([], ["k1"]);
    expect(await deleteRow(sb, "t1", "keywords", "k1")).toBe(true);
    expect(ops.map((o) => o.op)).toEqual(["update", "delete"]);
    expect(ops[1].filters).toEqual(scoped("k1", "keywords"));
    expect(await deleteRow(sb, "t1", "keywords", "nope")).toBe(false);
  });

  it("competitors and communities are deleted without the brand check", async () => {
    const { sb, ops } = fakeSb([], ["c1"]);
    expect(await deleteRow(sb, "t1", "competitors", "c1")).toBe(true);
    expect(ops.map((o) => o.op)).toEqual(["delete"]);
    expect(ops[0].filters).toEqual(scoped("c1", "competitors"));
  });
});

describe("mergedTrackedCompetitors", () => {
  const ws = (competitors: Parameters<typeof mergedTrackedCompetitors>[0]["competitors"]) => ({
    keywords: [],
    competitors,
    communities: [],
  });

  it("returns the tracked rows when the record is empty", () => {
    expect(
      mergedTrackedCompetitors(
        ws([
          { id: "1", name: "Turo", domain: "turo.com", origin: "custom", status: "tracking", why: null, created_at: "" },
          { id: "2", name: "Old", domain: null, origin: "custom", status: "paused", why: null, created_at: "" },
        ]),
      ),
    ).toEqual([{ name: "Turo", domain: "turo.com" }]);
  });

  it("adds a record name that has no row", () => {
    expect(mergedTrackedCompetitors(ws([]), ["Getaround"])).toEqual([
      { name: "Getaround", domain: null },
    ]);
  });

  it("keeps the row's domain instead of duplicating the record's bare name", () => {
    const out = mergedTrackedCompetitors(
      ws([
        { id: "1", name: "Turo", domain: "turo.com", origin: "custom", status: "tracking", why: null, created_at: "" },
      ]),
      ["turo", "Turo"],
    );
    expect(out).toEqual([{ name: "Turo", domain: "turo.com" }]);
  });

  it("does not resurrect a competitor the founder paused or dismissed here", () => {
    const paused = mergedTrackedCompetitors(
      ws([
        { id: "1", name: "Turo", domain: null, origin: "custom", status: "paused", why: null, created_at: "" },
      ]),
      ["Turo"],
    );
    expect(paused).toEqual([]);

    const dismissed = mergedTrackedCompetitors(
      ws([
        { id: "1", name: "Turo", domain: null, origin: "custom", status: "dismissed", why: null, created_at: "" },
      ]),
      ["Turo"],
    );
    expect(dismissed).toEqual([]);
  });

  it("does not let an unaccepted suggestion through on the record's back", () => {
    expect(
      mergedTrackedCompetitors(
        ws([
          { id: "1", name: "Turo", domain: null, origin: "suggested", status: "suggested", why: "x", created_at: "" },
        ]),
        ["Turo"],
      ),
    ).toEqual([]);
  });

  it("dedupes record names against each other, ignoring case and padding", () => {
    expect(mergedTrackedCompetitors(ws([]), ["Turo", "  turo  ", "TURO"])).toEqual([
      { name: "Turo", domain: null },
    ]);
  });

  it("skips blank record entries", () => {
    expect(mergedTrackedCompetitors(ws([]), ["", "   ", "Turo"])).toEqual([
      { name: "Turo", domain: null },
    ]);
  });
});

describe("workspaceRunContext record union", () => {
  it("passes the record's rivals to the run even with no row for them", () => {
    const ctx = workspaceRunContext(
      {
        keywords: [],
        competitors: [
          { id: "1", name: "Turo", domain: "turo.com", origin: "custom", status: "tracking", why: null, created_at: "" },
        ],
        communities: [],
      },
      ["Getaround"],
    );
    expect(ctx.tracked_competitors).toEqual([
      { name: "Turo", domain: "turo.com" },
      { name: "Getaround", domain: null },
    ]);
  });
});

describe("seedCompetitorsFromRecord", () => {
  type Op = { table: string; op: string; payload?: Record<string, unknown>; filters: Array<[string, unknown]> };
  function fakeSb(rows: Array<{ id: string; item: string; status: string }>) {
    const ops: Op[] = [];
    const sb = {
      from(table: string) {
        const rec: Op = { table, op: "select", filters: [] };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (rec.filters.push([c, v]), q),
          insert: (payload: Record<string, unknown>) => ((rec.op = "insert"), (rec.payload = payload), q),
          update: (payload: Record<string, unknown>) => ((rec.op = "update"), (rec.payload = payload), q),
          then: (res: (v: unknown) => unknown) => {
            ops.push(rec);
            if (rec.op === "select") return Promise.resolve({ data: rows, error: null }).then(res);
            return Promise.resolve({ data: null, error: null }).then(res);
          },
        };
        return q;
      },
    };
    return { sb: sb as never, ops };
  }
  const facts = (competitors: string[]) => async () =>
    ({ name: null, nameIsWorkspaceLabel: false, website: null, competitors, facts: {} }) as never;

  it("tracks at most three competitors by default and leaves the rest as suggestions", async () => {
    const { sb, ops } = fakeSb([]);
    const names = ["Turo", "Getaround", "Zipcar", "Hertz", "Avis"];
    expect(await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts(names) })).toBe(5);
    const inserts = ops.filter((o) => o.op === "insert");
    expect(inserts.map((o) => (o.payload as { item: string; status: string }).status)).toEqual([
      "tracking",
      "tracking",
      "tracking",
      "suggested",
      "suggested",
    ]);
  });

  it("does not add a fourth tracked competitor when three are already tracking", async () => {
    const { sb, ops } = fakeSb([
      { id: "a", item: "Turo", status: "tracking" },
      { id: "b", item: "Getaround", status: "tracking" },
      { id: "c", item: "Zipcar", status: "tracking" },
      { id: "d", item: "Hertz", status: "suggested" },
    ]);
    await seedCompetitorsFromRecord(sb, "t1", {
      companyFacts: facts(["Turo", "Getaround", "Zipcar", "Hertz"]),
    });
    expect(ops.filter((o) => o.op === "update")).toHaveLength(0);
  });

  it("fills the remaining budget when only one competitor is tracked", async () => {
    const { sb, ops } = fakeSb([{ id: "a", item: "Turo", status: "tracking" }]);
    await seedCompetitorsFromRecord(sb, "t1", {
      companyFacts: facts(["Turo", "Getaround", "Zipcar", "Hertz"]),
    });
    const inserted = ops
      .filter((o) => o.op === "insert")
      .map((o) => o.payload as { item: string; status: string });
    expect(inserted).toEqual([
      { tenant_id: "t1", channel_slug: "reddit_organic", field_id: "competitors", item: "Getaround", status: "tracking", origin: "custom" },
      { tenant_id: "t1", channel_slug: "reddit_organic", field_id: "competitors", item: "Zipcar", status: "tracking", origin: "custom" },
      { tenant_id: "t1", channel_slug: "reddit_organic", field_id: "competitors", item: "Hertz", status: "suggested", origin: "custom" },
    ]);
  });

  it("creates a tracking row for a record name this channel has never seen", async () => {
    const { sb, ops } = fakeSb([]);
    expect(await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts(["Turo"]) })).toBe(1);
    const ins = ops.find((o) => o.op === "insert");
    expect(ins?.table).toBe("channel_settings");
    expect(ins?.payload).toMatchObject({
      tenant_id: "t1",
      channel_slug: "reddit_organic",
      field_id: "competitors",
      item: "Turo",
      origin: "custom",
      status: "tracking",
    });
  });

  it("reads only this channel's competitor field, never another channel's", async () => {
    const { sb, ops } = fakeSb([]);
    await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts(["Turo"]) });
    const sel = ops.find((o) => o.op === "select");
    expect(sel?.table).toBe("channel_settings");
    expect(sel?.filters).toEqual([
      ["tenant_id", "t1"],
      ["channel_slug", "reddit_organic"],
      ["field_id", "competitors"],
    ]);
  });

  it("promotes an unaccepted suggestion, because the record already confirmed that name", async () => {
    const { sb, ops } = fakeSb([{ id: "c1", item: "Turo", status: "suggested" }]);
    expect(await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts(["Turo"]) })).toBe(1);
    const upd = ops.find((o) => o.op === "update");
    expect(upd?.table).toBe("channel_settings");
    expect(upd?.payload).toMatchObject({ status: "tracking" });
    expect(upd?.filters).toEqual([
      ["tenant_id", "t1"],
      ["channel_slug", "reddit_organic"],
      ["field_id", "competitors"],
      ["id", "c1"],
    ]);
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("never overrides a pause or a dismissal — those are this channel's own answer", async () => {
    for (const status of ["paused", "dismissed"]) {
      const { sb, ops } = fakeSb([{ id: "c1", item: "Turo", status }]);
      expect(await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts(["Turo"]) })).toBe(0);
      expect(ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
    }
  });

  it("leaves an already-tracking row alone and matches ignoring case and padding", async () => {
    const { sb, ops } = fakeSb([{ id: "c1", item: "turo", status: "tracking" }]);
    expect(await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts(["  Turo  "]) })).toBe(0);
    expect(ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
  });

  it("does nothing when the record is empty", async () => {
    const { sb, ops } = fakeSb([{ id: "c1", item: "Turo", status: "tracking" }]);
    expect(await seedCompetitorsFromRecord(sb, "t1", { companyFacts: facts([]) })).toBe(0);
    expect(ops).toHaveLength(0);
  });
});
