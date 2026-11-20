
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.join(process.cwd(), "src");
const TENANT_CLIENT = path.join(SRC_ROOT, "services", "tenant-client.ts");

function registryKeys(): Set<string> {
  const src = fs.readFileSync(TENANT_CLIENT, "utf8");
  const start = src.indexOf("const REGISTRY");
  const end = src.indexOf("export function scopeKind");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  return new Set(
    [...body.matchAll(/^ {2}([a-z_][a-z0-9_]*)\s*:\s*"/gm)].map((m) => m[1]),
  );
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      tsFiles(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function facadeTables(source: string): Set<string> {
  const tables = new Set<string>();
  for (const m of source.matchAll(
    /tenantClient\s*\([^;]{0,120}?\)\s*\.\s*from\(\s*"([a-z_][a-z0-9_]*)"/g,
  )) {
    tables.add(m[1]);
  }
  const vars = new Set(
    [
      ...source.matchAll(
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*\btenantClient\s*\(/g,
      ),
    ].map((m) => m[1]),
  );
  for (const v of vars) {
    const re = new RegExp(
      `\\b${v.replace(/\$/g, "\\$")}\\s*\\.\\s*from\\(\\s*"([a-z_][a-z0-9_]*)"`,
      "g",
    );
    for (const m of source.matchAll(re)) tables.add(m[1]);
  }
  return tables;
}

describe("tenantClient scope registry completeness", () => {
  it("classifies every table read through the facade", () => {
    const keys = registryKeys();
    expect(keys.size).toBeGreaterThan(20);

    const unregistered: string[] = [];
    for (const file of tsFiles(SRC_ROOT)) {
      if (file.includes("__tests__") || file.endsWith(".test.ts")) continue;
      if (file === TENANT_CLIENT) continue;
      const source = fs.readFileSync(file, "utf8");
      if (!/\btenantClient\s*\(/.test(source)) continue;
      for (const table of facadeTables(source)) {
        if (!keys.has(table)) {
          unregistered.push(`${path.relative(SRC_ROOT, file)} -> ${table}`);
        }
      }
    }

    expect(
      unregistered,
      "These tables are read through tenantClient but are absent from the scope " +
        "REGISTRY in services/tenant-client.ts. An unregistered table makes " +
        "`.from()` throw at runtime; if the caller has a try/catch the failure is " +
        "invisible. Add each with its ScopeKind.\n" +
        unregistered.join("\n"),
    ).toEqual([]);
  });

  it("keeps the two tables whose absence caused silent production failures", () => {
    const keys = registryKeys();
    expect(keys.has("tenant_fact")).toBe(true);
    expect(keys.has("tenant_brand_kits")).toBe(true);
  });
});
