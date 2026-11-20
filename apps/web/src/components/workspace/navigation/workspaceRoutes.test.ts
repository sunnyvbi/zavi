import { describe, expect, it } from "vitest";
import type { TabDescriptor } from "@/lib/workspace/types";
import {
  isBareWorkspaceLanding,
  resolveWorkspaceTab,
  workspaceSkipHref,
  workspaceTabHref,
} from "./workspaceRoutes";

const T = "97a9c799-3a6e-418f-928b-5bb0f886af85";

describe("workspaceSkipHref", () => {
  it("preserves onboarding navigation when setup redirects back to the growth workspace", () => {
    const tab: TabDescriptor = { id: "growth", kind: "autopilot", title: "Growth", payload: { kind: "autopilot" }, dirty: false, pinned: false };
    const href = workspaceTabHref(tab, "/workspace?tab=brain&setupStep=connect-apps&connectSearch=google&connectApp=stripe&composio_error=google_analytics#integrations");
    const params = new URL(href, "https://zavi.test").searchParams;
    expect(Object.fromEntries(params)).toEqual({ tab: "growth-strategy", setupStep: "connect-apps", connectSearch: "google", connectApp: "stripe", composio_error: "google_analytics" });
  });
  it("always targets main in the current SPA destination", () => {
    expect(workspaceSkipHref("/workspace?tab=build&build=b1")).toBe(
      "/workspace?tab=build&build=b1#zavi-main",
    );
    expect(workspaceSkipHref("/workspace?tab=artifacts#old")).toBe(
      "/workspace?tab=artifacts#zavi-main",
    );
  });
});

function agentTab(slug: string, threadId: string | null): TabDescriptor {
  return {
    id: `t-${slug}`,
    kind: "agent",
    title: slug,
    payload: { kind: "agent", slug, threadId },
    dirty: false,
    pinned: false,
  };
}

describe("isBareWorkspaceLanding (#18)", () => {
  it("is true only for the plain /workspace URL", () => {
    expect(isBareWorkspaceLanding("/workspace")).toBe(true);
    expect(isBareWorkspaceLanding("/workspace/")).toBe(true);
  });

  it("leaves every deep link alone", () => {
    for (const href of [
      "/workspace?agent=operator",
      "/workspace?agent=operator&thread=97a9c799-3a6e-418f-928b-5bb0f886af85",
      "/workspace?tab=settings",
      "/workspace?tab=build&build=97a9c799-3a6e-418f-928b-5bb0f886af85",
      "/workspace?tab=artifacts&q=deck",
      "/workspace#integrations",
      "/workspace?connected=slack",
      "/workspace/settings",
      `/workspace/${T}`,
    ]) {
      expect(isBareWorkspaceLanding(href)).toBe(false);
    }
  });
});

describe("workspaceTabHref", () => {
  it("puts a bound conversation in the path with no agent param", () => {
    expect(workspaceTabHref(agentTab("operator", T), "/workspace")).toBe(
      `/workspace/${T}`,
    );
    expect(workspaceTabHref(agentTab("engineer", T), "/workspace")).toBe(
      `/workspace/${T}`,
    );
  });

  it("sends the operator's fresh chat to the bare /workspace", () => {
    expect(
      workspaceTabHref(agentTab("operator", null), `/workspace/${T}`),
    ).toBe("/workspace");
  });

  it("keeps optional query state on the same conversation only", () => {
    expect(
      workspaceTabHref(agentTab("operator", T), `/workspace/${T}?tab=insights`),
    ).toBe(`/workspace/${T}?tab=insights`);
    expect(
      workspaceTabHref(
        agentTab("operator", null),
        `/workspace/${T}?tab=insights`,
      ),
    ).toBe("/workspace");
  });
});

describe("resolveWorkspaceTab", () => {
  it("resolves /workspace/<threadId> to the tab that owns the thread", () => {
    const owner = agentTab("engineer", T);
    expect(resolveWorkspaceTab([owner], `/workspace/${T}`).id).toBe(owner.id);
  });

  it("ignores ?agent= on a thread path", () => {
    const owner = agentTab("engineer", T);
    expect(
      resolveWorkspaceTab([owner], `/workspace/${T}?agent=operator`).id,
    ).toBe(owner.id);
  });

  it("resolves the bare /workspace to the operator's fresh chat", () => {
    expect(resolveWorkspaceTab([], "/workspace").payload).toEqual({
      kind: "agent",
      slug: "operator",
      threadId: null,
    });
  });

  it("a Home tab bound to a thread owns /workspace/<threadId> (Past chats 'from Home')", () => {
    const home: TabDescriptor = {
      id: "home-default",
      kind: "home",
      title: "Home",
      payload: { kind: "home", threadId: T },
      dirty: false,
      pinned: true,
    };
    const href = workspaceTabHref(home, "/workspace?tab=growth-strategy");
    expect(href).toBe(`/workspace/${T}`);
    expect(resolveWorkspaceTab([home], href).id).toBe("home-default");
    expect(
      workspaceTabHref({ ...home, payload: { kind: "home" } }, "/workspace"),
    ).toBe("/workspace?tab=board");
    const op = agentTab("operator", T);
    expect(resolveWorkspaceTab([home, op], href).id).toBe(op.id);
  });

  it("still reads pre-cutover ?agent=&thread= links", () => {
    expect(
      resolveWorkspaceTab([], `/workspace?agent=engineer&thread=${T}`).payload,
    ).toEqual({ kind: "agent", slug: "engineer", threadId: T });
  });

});

describe("the three thread states survive the URL", () => {
  it("?agent= with no thread leaves threadId ABSENT, not blank", () => {
    const payload = resolveWorkspaceTab([], "/workspace?agent=engineer")
      .payload as { threadId?: string | null };
    expect("threadId" in payload && payload.threadId !== undefined).toBe(false);
  });

  it("?thread=new is a blank tab, which is NOT the same as asking for nothing", () => {
    expect(
      resolveWorkspaceTab([], "/workspace?agent=engineer&thread=new").payload,
    ).toEqual({ kind: "agent", slug: "engineer", threadId: null });
  });

  it("a thread path binds to that thread", () => {
    expect(resolveWorkspaceTab([], `/workspace/${T}`).payload).toEqual({
      kind: "agent",
      slug: "operator",
      threadId: null,
    });
    const owner = agentTab("engineer", T);
    expect(resolveWorkspaceTab([owner], `/workspace/${T}`).id).toBe(owner.id);
  });

  it("a bare agent link focuses the conversation already open, not a new blank tab", () => {
    const bound = agentTab("engineer", T);
    expect(resolveWorkspaceTab([bound], "/workspace?agent=engineer").id).toBe(
      bound.id,
    );
  });

  it("round-trips a blank tab, so reloading a draft does not load the latest thread", () => {
    const blank = agentTab("engineer", null);
    const href = workspaceTabHref(blank, "/workspace");
    expect(href).toBe("/workspace?agent=engineer&thread=new");
    expect(
      (resolveWorkspaceTab([], href).payload as { threadId?: string | null })
        .threadId,
    ).toBeNull();
  });

  it("keeps the operator's blank chat on the bare /workspace new-task URL", () => {
    expect(workspaceTabHref(agentTab("operator", null), "/workspace")).toBe(
      "/workspace",
    );
  });
});

describe("the Growth Strategy tab in the URL", () => {
  const growthStrategy: TabDescriptor = {
    id: "autopilot-default",
    kind: "autopilot",
    title: "Growth Strategy",
    payload: { kind: "autopilot" },
    dirty: false,
    pinned: false,
  };

  it("is addressed by its name, never by the internal kind", () => {
    const href = workspaceTabHref(growthStrategy, "/workspace");
    expect(href).toBe("/workspace?tab=growth-strategy");
    expect(href).not.toContain("autopilot");
  });

  it("resolves its own address and the pre-rename one to the same tab", () => {
    for (const href of ["/workspace?tab=growth-strategy", "/workspace?tab=autopilot"]) {
      expect(resolveWorkspaceTab([growthStrategy], href).id, href).toBe("autopilot-default");
    }
  });
});

describe("workspaceTabHref channels deep link (Next tiles)", () => {
  function channelsTab(channel?: string): TabDescriptor {
    return {
      id: "t-channels",
      kind: "channels",
      title: "Growth Channels",
      payload: channel ? { kind: "channels", channel } : { kind: "channels" },
      dirty: false,
      pinned: false,
    };
  }

  it("a channel on the payload wins over the live URL's channel", () => {
    expect(
      workspaceTabHref(channelsTab("seo"), "/workspace?tab=channels&channel=reddit"),
    ).toBe("/workspace?tab=channels&channel=seo");
  });

  it("names the channel when opened from elsewhere", () => {
    expect(workspaceTabHref(channelsTab("seo"), "/workspace")).toBe(
      "/workspace?tab=channels&channel=seo",
    );
  });

  it("keeps the UGC hub drawer params (a Stripe return lands on a drawer)", () => {
    expect(
      workspaceTabHref(channelsTab(), "/workspace?tab=channels&channel=ugc&drawer=job&job=o1&paid=1"),
    ).toBe("/workspace?tab=channels&channel=ugc&drawer=job&job=o1&paid=1");
  });

  it("keeps a card deep link (?action=) on its own channel, drops it on another", () => {
    expect(workspaceTabHref(channelsTab(), "/workspace?tab=channels&channel=google_ads&action=a1")).toBe(
      "/workspace?tab=channels&channel=google_ads&action=a1",
    );
    expect(workspaceTabHref(channelsTab("seo"), "/workspace?tab=channels&channel=google_ads&action=a1")).toBe(
      "/workspace?tab=channels&channel=seo",
    );
  });

  it("without a payload channel the live one is still preserved", () => {
    expect(
      workspaceTabHref(channelsTab(), "/workspace?tab=channels&channel=reddit"),
    ).toBe("/workspace?tab=channels&channel=reddit");
  });
});

describe("Agent Builder deep link (S6)", () => {
  const ID = "44444444-4444-4444-8444-444444444444";
  const builderTab: TabDescriptor = {
    id: "agent-builder-default",
    kind: "agent-builder",
    title: "Agent Builder",
    payload: { kind: "agent-builder" },
    dirty: false,
    pinned: false,
  };

  it("?agent= on the Builder page is a custom agent id, never a chat slug", () => {
    const tab = resolveWorkspaceTab([builderTab], `/workspace?tab=agent-builder&agent=${ID}`);
    expect(tab.id).toBe("agent-builder-default");
    expect(tab.payload).toEqual({ kind: "agent-builder", agentId: ID });
  });

  it("the bare Builder URL is the list", () => {
    expect(resolveWorkspaceTab([builderTab], "/workspace?tab=agent-builder").payload).toEqual({
      kind: "agent-builder",
      agentId: null,
    });
  });

  it("a junk id opens the list, not a chat", () => {
    expect(resolveWorkspaceTab([], "/workspace?tab=agent-builder&agent=../x").payload).toEqual({
      kind: "agent-builder",
      agentId: null,
    });
  });

  it("round-trips through the href (the S2 notice link shape)", () => {
    const href = workspaceTabHref({ ...builderTab, payload: { kind: "agent-builder", agentId: ID } }, "/workspace");
    expect(href).toBe(`/workspace?tab=agent-builder&agent=${ID}`);
    expect(workspaceTabHref(builderTab, href)).toBe("/workspace?tab=agent-builder");
  });

  it("?run= opens one run's results page and round-trips (the result email link shape)", () => {
    const RUN = "55555555-5555-4555-8555-555555555555";
    const url = `/workspace?tab=agent-builder&agent=${ID}&run=${RUN}`;
    const tab = resolveWorkspaceTab([builderTab], url);
    expect(tab.payload).toEqual({ kind: "agent-builder", agentId: ID, runId: RUN });
    expect(workspaceTabHref(tab, "/workspace")).toBe(url);
  });

  it("a junk run id, or a run without an agent, is dropped", () => {
    expect(resolveWorkspaceTab([], `/workspace?tab=agent-builder&agent=${ID}&run=../x`).payload).toEqual({
      kind: "agent-builder",
      agentId: ID,
    });
    expect(
      resolveWorkspaceTab([], "/workspace?tab=agent-builder&run=55555555-5555-4555-8555-555555555555").payload,
    ).toEqual({ kind: "agent-builder", agentId: null });
  });
});

describe("Data access deep link (private data S2, the chat 'See query' link)", () => {
  const ID = "66666666-6666-4666-8666-666666666666";
  const href = `/workspace?tab=brain&access=${ID}#data-access`;

  it("resolves to the brain (Connectors) tab", () => {
    expect(resolveWorkspaceTab([], href).payload).toEqual({ kind: "brain" });
    expect(resolveWorkspaceTab([], "/workspace#data-access").payload).toEqual({ kind: "brain" });
  });

  it("keeps the entry id and the #data-access hash when the tab URL is rebuilt", () => {
    const tab = resolveWorkspaceTab([], href);
    expect(workspaceTabHref(tab, href)).toBe(href);
  });

  it("drops the entry id when another tab is opened", () => {
    expect(workspaceTabHref(agentTab("operator", T), href)).toBe(`/workspace/${T}`);
  });
});

describe("the Needs you tab and decision focus in the URL (2026-10-17)", () => {
  const D = "11111111-2222-4333-8444-555555555555";
  const tab = (kind: "needs-you" | "autopilot", decision?: string): TabDescriptor => ({
    id: `${kind}-default`,
    kind,
    title: kind,
    payload: decision ? { kind, decision } : { kind },
    dirty: false,
    pinned: false,
  });

  it("writes ?tab=needs-you and the payload's decision", () => {
    expect(workspaceTabHref(tab("needs-you"), "/workspace")).toBe("/workspace?tab=needs-you");
    expect(workspaceTabHref(tab("needs-you", D), "/workspace")).toBe(`/workspace?tab=needs-you&decision=${D}`);
    expect(workspaceTabHref(tab("autopilot", D), "/workspace")).toBe(`/workspace?tab=growth-strategy&decision=${D}`);
  });

  it("keeps a live ?decision= on the same page, drops it on another, and never writes junk", () => {
    expect(workspaceTabHref(tab("needs-you"), `/workspace?tab=needs-you&decision=${D}`)).toBe(`/workspace?tab=needs-you&decision=${D}`);
    expect(workspaceTabHref(tab("autopilot"), `/workspace?tab=growth-strategy&decision=${D}`)).toBe(`/workspace?tab=growth-strategy&decision=${D}`);
    expect(workspaceTabHref(tab("autopilot"), `/workspace?tab=needs-you&decision=${D}`)).toBe("/workspace?tab=growth-strategy");
    expect(workspaceTabHref(tab("needs-you", "not-a-uuid"), "/workspace")).toBe("/workspace?tab=needs-you");
  });

  it("keeps the Growth side chat's live ?chat= on Growth only, and never junk", () => {
    expect(workspaceTabHref(tab("autopilot"), `/workspace?tab=growth-strategy&chat=${D}`)).toBe(`/workspace?tab=growth-strategy&chat=${D}`);
    expect(workspaceTabHref(tab("autopilot"), `/workspace?tab=needs-you&chat=${D}`)).toBe("/workspace?tab=growth-strategy");
    expect(workspaceTabHref(tab("needs-you"), `/workspace?tab=needs-you&chat=${D}`)).toBe("/workspace?tab=needs-you");
    expect(workspaceTabHref(tab("autopilot"), "/workspace?tab=growth-strategy&chat=nope")).toBe("/workspace?tab=growth-strategy");
  });

  it("reads ?decision= back into the payload, on a new or an open tab", () => {
    expect(resolveWorkspaceTab([], `/workspace?tab=needs-you&decision=${D}`)).toMatchObject({ kind: "needs-you", title: "Needs you", payload: { kind: "needs-you", decision: D } });
    expect(resolveWorkspaceTab([tab("autopilot")], `/workspace?tab=growth-strategy&decision=${D}`).payload).toEqual({ kind: "autopilot", decision: D });
    expect(resolveWorkspaceTab([], "/workspace?tab=needs-you&decision=nope").payload).toEqual({ kind: "needs-you" });
  });

  it("a channel opened with a card names the lane's ?action= link", () => {
    const channels: TabDescriptor = { id: "c", kind: "channels", title: "c", payload: { kind: "channels", channel: "seo", action: D }, dirty: false, pinned: false };
    expect(workspaceTabHref(channels, "/workspace?tab=needs-you")).toBe(`/workspace?tab=channels&channel=seo&action=${D}`);
  });
});
