import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs CI script, no type declarations
import { isTextLockTest, isAllowed, check } from "../../../../../scripts/ci/no-text-lock-tests.mjs";

const HEAD = `import { describe, it, expect } from "vitest";\n`;

describe("isTextLockTest: must catch", () => {
  it("a migration SQL-text test", () => {
    const src = `${HEAD}import { readFileSync } from "node:fs";\nimport path from "path";\nconst sql = readFileSync(path.join(__dirname, "../../../supabase/migrations/0054_x.sql"), "utf8");\nit("revokes execute from public", () => { expect(sql).toMatch(/revoke execute/i); });`;
    expect(isTextLockTest(src)).toBe(true);
  });

  it("a prompt lock that greps agent.md", () => {
    const src = `${HEAD}import * as fs from "fs";\nconst md = fs.readFileSync("src/agents/operator/agent.md", "utf8");\nit("has the heading", () => { expect(md).toContain("## Internal machinery"); });`;
    expect(isTextLockTest(src)).toBe(true);
  });

  it("a source-shape test that regexes a .ts file", () => {
    const src = `${HEAD}import { readFileSync } from "fs";\nconst code = readFileSync(new URL("../dispatcher.ts", import.meta.url), "utf8");\nit("has two call sites", () => { expect(code.match(/buildContext\\(/g)).toHaveLength(2); });`;
    expect(isTextLockTest(src)).toBe(true);
  });

  it("still a text-lock when it also imports a json fixture or yaml", () => {
    const src = `${HEAD}import { readFileSync } from "fs";\nimport YAML from "yaml";\nimport budget from "./prompt-budget.json";\nit("x", () => { expect(readFileSync("a.md", "utf8").length).toBeLessThan(budget.max); });`;
    expect(isTextLockTest(src)).toBe(true);
  });
  it("still a text-lock when its only product import is type-only", () => {
    const a = `${HEAD}import { readFileSync } from "fs";\nimport type { TenantId } from "../types";\nit("x", () => { expect(readFileSync("m.sql", "utf8")).toMatch(/revoke/); });`;
    const b = `${HEAD}import { readFileSync } from "fs";\nimport { type Row, type Col as C } from "@/db/types";\nit("x", () => { expect(readFileSync("m.sql", "utf8")).toMatch(/revoke/); });`;
    expect(isTextLockTest(a)).toBe(true);
    expect(isTextLockTest(b)).toBe(true);
  });
});

describe("isTextLockTest: must not touch", () => {
  it("a behaviour test that imports the code under test", () => {
    const src = `${HEAD}import { detectPunt } from "../punt-detector";\nit("x", () => { expect(detectPunt("hi").punt).toBe(false); });`;
    expect(isTextLockTest(src)).toBe(false);
  });

  it("a behaviour test that also reads a fixture file", () => {
    const src = `${HEAD}import { readFileSync } from "fs";\nimport { parseInvoice } from "@/services/billing/parse";\nit("x", () => { expect(parseInvoice(readFileSync("fixtures/inv.json", "utf8")).total).toBe(10); });`;
    expect(isTextLockTest(src)).toBe(false);
  });

  it("a test that loads product code with a dynamic import or vi.mock", () => {
    const dyn = `${HEAD}import { readFileSync } from "fs";\nit("x", async () => { const m = await import("../runner"); expect(m.run).toBeTypeOf("function"); void readFileSync; });`;
    const mocked = `${HEAD}import fs from "fs";\nvi.mock("@/services/supabase", () => ({}));\nit("x", () => { void fs.readFileSync; });`;
    expect(isTextLockTest(dyn)).toBe(false);
    expect(isTextLockTest(mocked)).toBe(false);
  });

  it("a test that exercises a third-party library", () => {
    const src = `${HEAD}import { readFileSync } from "fs";\nimport Stripe from "stripe";\nit("x", () => { expect(Stripe).toBeDefined(); void readFileSync; });`;
    expect(isTextLockTest(src)).toBe(false);
  });

  it("a mixed import with a runtime binding is a real test", () => {
    const src = `${HEAD}import { readFileSync } from "fs";\nimport { type Row, parse } from "@/db/parse";\nit("x", () => { expect(parse(readFileSync("f.json", "utf8"))).toBeTruthy(); });`;
    expect(isTextLockTest(src)).toBe(false);
  });

  it("a side-effect import of product code is a real test", () => {
    const src = `${HEAD}import { readFileSync } from "fs";\nimport "../register-handlers";\nit("x", () => { expect(readFileSync("fixtures/a.json", "utf8")).toBeTruthy(); });`;
    expect(isTextLockTest(src)).toBe(false);
  });

  it("a pure test that reads no files", () => {
    expect(isTextLockTest(`${HEAD}it("adds", () => { expect(1 + 1).toBe(2); });`)).toBe(false);
  });
});

describe("the allow marker and the file check", () => {
  const lock = `${HEAD}import { readFileSync } from "fs";\nit("x", () => { expect(readFileSync("deploy.yml", "utf8")).toContain("docker stop"); });`;

  it("an explained text-lock is allowed, a bare marker is not", () => {
    expect(isAllowed(`// text-lock-ok: deploy.yml swap ordering has no runtime to test\n${lock}`)).toBe(true);
    expect(isAllowed(`// text-lock-ok:\n${lock}`)).toBe(false);
    expect(isAllowed(lock)).toBe(false);
  });

  it("the marker only counts near the top of the file", () => {
    const buried = `${lock}\n${"\n".repeat(20)}// text-lock-ok: too late`;
    expect(isAllowed(buried)).toBe(false);
  });

  it("check() reports only unexplained text-locks and skips unreadable files", () => {
    const files: Record<string, string> = {
      "a.test.ts": lock,
      "b.test.ts": `// text-lock-ok: config drift guard\n${lock}`,
      "c.test.ts": `${HEAD}import { f } from "../f";\nit("x", () => { expect(f()).toBe(1); });`,
    };
    const read = (p: string) => {
      if (!(p in files)) throw new Error("gone");
      return files[p];
    };
    expect(check(["a.test.ts", "b.test.ts", "c.test.ts", "deleted.test.ts"], read)).toEqual(["a.test.ts"]);
  });
});
