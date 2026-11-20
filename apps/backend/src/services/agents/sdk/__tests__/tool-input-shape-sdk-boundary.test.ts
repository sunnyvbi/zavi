
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  buildToolInputShape,
  repairArgsFromSchema,
  unwrapToolArgs,
} from "../tool-input-shape";

const QUERY_SCHEMA = {
  type: "object",
  properties: {
    collection: { type: "string", description: "The collection to read." },
    mode: { type: "string", enum: ["find", "aggregate"] },
    filter: { type: "object", additionalProperties: {} },
    pipeline: { type: "array", items: { type: "object", additionalProperties: {} } },
    limit: { type: "integer", description: "Max rows to return." },
    dry_run: { type: "boolean" },
  },
  required: ["collection", "mode"],
};

type SdkToolDef = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];
const looseTool = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): SdkToolDef =>
  (tool as unknown as (...a: unknown[]) => SdkToolDef)(name, description, shape, handler);

async function connect(server: unknown): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await (server as { instance: { connect: (t: unknown) => Promise<void> } }).instance.connect(
    serverSide,
  );
  const client = new Client({ name: "probe", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientSide);
  return client;
}

async function serveTool(inputSchema: unknown) {
  const { shape, declaresOwnInput } = buildToolInputShape(inputSchema);
  let received: unknown = null;
  const server = createSdkMcpServer({
    name: "probe",
    version: "1.0.0",
    tools: [
      looseTool("t", "d", shape, async (args: unknown) => {
        received = repairArgsFromSchema(inputSchema, unwrapToolArgs(args, declaresOwnInput));
        return { content: [{ type: "text" as const, text: "ok" }] };
      }),
    ],
  });
  const client = await connect(server);
  return {
    async advertised() {
      const { tools } = await client.listTools();
      return tools[0].inputSchema.properties as Record<string, Record<string, unknown>>;
    },
    async call(args: Record<string, unknown>) {
      received = null;
      const res = await client.callTool({ name: "t", arguments: args });
      return { isError: Boolean(res.isError), received };
    },
  };
}

describe("what the SDK actually serves the model", () => {
  let props: Record<string, Record<string, unknown>>;
  beforeAll(async () => {
    props = await (await serveTool(QUERY_SCHEMA)).advertised();
  });

  it("declares a real type for every parameter — an untyped `{}` is the bug", () => {
    for (const [name, node] of Object.entries(props)) {
      if (name === "input") continue;
      expect(Object.keys(node).length, `${name} served as untyped {}`).toBeGreaterThan(0);
      expect(node.type, `${name} served without a type`).toBeDefined();
    }
  });

  it("serves the types the model was getting wrong", () => {
    expect(props.pipeline.type).toBe("array");
    expect(props.filter.type).toBe("object");
    expect(props.limit.type).toMatch(/^(number|integer)$/);
    expect(props.dry_run.type).toBe("boolean");
    expect(props.collection.type).toBe("string");
  });

  it("the OLD z.unknown() shape serves `{}` — proves the fix is load-bearing", async () => {
    const server = createSdkMcpServer({
      name: "old",
      version: "1.0.0",
      tools: [
        looseTool("t", "d", { pipeline: z.unknown().optional() }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        })),
      ],
    });
    const { tools } = await (await connect(server)).listTools();
    expect((tools[0].inputSchema.properties as Record<string, unknown>).pipeline).toEqual({});
  });
});

describe("SDK boundary behaviour", () => {
  it("passes correctly-typed args straight through", async () => {
    const t = await serveTool(QUERY_SCHEMA);
    const args = {
      collection: "trips",
      mode: "aggregate",
      pipeline: [{ $match: { tripType: "subscription" } }],
      limit: 5,
    };
    expect(await t.call(args)).toEqual({ isError: false, received: args });
  });

  it("repairs the exact prod-run 6b6c6eb8 payload", async () => {
    const t = await serveTool(QUERY_SCHEMA);
    expect(
      await t.call({
        collection: "trips",
        mode: "aggregate",
        pipeline: '[{"$match":{"tripType":"subscription"}},{"$count":"n"}]',
      }),
    ).toEqual({
      isError: false,
      received: {
        collection: "trips",
        mode: "aggregate",
        pipeline: [{ $match: { tripType: "subscription" } }, { $count: "n" }],
      },
    });
  });

  it("a call missing required fields still REACHES the handler", async () => {
    const t = await serveTool(QUERY_SCHEMA);
    expect(await t.call({ mode: "find" })).toEqual({ isError: false, received: { mode: "find" } });
  });

  it("an unrepairable value is a RECOVERABLE tool error, never a thrown run", async () => {
    const t = await serveTool(QUERY_SCHEMA);
    await expect(
      t.call({ collection: "trips", mode: "find", limit: "not-a-number" }),
    ).resolves.toEqual(expect.objectContaining({ isError: true }));
  });
});

describe("both SDK boundaries use the one builder", () => {
  const ENGINE = join(__dirname, "../../engine/anthropic-engine.ts");

  it("anthropic-engine builds its SDK shape from tool-input-shape", () => {
    const src = readFileSync(ENGINE, "utf8");
    expect(src).toMatch(/from "\.\.\/sdk\/tool-input-shape"/);
    expect(src).toMatch(/buildToolInputShape\(/);
  });

  it("anthropic-engine no longer hand-rolls the `{ input: … }`-only shape", () => {
    const src = readFileSync(ENGINE, "utf8");
    expect(src).not.toMatch(/\{\s*input:\s*z\.record\(z\.string\(\),\s*z\.unknown\(\)\)\.optional\(\)\s*\}/);
  });
});
