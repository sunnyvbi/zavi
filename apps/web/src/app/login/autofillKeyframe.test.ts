
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const NAME = "zavi-autofill-start";

function keyframesBody(css: string, name: string): string | null {
  const at = css.indexOf(`@keyframes ${name}`);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

function declarationCount(body: string): number {
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  return (stripped.match(/[\w-]+\s*:\s*[^;{}]+/g) ?? []).length;
}

describe("autofill keyframe", () => {
  it("is referenced by the :-webkit-autofill rule", () => {
    expect(CSS).toMatch(new RegExp(`input:-webkit-autofill\\s*\\{[^}]*animation-name:\\s*${NAME}`));
  });

  it("is defined", () => {
    expect(keyframesBody(CSS, NAME)).not.toBeNull();
  });

  it("DECLARES something, so the minifier cannot discard it as an empty rule", () => {
    const body = keyframesBody(CSS, NAME);
    expect(body).not.toBeNull();
    expect(declarationCount(body as string)).toBeGreaterThan(0);
  });
});
