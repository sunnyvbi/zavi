import { describe, expect, it } from "vitest";
import { reviveBlankAgentThreads } from "./reviveBlankThreads";
import { buildDeepLinkSeed, deepLinkTabId } from "./deepLinkSeed";
import type { TabDescriptor } from "@/lib/workspace/types";

const home: TabDescriptor = {
  id: "home",
  kind: "home",
  title: "Home",
  payload: { kind: "home" },
  dirty: false,
  pinned: true,
};

function agentTab(
  slug: string,
  threadId: string | null | undefined,
  id = `tab-${slug}`,
): TabDescriptor {
  return {
    id,
    kind: "agent",
    title: slug,
    payload:
      threadId === undefined
        ? { kind: "agent", slug }
        : { kind: "agent", slug, threadId },
    dirty: false,
    pinned: false,
  } as TabDescriptor;
}

const T1 = "11111111-1111-4111-8111-111111111111";

describe("reviveBlankAgentThreads", () => {
  it("drops threadId on a restored blank agent tab (→ resolve latest)", () => {
    const out = reviveBlankAgentThreads([home, agentTab("pm", null)]);
    expect(out[1].payload).toEqual({ kind: "agent", slug: "pm" });
    expect("threadId" in (out[1].payload as object)).toBe(false);
  });

  it("leaves thread-bound and already-unbound agent tabs untouched", () => {
    const base = [home, agentTab("pm", T1), agentTab("engineer", undefined)];
    expect(reviveBlankAgentThreads(base)).toBe(base);
  });

  it("leaves non-agent tabs alone (dispute-detail null is a valid unbound state)", () => {
    const dispute = {
      id: "d1",
      kind: "dispute-detail",
      title: "Dispute",
      payload: { kind: "dispute-detail", disputeId: "dp_1", threadId: null },
      dirty: false,
      pinned: false,
    } as unknown as TabDescriptor;
    expect(reviveBlankAgentThreads([home, dispute])).toEqual([home, dispute]);
  });

  it("preserves the DEEP-LINK blank tab for an active ?thread=new slug", () => {
    const base = [
      home,
      agentTab("pm", null, deepLinkTabId("pm")),
      agentTab("research", null),
    ];
    const out = reviveBlankAgentThreads(base, "pm");
    expect(out[1].payload).toEqual({ kind: "agent", slug: "pm", threadId: null });
    expect(out[2].payload).toEqual({ kind: "agent", slug: "research" });
  });

  it("revives OTHER same-slug blanks under ?thread=new — carve-out is id-scoped, not slug-wide", () => {
    const base = [
      home,
      agentTab("pm", null, "uuid-stale-pm"),
      agentTab("pm", null, "uuid-stale-pm-2"),
      agentTab("pm", null, deepLinkTabId("pm")),
    ];
    const out = reviveBlankAgentThreads(base, "pm");
    expect(out[1].payload).toEqual({ kind: "agent", slug: "pm" });
    expect(out[2].payload).toEqual({ kind: "agent", slug: "pm" });
    expect(out[3].payload).toEqual({ kind: "agent", slug: "pm", threadId: null });
    const blanks = out.filter(
      (t) =>
        t.kind === "agent" &&
        (t.payload as { threadId?: string | null }).threadId === null,
    );
    expect(blanks).toHaveLength(1);
    expect(blanks[0].id).toBe(deepLinkTabId("pm"));
  });

  it("revives a '+' blank even when its slug matches the ?thread=new deep-link", () => {
    const base = [home, agentTab("pm", null, "uuid-from-plus-button")];
    const out = reviveBlankAgentThreads(base, "pm");
    expect(out[1].payload).toEqual({ kind: "agent", slug: "pm" });
  });

  it("keeps buildDeepLinkSeed's no-duplicate invariant on a repeat ?thread=new load", () => {
    const fresh = agentTab("research", null, deepLinkTabId("research"));
    const base = [home, fresh];
    const revived = reviveBlankAgentThreads(base, "research");
    expect(buildDeepLinkSeed(revived, "research", "new")).toBe(revived);
  });
});
