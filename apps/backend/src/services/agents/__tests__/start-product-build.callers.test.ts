
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOTS = [path.join(process.cwd(), "src"), path.join(process.cwd(), "workers")];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      tsFiles(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function callArgs(src: string): string[] {
  const out: string[] = [];
  const re = /\bstartProductBuild(?:Detached)?\(\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

describe("startProductBuild callers", () => {
  const calls = ROOTS.flatMap((root) =>
    tsFiles(root).flatMap((f) => callArgs(fs.readFileSync(f, "utf8")).map((arg) => ({ file: path.relative(process.cwd(), f), arg }))),
  );

  it("finds the known callers", () => {
    const files = calls.map((c) => c.file).sort();
    expect(files).toEqual([
      "src/routes/onboarding/build-start.ts",
      "src/routes/workspace/autopilot.ts",
      "src/routes/workspace/old-site-rebuild.ts",
      "src/services/mcp/internal/praxis.ts",
    ]);
  });

  it("every caller passes started_by_user_id from verified auth", () => {
    for (const { file, arg } of calls) {
      expect(arg, file).toMatch(/started_by_user_id:\s*(auth\.user_id|user_id)\b/);
    }
  });
});
