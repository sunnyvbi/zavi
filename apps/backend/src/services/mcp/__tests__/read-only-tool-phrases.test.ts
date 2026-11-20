import { describe, it, expect } from "vitest";
import { READ_ONLY_TOOLS, isReadOnlyTool } from "@zavi/shared";
import { internalToolEffects, allAdvertisableInternalTools } from "../tool-effects";
import { toAnthropicName } from "../types";
import { SHOW_TOOLS } from "@/services/copilotkit/ui-tools";
import { CANONICAL_SANDBOX_READ_ONLY_TOOLS } from "@/services/agents/engine/openai-sandbox-tools";
import { BROWSER_TASK_SERVER_ID } from "../internal/browser-task";
import { EXTENSION_TASK_SERVER_ID } from "../internal/extension-browser-task";

const effects = internalToolEffects();

const descriptions = new Map(
  allAdvertisableInternalTools().map((t) => [toAnthropicName(t.server_id, t.tool_name), t.description] as const),
);

const DECLARED_COST =
  /\bcosts?\b:?\s[^.]{0,24}\$\d|\$\s?\d|\bper (?:call|request)\b|\bbill(?:ed|s|ing)?\b|\bcredits_charged\b|\bcosts what\b|\bspends? (?:the )?(?:tenant|workspace)/i;

function declaredCost(description: string | undefined): string | null {
  if (!description) return null;
  return description.match(DECLARED_COST)?.[0] ?? null;
}

const PAID_SERVERS: Record<string, string> = {
  apify: "every actor run is billed by Apify",
  [BROWSER_TASK_SERVER_ID]: "a hosted browser session billed at cost to the workspace",
  [EXTENSION_TASK_SERVER_ID]: "a model-driven browser session billed at cost",
  web_search: "Tavily search, about $0.01 a call",
  investor_discovery: "runs several Tavily web_search calls and page fetches",
  code_index: "Voyage embeddings per lookup and a background index rebuild",
};

const PAID_TOOLS: Record<string, string> = {
  memory__search: "a Voyage embedding and optional Voyage rerank per query",
  operator_db__codeact: "an e2b sandbox per call plus a Voyage embedding",
  reddit__thread_read: "an Apify rag_web_browser run",
  web_fetch__fetch: "a blocked fetch escalates to a paid apify__rag_web_browser render",
  competitor_intel__http_fetch: "the web_fetch path, with the same paid render escalation",
};

function paidReason(key: string): string | null {
  const server = key.slice(0, key.indexOf("__"));
  if (PAID_SERVERS[server]) return PAID_SERVERS[server];
  if (PAID_TOOLS[key]) return PAID_TOOLS[key];
  const cost = declaredCost(descriptions.get(key));
  if (cost) return `description declares a cost: ${cost}`;
  return null;
}

function listed(): string[] {
  return READ_ONLY_TOOLS.flatMap(([server, tools]) => tools.map((tool) => `${server}__${tool}`));
}

describe("the chat's read-only tool list matches what each tool declares", () => {
  it("never lists a tool that writes, spends or deletes", () => {
    const wrong: string[] = [];
    for (const key of listed()) {
      const server = key.slice(0, key.indexOf("__"));
      const tool = key.slice(server.length + 2);
      if (server === "ui") {
        if (!(tool in SHOW_TOOLS)) wrong.push(`${key}: not a ui show tool`);
        continue;
      }
      if (server === "sandbox") {
        if (!CANONICAL_SANDBOX_READ_ONLY_TOOLS.has(key)) wrong.push(`${key}: not a sandbox read`);
        continue;
      }
      const effect = effects.get(key);
      if (effect !== "read") wrong.push(`${key}: declared ${effect ?? "nothing"}`);
    }
    expect(wrong).toEqual([]);
  });

  it("never lists a read that costs money, so a paid call always leaves a receipt", () => {
    const paid = listed()
      .map((key) => [key, paidReason(key)] as const)
      .filter(([, reason]) => reason !== null)
      .map(([key, reason]) => `${key}: ${reason}`);
    expect(paid).toEqual([]);
  });

  it("treats the reviewed paid reads as paid, from the registry where it says so", () => {
    for (const key of [
      "browser__task",
      "apify__rag_web_browser",
      "apify__scrape_instagram",
      "apify__scrape_meta_ads",
      "apify__scrape_pinterest",
      "apify__scrape_reddit",
      "apify__scrape_tiktok",
      "web_search__search",
      "competitor_intel__http_fetch",
    ]) {
      expect(effects.get(key), key).toBe("read");
      expect(paidReason(key), key).not.toBeNull();
      expect(isReadOnlyTool(`mcp__server__${key}`), key).toBe(false);
    }
    for (const key of [
      "browser__task",
      "apify__rag_web_browser",
      "apify__scrape_instagram",
      "apify__scrape_pinterest",
      "apify__scrape_reddit",
      "apify__scrape_tiktok",
      "web_search__search",
    ]) {
      expect(descriptions.get(key) ?? "", key).toMatch(DECLARED_COST);
    }
  });

  it("reads a new paid tool's own description as paid, however it words the price", () => {
    for (const description of [
      "Looks up a company. costs $0.02 per call.",
      "Looks up a company. Costs $0.02 per call",
      "Each lookup costs $1 per request.",
      "Looks up a company, billed by the vendor.",
      "Looks up a company. The vendor bills the workspace for each lookup.",
      "Looks up a company at $0.02 a call.",
      "Looks up a company; charged per call.",
    ]) {
      expect(declaredCost(description), description).not.toBeNull();
    }
    for (const description of [
      "Lists the product builds in this workspace and whether each is live.",
      "Reads one row from the company knowledge base.",
      "Returns campaign spend and cost per result for the date range.",
    ]) {
      expect(declaredCost(description), description).toBeNull();
    }
  });

  it("lists every free internal tool declared read, so a plain answer stays plain", () => {
    const missing = [...effects.entries()]
      .filter(([key, effect]) => effect === "read" && paidReason(key) === null && !isReadOnlyTool(key))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it("lists every sandbox read and ui show tool", () => {
    const missing = [
      ...[...CANONICAL_SANDBOX_READ_ONLY_TOOLS].filter((k) => !isReadOnlyTool(`mcp__${k}`)),
      ...Object.keys(SHOW_TOOLS).filter((t) => !isReadOnlyTool(`mcp__ui__${t}`)),
    ];
    expect(missing).toEqual([]);
  });
});
