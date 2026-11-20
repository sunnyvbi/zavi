
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SEARCH_MAX_K,
  TOOL_SEARCH_MAX_DEF_CHARS,
  TOOL_SEARCH_MAX_TOOLS,
  TOOL_SEARCH_START_CAP,
  _clearToolVectorCacheForTests,
  computeStartingSet,
  createToolSearch,
  keywordRank,
  toolNotFoundMessage,
  type IndexedTool,
} from "../tool-search";
import { canonicalizeDeclaredForSearch, isInjectedRunTool } from "../../tool-search-injected";

function t(name: string, description = `does ${name}`): IndexedTool {
  return {
    name,
    registeredName: name.replace(/[^a-zA-Z0-9]/g, "_"),
    serverId: name.split("__")[0],
    description,
    schemaText: "{}",
  };
}

const range = (n: number, p = "web_fetch__f") => Array.from({ length: n }, (_, i) => `${p}${i}`);

beforeEach(() => _clearToolVectorCacheForTests());

describe("computeStartingSet (T5)", () => {
  it("defaults: 50 tools / 60,000 definition chars (measured), 40 the start cap", () => {
    expect(TOOL_SEARCH_MAX_TOOLS).toBe(50);
    expect(TOOL_SEARCH_MAX_DEF_CHARS).toBe(60_000);
    expect(TOOL_SEARCH_START_CAP).toBe(40);
  });

  it("declared order, server + prefix wildcards expanded, unresolved names skipped", () => {
    const names = [
      "a__x",
      "github__list",
      "pipedream_hubspot__get",
      "github__merge",
      "pipedream_notion__read",
      "b__y",
    ];
    const got = computeStartingSet(names, {
      declaredTools: ["b__y", "github__*", "not__resolved", "pipedream_*__*"],
      injectedToolNames: [],
    });
    expect(got).toEqual(["b__y", "github__list", "github__merge", "pipedream_hubspot__get", "pipedream_notion__read"]);
  });

  it("injected tools come after declared, count inside the cap, and are never crowded out", () => {
    const names = [...range(100), "skill__load", "tenant_skill__r1", "slack__post_message"];
    const got = computeStartingSet(names, {
      declaredTools: range(100),
      injectedToolNames: ["skill__load", "tenant_skill__r1", "slack__post_message", "not__resolved"],
    });
    expect(got).toHaveLength(40);
    expect(got.slice(0, 37)).toEqual(range(37));
    expect(got.slice(37)).toEqual(["skill__load", "tenant_skill__r1", "slack__post_message"]);
  });

  it("no duplicates when a declared entry names an injected tool", () => {
    const got = computeStartingSet(["slack__post_message", "a__b"], {
      declaredTools: ["slack__post_message", "a__b"],
      injectedToolNames: ["slack__post_message"],
    });
    expect(got).toEqual(["a__b", "slack__post_message"]);
  });

  it("shadow engineer: bare declared sandbox verbs match the registered sandbox__<verb> tools", () => {
    const names = [...range(50), "sandbox__view", "sandbox__run_bash"];
    const got = computeStartingSet(names, {
      declaredTools: canonicalizeDeclaredForSearch(["view", "run_bash", "github__*"]),
      injectedToolNames: [],
    });
    expect(got).toEqual(["sandbox__view", "sandbox__run_bash"]);
  });

  it("no hints: first 40 in run order", () => {
    expect(computeStartingSet(range(60), undefined)).toEqual(range(40));
  });
});

describe("isInjectedRunTool", () => {
  it("skill__load, tenant_skill__*, the Slack baseline are injected; declared-style tools are not", () => {
    expect(isInjectedRunTool("skill__load")).toBe(true);
    expect(isInjectedRunTool("tenant_skill__pm__weekly")).toBe(true);
    expect(isInjectedRunTool("slack__post_message")).toBe(true);
    expect(isInjectedRunTool("github__search_code")).toBe(false);
    expect(isInjectedRunTool("web_search__search")).toBe(false);
  });
});

describe("keyword index", () => {
  it("name hits outrank description hits; no hit = not returned", () => {
    const tools = [
      t("github__list_pull_requests", "List PRs"),
      t("slack__post_message", "Post a message; can mention a pull request"),
      t("stripe__refund", "Refund a charge"),
    ];
    const r = keywordRank(tools, "pull requests");
    expect(r).toEqual([0, 1]);
  });
});

describe("createToolSearch", () => {
  const tools = [
    t("github__list_pull_requests", "List open pull requests"),
    t("github__merge_pull_request", "Merge a pull request"),
    t("meta_ads__get_insights", "Ad campaign performance insights"),
    ...range(10).map((n) => t(n)),
  ];

  it("add-only: search loads the returned tools; nothing is ever removed", async () => {
    const s = createToolSearch({ tools, startingSet: ["web_fetch__f0"] });
    expect([...s.loaded]).toEqual(["web_fetch__f0"]);
    const txt = await s.search("pull request", null);
    expect(txt).toContain("github__list_pull_requests");
    expect(s.isLoaded("github__list_pull_requests")).toBe(true);
    expect(s.isLoaded("web_fetch__f0")).toBe(true);
    await s.search("ad campaign insights", 1);
    expect(s.isLoaded("github__merge_pull_request")).toBe(true);
    expect(s.isLoaded("meta_ads__get_insights")).toBe(true);
  });

  it("only returns tools of this run (unknown capability -> no match, nothing loaded)", async () => {
    const s = createToolSearch({ tools, startingSet: [] });
    const txt = await s.search("payroll export", 15);
    expect(txt).toMatch(/^No tools match/);
    expect(s.loaded.size).toBe(0);
  });

  it("k is clamped to [1, 15]", async () => {
    const many = range(40).map((n) => t(n, "common capability"));
    const s = createToolSearch({ tools: many, startingSet: [] });
    const txt = await s.search("common capability", 999);
    expect(txt.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(SEARCH_MAX_K);
  });

  it("empty query returns guidance and loads nothing", async () => {
    const s = createToolSearch({ tools, startingSet: [] });
    expect(await s.search("   ", 5)).toMatch(/Provide a query/);
    expect(s.loaded.size).toBe(0);
  });

  it("parallel searches cannot jointly exceed the tool-count limit (search_tools counts)", async () => {
    const many = range(200).map((n) => t(n, "shared capability"));
    let call = 0;
    const embed = async (texts: string[]) => {
      const delay = (call++ % 5) * 3;
      await new Promise((r) => setTimeout(r, delay));
      return texts.map((_, i) => [1, (i % 7) / 7]);
    };
    const s = createToolSearch({ tools: many, startingSet: range(3), maxTools: 10, embed });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => s.search("shared capability", 15)),
    );
    expect(s.loaded.size + 1).toBe(10);
    expect(results.some((r) => r.includes("Tool limit reached; use what is loaded"))).toBe(true);
  });

  it("parallel searches cannot jointly exceed the definition-size limit", async () => {
    const many = range(200).map((n) => ({ ...t(n, "shared capability"), defChars: 1000 }));
    let call = 0;
    const embed = async (texts: string[]) => {
      await new Promise((r) => setTimeout(r, (call++ % 5) * 3));
      return texts.map((_, i) => [1, (i % 7) / 7]);
    };
    const s = createToolSearch({ tools: many, startingSet: [], maxTools: 1000, maxDefChars: 10_000, embed });
    await Promise.all(Array.from({ length: 8 }, () => s.search("shared capability", 15)));
    expect(s.loaded.size).toBeGreaterThan(0);
    expect(s.loaded.size).toBeLessThanOrEqual(9);
    expect(s.loaded.size * 1000).toBeLessThanOrEqual(10_000);
  });

  it("under 50 tools but over 60,000 chars: the default size limit caps the set", async () => {
    const big = range(45).map((n) => ({ ...t(n, "shared capability"), defChars: 3000 }));
    const s = createToolSearch({ tools: big, startingSet: range(40) });
    expect(s.loaded.size).toBeLessThan(20);
    expect(s.loaded.size * 3000).toBeLessThanOrEqual(TOOL_SEARCH_MAX_DEF_CHARS);
    expect(await s.search("shared capability", 15)).toContain("Tool limit reached; use what is loaded");
  });

  it("the starting set respects the count limit and trims declared tools from the END, keeping pinned injected tools", () => {
    const s = createToolSearch({
      tools: [...range(50), "skill__load"].map((n) => t(n)),
      startingSet: [...range(30), "skill__load"],
      pinned: ["skill__load"],
      maxTools: 20,
    });
    expect(s.loaded.size).toBe(19);
    expect(s.isLoaded("skill__load")).toBe(true);
    expect(s.isLoaded("web_fetch__f0")).toBe(true);
    expect(s.isLoaded("web_fetch__f17")).toBe(true);
    expect(s.isLoaded("web_fetch__f18")).toBe(false);
  });

  it("k counts UNLOADED results: top 8 already loaded, the 9th unloaded gets loaded", async () => {
    const same = range(12).map((n) => t(n, "common capability"));
    const s = createToolSearch({ tools: same, startingSet: range(8) });
    const txt = await s.search("common capability", 1);
    expect(s.isLoaded("web_fetch__f8")).toBe(true);
    expect(txt).toContain("Loaded (callable from your next step):\n- web_fetch__f8:");
  });

  it("a never-resolving embedder falls back to keyword within the deadline", async () => {
    const log = vi.fn();
    const embed = () => new Promise<number[][]>(() => {});
    const s = createToolSearch({ tools, startingSet: [], embed, log, embedDeadlineMs: 50 });
    const t0 = Date.now();
    const txt = await s.search("list open pull requests", 3);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(txt).toContain("github__list_pull_requests");
    expect(log.mock.calls[0][0]).toMatchObject({ event: "tool_search_embed_fallback", error: "ToolSearchEmbedTimeout" });
  });

  it("not-found message: unloaded vs loaded-this-step vs never given", async () => {
    const s = createToolSearch({ tools, startingSet: [] });
    expect(toolNotFoundMessage(s, "github__list_pull_requests")).toMatch(/is not loaded yet, so it did not run/);
    await s.search("list open pull requests", 1);
    expect(toolNotFoundMessage(s, "github__list_pull_requests")).toMatch(/It is loaded now: call it again/);
    expect(toolNotFoundMessage(s, "stripe__refund")).toMatch(/is not available/);
  });
});
