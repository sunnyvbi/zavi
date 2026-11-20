import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toOpenAiStrictSchema } from "../strict-schema";

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);

export function openAiSchemaViolations(node: unknown, path = "$"): string[] {
  if (!isObj(node)) return [];
  const out: string[] = [];
  for (const k of ["oneOf", "allOf", "not"]) if (k in node) out.push(`${path}: '${k}' is not permitted`);
  if (!("type" in node) && !("anyOf" in node) && !("$ref" in node)) out.push(`${path}: schema must have a 'type' key`);
  if (Array.isArray(node.anyOf) && node.additionalProperties === false && !isObj(node.properties)) out.push(`${path}: closed object with anyOf and no properties is unsatisfiable`);
  if ("const" in node && Array.isArray(node.type) && (node.type as unknown[]).includes("null")) out.push(`${path}: nullable type beside a const`);
  if (isObj(node.properties)) for (const [k, v] of Object.entries(node.properties)) out.push(...openAiSchemaViolations(v, `${path}.${k}`));
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((b, i) => out.push(...openAiSchemaViolations(b, `${path}.anyOf[${i}]`)));
  if (node.items !== undefined) out.push(...(Array.isArray(node.items) ? node.items.flatMap((b, i) => openAiSchemaViolations(b, `${path}.items[${i}]`)) : openAiSchemaViolations(node.items, `${path}[]`)));
  for (const d of ["$defs", "definitions"]) if (isObj(node[d])) for (const [k, v] of Object.entries(node[d] as J)) out.push(...openAiSchemaViolations(v, `${path}.${d}.${k}`));
  return out;
}

async function allInternalTools(): Promise<Array<{ name: string; input_schema: unknown }>> {
  const src = readFileSync(join(__dirname, "../../../mcp/discovery.ts"), "utf8");
  const imports = [...src.matchAll(/import \{ (list[A-Za-z]+Tools) \} from "\.\/internal\/([a-z0-9_-]+)"/g)];
  const tools: Array<{ name: string; input_schema: unknown }> = [];
  for (const [, fn, file] of imports) {
    const mod = (await import(`../../../mcp/internal/${file}`)) as Record<string, unknown>;
    const f = mod[fn];
    if (typeof f !== "function") continue;
    let listed: unknown;
    try {
      listed = await (f as () => unknown)();
    } catch {
      continue;
    }
    if (!Array.isArray(listed)) continue;
    for (const t of listed as Array<{ server_id: string; tool_name: string; input_schema: unknown }>) {
      tools.push({ name: `${t.server_id}__${t.tool_name}`, input_schema: t.input_schema });
    }
  }
  return tools;
}

describe("OpenAI tool-schema conformance (every internal MCP tool)", () => {
  it("enumerates the internal tool servers", async () => {
    expect((await allInternalTools()).length).toBeGreaterThan(50);
  }, 120_000);

  it("every tool schema is accepted by OpenAI's function-parameter rules", async () => {
    const bad: string[] = [];
    for (const t of await allInternalTools()) {
      for (const v of openAiSchemaViolations(toOpenAiStrictSchema(t.input_schema))) bad.push(`${t.name} ${v}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
