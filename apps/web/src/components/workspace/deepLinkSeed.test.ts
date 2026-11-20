import { describe, it, expect } from "vitest";
import {
  buildDeepLinkSeed,
  deepLinkTabId,
  resolveWorkspaceAgentSlug,
  WORKSPACE_AGENT_SLUG_RE,
  WORKSPACE_UUID_RE,
} from "./deepLinkSeed";
import type { TabDescriptor } from "@/lib/workspace/types";

const home: TabDescriptor = {
  id: "home-default",
  kind: "home",
  title: "Home",
  payload: { kind: "home" },
  dirty: false,
  pinned: true,
};

const agentTab = (
  slug: string,
  threadId?: string | null,
  id = `tab-${slug}-${threadId ?? "x"}`,
): TabDescriptor => ({
  id,
  kind: "agent",
  title: slug,
  payload:
    threadId === undefined
      ? { kind: "agent", slug }
      : { kind: "agent", slug, threadId },
  dirty: false,
  pinned: false,
});

const T1 = "04f60dd9-7869-4daa-bb52-f075e7205018";
const T2 = "f8fa7bc7-c671-4f00-997f-cdfffefdb0eb";

describe("WORKSPACE_UUID_RE", () => {
  it("accepts a v4-ish uuid, rejects junk / 'new'", () => {
    expect(WORKSPACE_UUID_RE.test(T1)).toBe(true);
    expect(WORKSPACE_UUID_RE.test("new")).toBe(false);
    expect(WORKSPACE_UUID_RE.test("' OR 1=1")).toBe(false);
    expect(WORKSPACE_UUID_RE.test("")).toBe(false);
  });
});

describe("WORKSPACE_AGENT_SLUG_RE", () => {
  it("accepts workspace agent slugs and rejects unsafe path/query input", () => {
    expect(WORKSPACE_AGENT_SLUG_RE.test("fundraising")).toBe(true);
    expect(WORKSPACE_AGENT_SLUG_RE.test("content-design")).toBe(true);
    expect(WORKSPACE_AGENT_SLUG_RE.test("content-seo")).toBe(true);
    expect(WORKSPACE_AGENT_SLUG_RE.test("agent_2")).toBe(false);
    expect(WORKSPACE_AGENT_SLUG_RE.test("2-agent")).toBe(false);
    expect(WORKSPACE_AGENT_SLUG_RE.test("../fundraising")).toBe(false);
    expect(WORKSPACE_AGENT_SLUG_RE.test("fundraising?tab=settings")).toBe(false);
    expect(WORKSPACE_AGENT_SLUG_RE.test("")).toBe(false);
  });
});

describe("resolveWorkspaceAgentSlug", () => {
  it("prefers a bootstrap-known slug", () => {
    expect(
      resolveWorkspaceAgentSlug("fundraising", ["engineer", "fundraising"]),
    ).toBe("fundraising");
  });

  it("keeps a safe deep-link slug when the caller opts into stale-bootstrap fallback", () => {
    expect(
      resolveWorkspaceAgentSlug("fundraising", [], {
        allowSyntaxFallback: true,
      }),
    ).toBe("fundraising");
  });

  it("rejects a missing slug when fallback is disabled or the filtered tree is non-empty", () => {
    expect(resolveWorkspaceAgentSlug("fundraising", [])).toBeUndefined();
    expect(
      resolveWorkspaceAgentSlug("fundraising", ["engineer"], {
        allowSyntaxFallback: true,
      }),
    ).toBeUndefined();
  });

  it("rejects malformed or non-string values", () => {
    expect(
      resolveWorkspaceAgentSlug("../fundraising", ["engineer"]),
    ).toBeUndefined();
    expect(
      resolveWorkspaceAgentSlug(["fundraising"], ["engineer"]),
    ).toBeUndefined();
    expect(resolveWorkspaceAgentSlug(null, ["engineer"])).toBeUndefined();
  });
});

describe("buildDeepLinkSeed", () => {
  it("no slug → base unchanged", () => {
    const base = [home];
    expect(buildDeepLinkSeed(base, undefined, null)).toBe(base);
    expect(buildDeepLinkSeed(base, undefined, T1)).toBe(base);
  });

  it("slug + explicit thread, no existing tab → appends a tab BOUND to that thread", () => {
    const out = buildDeepLinkSeed([home], "engineer", T1);
    expect(out).toHaveLength(2);
    const tab = out[1];
    expect(tab.id).toBe(deepLinkTabId("engineer"));
    expect(tab.payload).toEqual({
      kind: "agent",
      slug: "engineer",
      threadId: T1,
    });
  });

  it("slug, NO thread → appends tab with NO threadId (legacy most-recent default preserved)", () => {
    const out = buildDeepLinkSeed([home], "engineer", null);
    expect(out).toHaveLength(2);
    expect(out[1].payload).toEqual({ kind: "agent", slug: "engineer" });
    expect(
      (out[1].payload as { threadId?: unknown }).threadId,
    ).toBeUndefined();
  });

  it("explicit thread + an EXISTING tab for the SAME thread → base unchanged (focus it, no dup)", () => {
    const base = [home, agentTab("engineer", T1)];
    expect(buildDeepLinkSeed(base, "engineer", T1)).toBe(base);
  });

  it("explicit thread but only a DIFFERENT-thread same-agent tab exists → appends the requested-thread tab (no hijack)", () => {
    const base = [home, agentTab("engineer", T2)];
    const out = buildDeepLinkSeed(base, "engineer", T1);
    expect(out).toHaveLength(3);
    expect(out[2].payload).toEqual({
      kind: "agent",
      slug: "engineer",
      threadId: T1,
    });
  });

  it("explicit thread + an undefined-threadId same-agent tab → still appends bound tab (undefined != requested)", () => {
    const base = [home, agentTab("engineer", undefined)];
    const out = buildDeepLinkSeed(base, "engineer", T1);
    expect(out).toHaveLength(3);
    expect((out[2].payload as { threadId?: string }).threadId).toBe(T1);
  });

  it("no explicit thread + existing same-agent tab → base unchanged (legacy focus-by-slug)", () => {
    const base = [home, agentTab("engineer", T2)];
    expect(buildDeepLinkSeed(base, "engineer", null)).toBe(base);
  });

  it("2nd ?thread=new after the deep-link tab is thread-bound → appends a DISTINCT-id tab (no stale-tab reopen, no duplicate key)", () => {
    const bound = agentTab("research", T1, deepLinkTabId("research"));
    const base = [home, bound];
    const out = buildDeepLinkSeed(base, "research", "new");
    expect(out).toHaveLength(3);
    expect(out[2].payload).toEqual({ kind: "agent", slug: "research", threadId: null });
    expect(out[2].id).not.toBe(deepLinkTabId("research"));
    expect(out[2].id).toBe(`${deepLinkTabId("research")}-1`);
    const ids = out.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("?thread=new with an EXISTING fresh (threadId:null) deep-link tab → base unchanged (reload focuses it, no dup)", () => {
    const fresh = agentTab("research", null, deepLinkTabId("research"));
    const base = [home, fresh];
    expect(buildDeepLinkSeed(base, "research", "new")).toBe(base);
  });
});
