
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  topLevelRegistryKeys,
  frontmatter,
  makeIndexConstResolver,
} from "./lib/index-registry-keys";

const AGENTS_DIR = join(__dirname, "..");
const INDEX_FILE = join(AGENTS_DIR, "index.ts");

const EMITTER_EXEMPT: ReadonlySet<string> = new Set<string>([
  "browser-operator",
]);

type SideEffectAgent = { slug: string; decisionClass: string };

function sideEffectAgents(): SideEffectAgent[] {
  const out: SideEffectAgent[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name === "__tests__") {
      continue;
    }
    const md = join(AGENTS_DIR, entry.name, "agent.md");
    if (!existsSync(md)) continue;
    const fm = frontmatter(readFileSync(md, "utf8"));
    if (!/^\s*side_effects:\s*true\s*$/m.test(fm)) continue;
    const dc = /^\s*decision_class:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m.exec(fm);
    if (!dc) continue;
    out.push({ slug: entry.name, decisionClass: dc[1] });
  }
  return out;
}

describe("side-effect agents have a registered emitter", () => {
  const src = readFileSync(INDEX_FILE, "utf8");
  const resolveConst = makeIndexConstResolver(
    src,
    join(AGENTS_DIR),
    (p) => readFileSync(p, "utf8"),
    (p) => existsSync(p),
  );
  const dispatchers = topLevelRegistryKeys(
    src,
    "export const dispatchers: Record<string, DispatcherFn> = {",
    resolveConst,
  );
  const postProcessors = topLevelRegistryKeys(
    src,
    "export const postProcessors: Record<string, PostProcessorFn> = {",
    resolveConst,
  );
  const outputSchemas = topLevelRegistryKeys(
    src,
    "export const outputSchemas: Record<string, ZodTypeAny> = {",
    resolveConst,
  );
  const agents = sideEffectAgents();

  it("parses the registries and the fleet (scan sanity — a broken parser must not pass vacuously)", () => {
    expect(dispatchers.size).toBeGreaterThanOrEqual(5);
    expect(postProcessors.size).toBeGreaterThanOrEqual(8);
    expect(outputSchemas.size).toBeGreaterThanOrEqual(5);
    expect(agents.length).toBeGreaterThanOrEqual(8);
    expect(agents.map((a) => a.slug)).toContain("engineer");
  });

  it("registers an emitter for every agent declaring side_effects + decision_class", () => {
    const unwired = agents
      .filter((a) => !EMITTER_EXEMPT.has(a.slug))
      .filter((a) => !dispatchers.has(a.slug) && !postProcessors.has(a.slug))
      .map((a) => `${a.slug} (decision_class: ${a.decisionClass})`);

    expect(
      unwired,
      "These agents declare `side_effects: true` + a `decision_class` in agent.md " +
        "but appear in NEITHER `dispatchers` nor `postProcessors` in agents/index.ts. " +
        "Nothing will call ctx.emitDecision for them: the run produces model text and " +
        "no founder-visible card, silently. Register an emitter (usually " +
        "createSideEffectDispatcher) or add a reviewed EMITTER_EXEMPT entry.\n" +
        unwired.join("\n"),
    ).toEqual([]);
  });

  it("every EMITTER_EXEMPT entry is still a real, still-unwired side-effect agent", () => {
    const declared = new Set(agents.map((a) => a.slug));
    const stale = [...EMITTER_EXEMPT].filter(
      (slug) =>
        !declared.has(slug) || dispatchers.has(slug) || postProcessors.has(slug),
    );
    expect(
      stale,
      "EMITTER_EXEMPT lists slugs that are no longer unwired side-effect agents " +
        "— either they stopped declaring side_effects + decision_class, or they " +
        "now have a real emitter. Drop the exemption: " +
        stale.join(", "),
    ).toEqual([]);
  });

  it("registers an output schema for every agent whose emitter validates one", () => {
    const missingSchema = agents
      .filter((a) => dispatchers.has(a.slug))
      .filter((a) => !outputSchemas.has(a.slug))
      .map((a) => a.slug);

    expect(
      missingSchema,
      "These agents have a bespoke dispatcher but no `outputSchemas[slug]`. " +
        "createSideEffectDispatcher validates the parsed envelope against that schema " +
        "before calling emitDecision, so emission cannot succeed.\n" +
        missingSchema.join("\n"),
    ).toEqual([]);
  });
});
