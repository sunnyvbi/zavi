
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { AGENT_SLUG_ALIASES } from "../content-design/constants";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");
const CORE_ROOT = path.join(AGENTS_ROOT, "_core");
const EXECUTE_TS = path.join(process.cwd(), "src", "services", "mcp", "execute.ts");

function listAgentSlugs(): string[] {
  return readdirSync(AGENTS_ROOT)
    .filter((entry) => {
      if (entry.startsWith("_") || entry.startsWith(".")) return false;
      const full = path.join(AGENTS_ROOT, entry);
      if (!statSync(full).isDirectory()) return false;
      return existsSync(path.join(full, "agent.md"));
    })
    .sort();
}

function readAgent(slug: string): { body: string; praxis: Record<string, unknown> } {
  const raw = readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
  const fm = matter(raw).data as Record<string, unknown>;
  const praxis =
    ((fm.metadata as Record<string, unknown> | undefined)?.praxis ?? {}) as
      Record<string, unknown>;
  return { body: matter(raw).content, praxis };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

const KNOWN_IMPACT_CLASSES = new Set<string>([
  "comms",
  "internal-dispatch",
  "money",
  "spend",
  "paid_acquisition",
  "code",
  "repo-write",
]);

function parseInternalServerIds(): Set<string> {
  const src = readFileSync(EXECUTE_TS, "utf-8");
  const ids = new Set<string>();
  for (const m of src.matchAll(/server_id === "([a-z0-9_]+)"/g)) ids.add(m[1]);
  return ids;
}

type Lister = () => Promise<Array<{ tool_name: string }>>;
const LISTER_IMPORTS: Record<string, Lister> = {
  slack: () => import("../../services/mcp/internal/slack").then((m) => m.listSlackTools()),
  github: () => import("../../services/mcp/internal/github").then((m) => m.listGithubTools()),
  web_search: () => import("../../services/mcp/internal/web-search").then((m) => m.listWebSearchTools()),
  web_fetch: () => import("../../services/mcp/internal/web_fetch").then((m) => m.listWebFetchTools()),
  apify: () => import("../../services/mcp/internal/apify").then((m) => m.listApifyTools()),
  product: () => import("../../services/mcp/internal/product").then((m) => m.listProductProbeTools()),
  operator_db: () => import("../../services/mcp/internal/operator-db").then((m) => m.listOperatorDbTools()),
  investor_db: () => import("../../services/mcp/internal/investor-db").then((m) => m.listInvestorDbTools()),
  investor_discovery: () =>
    import("../../services/mcp/internal/investor-discovery").then((m) => m.listInvestorDiscoveryTools()),
  brain: () => import("../../services/mcp/internal/brain").then((m) => m.listBrainTools()),
  praxis_corpus: () => import("../../services/mcp/internal/praxis-corpus").then((m) => m.listPraxisCorpusTools()),
  praxis: () => import("../../services/mcp/internal/praxis").then((m) => m.listPraxisTools()),
  meta_ads: () => import("../../services/mcp/internal/meta-ads").then((m) => m.listMetaAdsTools()),
  google_ads: () => import("../../services/mcp/internal/google-ads").then((m) => m.listGoogleAdsTools()),
  paid_acquisition: () =>
    import("../../services/mcp/internal/paid-acquisition").then((m) => m.listPaidAcquisitionTools()),
  chatgpt_ads: () =>
    import("../../services/mcp/internal/chatgpt-ads").then((m) => m.listChatgptAdsTools()),
  buffer: () => import("../../services/mcp/internal/buffer").then((m) => m.listBufferTools()),
  growth: () => import("../../services/mcp/internal/growth").then((m) => m.listGrowthTools()),
  jira: () => import("../../services/mcp/internal/jira").then((m) => m.listJiraTools()),
  linear: () => import("../../services/mcp/internal/linear").then((m) => m.listLinearTools()),
  qa_engineer: () => import("../../services/mcp/internal/qa-engineer").then((m) => m.listQaEngineerTools()),
  stripe: () => import("../../services/mcp/internal/stripe").then((m) => m.listStripeTools()),
  email: () => import("../../services/mcp/internal/email").then((m) => m.listEmailTools()),
  report: () => import("../../services/mcp/internal/report").then((m) => m.listReportTools()),
  artifacts: () => import("../../services/mcp/internal/artifacts").then((m) => m.listArtifactsTools()),
  code_index: () => import("../../services/mcp/internal/code-index").then((m) => m.listCodeIndexTools()),
};

const INTERNAL_NO_LISTER = new Set<string>(["memory", "competitor_intel"]);

async function loadBareToolNames(): Promise<Set<string>> {
  const [{ sandboxToolRegistry }, { ALL_BROWSER_TOOL_NAMES }] = await Promise.all([
    import("../../services/sandbox/tool-registry"),
    import("../../services/sandbox/browser-mcp/types"),
  ]);
  return new Set<string>([
    ...Object.keys(sandboxToolRegistry),
    ...(ALL_BROWSER_TOOL_NAMES as readonly string[]),
  ]);
}

const PREFIX_WILDCARD_RE = /^(.+?)\*__\*$/;

interface ParsedTool {
  raw: string;
  serverId: string;
  toolName: string;
  prefixWildcard: boolean;
}

function parseDeclaredTool(raw: string): ParsedTool | null {
  const t = raw.trim();
  if (!t) return null;
  if (PREFIX_WILDCARD_RE.test(t)) {
    return { raw: t, serverId: t.replace(PREFIX_WILDCARD_RE, "$1"), toolName: "*", prefixWildcard: true };
  }
  const idx = t.indexOf("__");
  if (idx <= 0) return { raw: t, serverId: t, toolName: "", prefixWildcard: false };
  return {
    raw: t,
    serverId: t.slice(0, idx),
    toolName: t.slice(idx + 2),
    prefixWildcard: false,
  };
}

describe("agent-reference-integrity (Move 10)", () => {
  const slugs = listAgentSlugs();
  const validAgentSlugs = new Set<string>([...slugs, ...Object.keys(AGENT_SLUG_ALIASES)]);
  const internalServerIds = parseInternalServerIds();

  const serverTools: Record<string, Set<string>> = {};
  let bareToolNames = new Set<string>();
  const listerFailures: string[] = [];

  beforeAll(async () => {
    for (const [serverId, lister] of Object.entries(LISTER_IMPORTS)) {
      try {
        const tools = await lister();
        serverTools[serverId] = new Set(tools.map((t) => t.tool_name));
      } catch (e) {
        listerFailures.push(`${serverId}: ${(e as Error).message}`);
      }
    }
    try {
      bareToolNames = await loadBareToolNames();
    } catch (e) {
      listerFailures.push(`bare-tool registries: ${(e as Error).message}`);
    }
  }, 180_000);

  it("finds the agent fleet on disk (sanity check)", () => {
    expect(slugs.length).toBeGreaterThan(10);
    expect(slugs).toContain("performance-marketer");
  });

  it("every internal-server lister loaded (tool universe is complete)", () => {
    expect(listerFailures, `lister import failures:\n  - ${listerFailures.join("\n  - ")}`).toEqual([]);
    expect(serverTools.github).toContain("read_file");
    expect(serverTools.operator_db).toContain("query");
    expect(bareToolNames.has("str_replace")).toBe(true);
    expect(bareToolNames.has("browser_nav")).toBe(true);
  });

  it("every `inherits:` slug resolves to a _core/<slug>.md file", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const { praxis } = readAgent(slug);
      for (const inh of asStringArray(praxis.inherits)) {
        if (!existsSync(path.join(CORE_ROOT, `${inh}.md`))) {
          violations.push(
            `${slug}/agent.md → inherits: "${inh}" has no _core/${inh}.md (dangling shared-contract reference).`,
          );
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`inherits reference-integrity violations:\n  - ${violations.join("\n  - ")}`);
    }
  });

  it("every declared internal tool resolves to a tool the server exposes", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const { praxis } = readAgent(slug);
      for (const decl of asStringArray(praxis.tools)) {
        const parsed = parseDeclaredTool(decl);
        if (!parsed) continue;
        if (parsed.prefixWildcard) continue;
        if (!parsed.toolName && parsed.serverId === decl.trim()) {
          if (!bareToolNames.has(parsed.serverId)) {
            violations.push(
              `${slug}/agent.md → tools: "${decl}" is neither a <server>__<tool> name ` +
                `nor a known sandbox/browser tool (${[...bareToolNames].sort().join(", ")}).`,
            );
          }
          continue;
        }
        const known = serverTools[parsed.serverId];
        const isInternal = internalServerIds.has(parsed.serverId) || known !== undefined;
        if (!isInternal) continue;
        if (INTERNAL_NO_LISTER.has(parsed.serverId) || !known) continue;
        if (parsed.toolName === "*") continue;
        if (!known.has(parsed.toolName)) {
          violations.push(
            `${slug}/agent.md → tools: "${decl}" — server "${parsed.serverId}" does not expose "${parsed.toolName}". ` +
              `Available: ${[...known].sort().join(", ")}`,
          );
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`declared-tool reference-integrity violations:\n  - ${violations.join("\n  - ")}`);
    }
  });

  it("every decision_class is owned by the declaring agent (`<slug>.<action>`)", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const { praxis } = readAgent(slug);
      const dc = praxis.decision_class;
      if (typeof dc !== "string" || dc.length === 0) continue;
      const owner = dc.split(".")[0];
      const ownedByAgent =
        owner === slug || AGENT_SLUG_ALIASES[owner] === slug || owner === AGENT_SLUG_ALIASES[slug];
      const visibility = (praxis.visibility ?? {}) as Record<string, unknown>;
      const isChannelExecutor = visibility.channel_only === true;
      const sharedChannelClass = isChannelExecutor && owner === "channel";
      if (!dc.includes(".") || !(ownedByAgent || sharedChannelClass)) {
        violations.push(
          `${slug}/agent.md → decision_class: "${dc}" is not owned by this agent ` +
            `(expected prefix "${slug}."). A class naming a different/renamed agent is a wiring bug.`,
        );
      }
    }
    if (violations.length > 0) {
      throw new Error(`decision_class reference-integrity violations:\n  - ${violations.join("\n  - ")}`);
    }
  });

  it("the channel.* exemption is scoped to channel-only executors", () => {
    for (const slug of slugs) {
      const { praxis } = readAgent(slug);
      const dc = praxis.decision_class;
      if (typeof dc !== "string" || !dc.startsWith("channel.")) continue;
      const visibility = (praxis.visibility ?? {}) as Record<string, unknown>;
      expect(
        visibility.channel_only,
        `${slug} declares a channel.* decision_class but is not channel_only`,
      ).toBe(true);
    }
  });

  it("every impact_classes value is in the known blast-radius vocabulary", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const { praxis } = readAgent(slug);
      for (const ic of asStringArray(praxis.impact_classes)) {
        if (!KNOWN_IMPACT_CLASSES.has(ic)) {
          violations.push(
            `${slug}/agent.md → impact_classes: "${ic}" is not a known impact class ` +
              `(${[...KNOWN_IMPACT_CLASSES].sort().join(", ")}).`,
          );
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`impact_classes reference-integrity violations:\n  - ${violations.join("\n  - ")}`);
    }
  });

  it("every hardcoded handoff target in the body names a real agent", () => {
    const TARGET_RE = /(?:target_agent_slug|agent_slug)\s*:\s*"([a-z][a-z0-9-]*)"/g;
    const violations: string[] = [];
    for (const slug of slugs) {
      const { body } = readAgent(slug);
      for (const m of body.matchAll(TARGET_RE)) {
        const target = m[1];
        if (!validAgentSlugs.has(target)) {
          violations.push(
            `${slug}/agent.md → handoff target "${target}" is not a live agent slug ` +
              `(handoff wired to a renamed/deleted agent).`,
          );
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`handoff-target reference-integrity violations:\n  - ${violations.join("\n  - ")}`);
    }
  });

  it("negative control: a missing _core file is detected", () => {
    expect(existsSync(path.join(CORE_ROOT, "recall-before-act.md"))).toBe(true);
    expect(existsSync(path.join(CORE_ROOT, "no-such-core-contract.md"))).toBe(false);
  });

  it("negative control: an unexposed internal tool is detected", () => {
    expect(serverTools.github?.has("read_file")).toBe(true);
    expect(serverTools.github?.has("read_fil")).toBe(false);
    expect(bareToolNames.has("str_replace")).toBe(true);
    expect(bareToolNames.has("str_replac")).toBe(false);
  });

  it("negative control: parseDeclaredTool splits server/tool + flags wildcards", () => {
    expect(parseDeclaredTool("operator_db__query_user")).toMatchObject({
      serverId: "operator_db",
      toolName: "query_user",
      prefixWildcard: false,
    });
    expect(parseDeclaredTool("composio__*")).toMatchObject({ serverId: "composio", toolName: "*" });
    expect(parseDeclaredTool("pipedream_*__*")).toMatchObject({
      serverId: "pipedream_",
      prefixWildcard: true,
    });
    expect(parseDeclaredTool("str_replace")).toMatchObject({ serverId: "str_replace", toolName: "" });
  });

  it("negative control: a wrong-agent decision_class is detected", () => {
    const owns = (slug: string, dc: string) => {
      const owner = dc.split(".")[0];
      return (
        dc.includes(".") &&
        (owner === slug || AGENT_SLUG_ALIASES[owner] === slug || owner === AGENT_SLUG_ALIASES[slug])
      );
    };
    expect(owns("pm", "pm.backlog")).toBe(true);
    expect(owns("pm", "engineer.ship-pr")).toBe(false);
    expect(owns("content-design", "content-seo.publish-content")).toBe(true);
  });

  it("negative control: an unknown impact_class is detected", () => {
    expect(KNOWN_IMPACT_CLASSES.has("comms")).toBe(true);
    expect(KNOWN_IMPACT_CLASSES.has("moeny")).toBe(false);
  });

  it("negative control: a handoff to a non-existent agent is detected", () => {
    const TARGET_RE = /(?:target_agent_slug|agent_slug)\s*:\s*"([a-z][a-z0-9-]*)"/g;
    const body = 'praxis__handoff(target_agent_slug: "engineer") and agent_slug: "content-seo-ghost"';
    const hits = [...body.matchAll(TARGET_RE)].map((m) => m[1]);
    expect(hits).toEqual(["engineer", "content-seo-ghost"]);
    expect(validAgentSlugs.has("engineer")).toBe(true);
    expect(validAgentSlugs.has("content-seo-ghost")).toBe(false);
  });
});
