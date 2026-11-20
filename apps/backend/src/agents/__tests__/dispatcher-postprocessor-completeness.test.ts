
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_FILE = join(__dirname, "..", "index.ts");

const CHAT_REATTACH_EXEMPT: ReadonlySet<string> = new Set<string>([
  "qa",
  "dispute-response",
]);

function topLevelRegistryKeys(src: string, declMarker: string): Set<string> {
  const declStart = src.indexOf(declMarker);
  expect(declStart, `could not find \`${declMarker}\` in index.ts`).toBeGreaterThan(-1);
  const open = src.indexOf("{", declStart + declMarker.length - 1);
  expect(open, `could not find opening brace for \`${declMarker}\``).toBeGreaterThan(-1);

  const keys = new Set<string>();
  let depth = 0;
  let expectKey = false;
  let i = open;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      if (expectKey && depth === 1) {
        const close = src.indexOf(c, i + 1);
        const key = src.slice(i + 1, close);
        keys.add(key);
        expectKey = false;
        i = close + 1;
        continue;
      }
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }

    if (c === "{" || c === "(" || c === "[") {
      depth++;
      if (depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) break;
      i++;
      continue;
    }

    if (c === "," && depth === 1) {
      expectKey = true;
      i++;
      continue;
    }

    if (expectKey && depth === 1 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const ident = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === ":") {
        keys.add(ident);
        expectKey = false;
      }
      i = j;
      continue;
    }

    i++;
  }
  return keys;
}

describe("dispatcher ↔ post-processor re-attach completeness", () => {
  const src = readFileSync(INDEX_FILE, "utf8");
  const dispatchers = topLevelRegistryKeys(
    src,
    "export const dispatchers: Record<string, DispatcherFn> = {",
  );
  const postProcessors = topLevelRegistryKeys(
    src,
    "export const postProcessors: Record<string, PostProcessorFn> = {",
  );

  it("parses both registries (scan sanity — guards a broken parser passing vacuously)", () => {
    expect(dispatchers.size).toBeGreaterThanOrEqual(5);
    expect(postProcessors.size).toBeGreaterThanOrEqual(8);
    for (const leak of ["slug", "schema", "shouldEmit", "decisionClass"]) {
      expect(
        dispatchers.has(leak),
        `parser leaked nested factory key \`${leak}\` into the dispatchers set`,
      ).toBe(false);
    }
    expect(dispatchers.has("engineer")).toBe(true);
    expect(postProcessors.has("pm")).toBe(true);
  });

  it("every bespoke dispatcher re-attaches on chat (has a post-processor) or is exempt", () => {
    const dropped = [...dispatchers].filter(
      (slug) => !postProcessors.has(slug) && !CHAT_REATTACH_EXEMPT.has(slug),
    );
    expect(
      dropped,
      dropped.length === 0
        ? ""
        : `These agents have a bespoke \`dispatchers[slug]\` but NO ` +
            `\`postProcessors[slug]\` and are NOT on CHAT_REATTACH_EXEMPT. Their ` +
            `entire server pipeline (decision emit / A2A dispatch / citation+PII ` +
            `scrub) SILENTLY DROPS on the chat surface — no test, no error.\n` +
            `Fix: register a \`postProcessors["<slug>"]\` in ` +
            `apps/backend/src/agents/index.ts (reuse the dispatcher's post-run), ` +
            `OR if chat is intentionally a no-op for this agent add it to ` +
            `CHAT_REATTACH_EXEMPT in this test with a one-line reason:\n` +
            dropped.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });

  it("no exempt agent also has a post-processor (an exemption that is no longer true)", () => {
    expect([...CHAT_REATTACH_EXEMPT].filter((slug) => postProcessors.has(slug))).toEqual([]);
  });

  it("every CHAT_REATTACH_EXEMPT entry is a real current dispatcher (no stale exemptions)", () => {
    const stale = [...CHAT_REATTACH_EXEMPT].filter((slug) => !dispatchers.has(slug));
    expect(
      stale,
      `CHAT_REATTACH_EXEMPT lists slugs that no longer have a bespoke ` +
        `dispatcher — remove the stale exemption: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("no exempt slug ALSO has a post-processor (an exemption would then be dead/misleading)", () => {
    const contradictory = [...CHAT_REATTACH_EXEMPT].filter((slug) =>
      postProcessors.has(slug),
    );
    expect(
      contradictory,
      `These slugs are on CHAT_REATTACH_EXEMPT but DO have a post-processor — ` +
        `the exemption is misleading; drop it from the allow-list: ${contradictory.join(", ")}`,
    ).toEqual([]);
  });
});
