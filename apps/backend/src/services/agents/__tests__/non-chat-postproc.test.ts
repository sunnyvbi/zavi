import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("runDispatch runs postProcessors on the non-chat path (Bug B)", () => {
  const src = readFileSync(join(__dirname, "../runner.ts"), "utf-8");
  const fn = src.slice(src.indexOf("export async function runDispatch"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const nonChatTail = body.slice(body.lastIndexOf("getDispatcher("));

  it("imports the postProcessors registry", () => {
    expect(src).toMatch(/import\s*\{\s*postProcessors\s*\}\s*from\s*"@\/agents\/index"/);
  });

  it("returns early when a bespoke dispatcher exists (no double-fire)", () => {
    expect(nonChatTail).toMatch(
      /if\s*\(\s*bespoke\s*\)\s*return\s+[^;]*bespoke\(/,
    );
  });

  it("invokes the agent's postProcessor after runGeneric on the no-bespoke path", () => {
    const genIdx = nonChatTail.indexOf("runGeneric(");
    const ppLookupIdx = nonChatTail.indexOf("postProcessors[ctx.agent.slug]");
    const ppCallIdx = nonChatTail.indexOf("await postProcess(");
    expect(genIdx).toBeGreaterThan(-1);
    expect(ppLookupIdx).toBeGreaterThan(genIdx);
    expect(ppCallIdx).toBeGreaterThan(ppLookupIdx);
  });

  it("never re-throws a postProcessor failure (breadcrumbs into parse_error)", () => {
    expect(nonChatTail).toMatch(/try\s*\{[\s\S]*await postProcess\([\s\S]*\}\s*catch/);
    expect(nonChatTail).toMatch(/post_process_threw:/);
  });

  it("skips the postProcessor on a draft run (ctx.draft_mode !== true guard)", () => {
    expect(nonChatTail).toMatch(
      /if\s*\(\s*postProcess\s*&&\s*ctx\.draft_mode\s*!==\s*true\s*\)/,
    );
    const guardIdx = nonChatTail.search(
      /if\s*\(\s*postProcess\s*&&\s*ctx\.draft_mode\s*!==\s*true\s*\)/,
    );
    const ppCallIdx = nonChatTail.indexOf("await postProcess(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(ppCallIdx).toBeGreaterThan(guardIdx);
  });
});
