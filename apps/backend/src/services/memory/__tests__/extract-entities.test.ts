
import { describe, it, expect, vi } from "vitest";
import {
  parseTypedGraph,
  extractEntitiesAndRelations,
  TYPED_ENTITY_KINDS,
  TYPED_EXTRACT_MODEL,
  type TypedExtractClient,
} from "../extract";
import { MODELS } from "@/services/llm/models";

describe("TYPED_EXTRACT_MODEL pin", () => {
  it("defaults to Haiku (not Opus 4.7 / Sonnet)", () => {
    expect(TYPED_EXTRACT_MODEL).toBe(MODELS.anthropic.haiku);
    expect(TYPED_EXTRACT_MODEL).not.toBe("claude-opus-4-7");
  });
});

function clientReturning(text: string): TypedExtractClient {
  return {
    messages: {
      create: vi.fn(async () => ({ content: [{ type: "text", text }] })),
    },
  };
}

const TENANT = "00000000-0000-0000-0000-000000000001";

describe("parseTypedGraph (pure)", () => {
  it("parses a well-formed graph with typed entities + endpoint-validated relations", () => {
    const raw = JSON.stringify({
      entities: [
        { canonical: "Acme Corp", type: "company" },
        { canonical: "Jane Doe", type: "person" },
      ],
      relations: [{ from: "Jane Doe", to: "Acme Corp", type: "works_at" }],
    });
    const g = parseTypedGraph(raw);
    expect(g.entities).toHaveLength(2);
    expect(g.entities.map((e) => e.type).sort()).toEqual(["company", "person"]);
    expect(g.relations).toEqual([
      { from: "Jane Doe", to: "Acme Corp", type: "works_at" },
    ]);
  });

  it("tolerates ```json fences the model sometimes emits", () => {
    const raw =
      '```json\n{"entities":[{"canonical":"Stripe","type":"company"}],"relations":[]}\n```';
    const g = parseTypedGraph(raw);
    expect(g.entities).toEqual([{ canonical: "Stripe", type: "company" }]);
    expect(g.relations).toEqual([]);
  });

  it("only emits the three typed kinds; drops generic/unknown entity types", () => {
    const raw = JSON.stringify({
      entities: [
        { canonical: "ravi@upcar.ai", type: "email" },
        { canonical: "$500", type: "amount" },
        { canonical: "Acme Corp", type: "company" },
      ],
      relations: [],
    });
    const g = parseTypedGraph(raw);
    expect(g.entities).toEqual([{ canonical: "Acme Corp", type: "company" }]);
    for (const e of g.entities) {
      expect(TYPED_ENTITY_KINDS as readonly string[]).toContain(e.type);
    }
  });

  it("drops relations whose endpoints are not listed entities (no dangling edges)", () => {
    const raw = JSON.stringify({
      entities: [{ canonical: "Acme Corp", type: "company" }],
      relations: [
        { from: "Jane Doe", to: "Acme Corp", type: "works_at" },
        { from: "Acme Corp", to: "Acme Corp", type: "owns" },
      ],
    });
    const g = parseTypedGraph(raw);
    expect(g.entities).toHaveLength(1);
    expect(g.relations).toHaveLength(0);
  });

  it("dedupes entities case-insensitively and relations by (from,to,type)", () => {
    const raw = JSON.stringify({
      entities: [
        { canonical: "Acme Corp", type: "company" },
        { canonical: "acme corp", type: "company" },
        { canonical: "Jane Doe", type: "person" },
      ],
      relations: [
        { from: "Jane Doe", to: "Acme Corp", type: "works_at" },
        { from: "jane doe", to: "acme corp", type: "works_at" },
      ],
    });
    const g = parseTypedGraph(raw);
    expect(g.entities).toHaveLength(2);
    expect(g.relations).toHaveLength(1);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["not json", "the model refused and wrote prose instead"],
    ["truncated json", '{"entities":[{"canonical":"Acme'],
    ["json array not object", "[1,2,3]"],
    ["json null", "null"],
    ["json number", "42"],
    ["missing keys", "{}"],
    ["entities not array", '{"entities":"nope","relations":"nope"}'],
  ])("returns empty graph for malformed input: %s", (_label, raw) => {
    const g = parseTypedGraph(raw as string);
    expect(g).toEqual({ entities: [], relations: [] });
  });

  it("skips malformed members but keeps the valid ones", () => {
    const raw = JSON.stringify({
      entities: [
        { canonical: "", type: "person" },
        { canonical: "X", type: "company" },
        { type: "person" },
        { canonical: "Acme Corp", type: "company" },
        { canonical: "Jane Doe", type: "wizard" },
      ],
      relations: [{ from: "Acme Corp" }],
    });
    const g = parseTypedGraph(raw);
    expect(g.entities).toEqual([{ canonical: "Acme Corp", type: "company" }]);
    expect(g.relations).toHaveLength(0);
  });
});

describe("extractEntitiesAndRelations (Opus wrapper)", () => {
  it("returns the parsed typed graph from a well-formed model response", async () => {
    const client = clientReturning(
      JSON.stringify({
        entities: [
          { canonical: "Acme Corp", type: "company" },
          { canonical: "Jane Doe", type: "person" },
        ],
        relations: [{ from: "Jane Doe", to: "Acme Corp", type: "signed" }],
      }),
    );
    const g = await extractEntitiesAndRelations(
      "Acme Corp signed Jane Doe as VP.",
      TENANT,
      { client, model: "test-model" },
    );
    expect(g.entities).toHaveLength(2);
    expect(g.relations).toEqual([
      { from: "Jane Doe", to: "Acme Corp", type: "signed" },
    ]);
    expect(client.messages.create).toHaveBeenCalledOnce();
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model" }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Helicone-Property-Tenant-Id": TENANT,
        }),
      }),
    );
  });

  it("returns empty graph for empty/blank artifact text WITHOUT calling the model", async () => {
    const client = clientReturning("{}");
    const g1 = await extractEntitiesAndRelations("", TENANT, { client });
    const g2 = await extractEntitiesAndRelations("   ", TENANT, { client });
    expect(g1).toEqual({ entities: [], relations: [] });
    expect(g2).toEqual({ entities: [], relations: [] });
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("degrades to empty graph (no throw) on malformed model JSON", async () => {
    const client = clientReturning("I am a language model and I refuse.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await extractEntitiesAndRelations("some note", TENANT, { client });
    expect(g).toEqual({ entities: [], relations: [] });
    warn.mockRestore();
  });

  it("degrades to empty graph (no throw) when the model client throws", async () => {
    const client: TypedExtractClient = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("anthropic 529 overloaded");
        }),
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await extractEntitiesAndRelations("Acme Corp signed Jane Doe", TENANT, {
      client,
    });
    expect(g).toEqual({ entities: [], relations: [] });
    expect(console.warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("degrades to empty graph when the model returns no text block", async () => {
    const client: TypedExtractClient = {
      messages: {
        create: vi.fn(async () => ({ content: [] })),
      },
    };
    const g = await extractEntitiesAndRelations("a note", TENANT, { client });
    expect(g).toEqual({ entities: [], relations: [] });
  });
});
