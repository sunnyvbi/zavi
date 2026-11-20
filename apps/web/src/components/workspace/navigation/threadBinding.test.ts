import { describe, it, expect } from "vitest";
import type { TabDescriptor } from "@/lib/workspace/types";
import {
  activeChatBinding,
  agentThreadOpenStep,
  bindActivatesTab,
  operatorChatBinding,
  payloadOwnsThread,
  planThreadBind,
} from "./threadBinding";
import { workspaceTabHref } from "./workspaceRoutes";

const ZAVI = "operator";

function tab(payload: TabDescriptor["payload"], id = "t1"): TabDescriptor {
  return { id, kind: payload.kind as TabDescriptor["kind"], title: "t", payload, dirty: false, pinned: false };
}

describe("payloadOwnsThread", () => {
  it("accepts the pinned home tab — it renders the operator chat in place", () => {
    expect(payloadOwnsThread({ kind: "home" })).toBe(true);
  });

  it("accepts agent and dispute-detail tabs", () => {
    expect(payloadOwnsThread({ kind: "agent", slug: ZAVI })).toBe(true);
    expect(
      payloadOwnsThread({ kind: "dispute-detail", disputeId: "du_1", threadId: null }),
    ).toBe(true);
  });

  it("accepts the Growth tab, so its CGO chat survives leaving the page", () => {
    expect(payloadOwnsThread({ kind: "autopilot" })).toBe(true);
  });

  it("rejects tabs with no conversation of their own", () => {
    expect(payloadOwnsThread({ kind: "analytics" })).toBe(false);
    expect(payloadOwnsThread({ kind: "settings" })).toBe(false);
  });

  it("accepts a build tab, whose chat sits beside the app", () => {
    expect(payloadOwnsThread({ kind: "build", sessionId: null })).toBe(true);
    expect(
      payloadOwnsThread({ kind: "build", sessionId: "s1", threadId: "t1" }),
    ).toBe(true);
  });

  it("binds a build tab's chat to the home agent, fresh until a send", () => {
    expect(activeChatBinding(tab({ kind: "build", sessionId: "s1" }), ZAVI)).toEqual({
      slug: ZAVI,
      threadId: null,
    });
    expect(
      activeChatBinding(tab({ kind: "build", sessionId: "s1", threadId: "t1" }), ZAVI),
    ).toEqual({ slug: ZAVI, threadId: "t1" });
  });
});

describe("operatorChatBinding", () => {
  it("treats an unbound home tab as the operator chat with nothing bound yet", () => {
    expect(operatorChatBinding(tab({ kind: "home" }), ZAVI)).toEqual({
      isOperatorChat: true,
      threadId: null,
    });
  });

  it("surfaces the thread a home tab bound after its first send", () => {
    expect(
      operatorChatBinding(tab({ kind: "home", threadId: "ce5063b6" }), ZAVI),
    ).toEqual({ isOperatorChat: true, threadId: "ce5063b6" });
  });

  it("surfaces an agent tab's thread, preserving resolve-latest (undefined)", () => {
    expect(operatorChatBinding(tab({ kind: "agent", slug: ZAVI }), ZAVI)).toEqual({
      isOperatorChat: true,
      threadId: undefined,
    });
    expect(
      operatorChatBinding(tab({ kind: "agent", slug: ZAVI, threadId: "abc" }), ZAVI),
    ).toEqual({ isOperatorChat: true, threadId: "abc" });
  });

  it("ignores another agent's chat and non-chat tabs, and keys them all to a stable null", () => {
    expect(
      operatorChatBinding(tab({ kind: "agent", slug: "engineer", threadId: "x" }), ZAVI),
    ).toEqual({ isOperatorChat: false, threadId: null });
    expect(operatorChatBinding(tab({ kind: "analytics" }), ZAVI)).toEqual({
      isOperatorChat: false,
      threadId: null,
    });
    expect(operatorChatBinding(undefined, ZAVI)).toEqual({
      isOperatorChat: false,
      threadId: null,
    });
  });
});

describe("agentThreadOpenStep", () => {
  const op = (id: string, threadId: string | null) => tab({ kind: "agent", slug: ZAVI, threadId }, id);
  const eng = (id: string, threadId: string | null) => tab({ kind: "agent", slug: "engineer", threadId }, id);
  const home = (threadId?: string | null) => tab({ kind: "home", ...(threadId === undefined ? {} : { threadId }) }, "h");
  it("opens a new tab when the agent has none", () => {
    expect(agentThreadOpenStep([home()], "engineer", "th")).toEqual({ kind: "open" });
    expect(agentThreadOpenStep([], ZAVI, "th")).toEqual({ kind: "open" });
  });
  it("focuses the tab already showing the thread", () => {
    expect(agentThreadOpenStep([eng("a", "x"), eng("b", "th")], "engineer", "th")).toEqual({ kind: "activate", tabId: "b" });
    expect(agentThreadOpenStep([home(), op("a", "x"), op("b", "th")], ZAVI, "th")).toEqual({ kind: "activate", tabId: "b" });
  });
  it("otherwise binds it into the agent's newest tab", () => {
    expect(agentThreadOpenStep([eng("a", "x"), eng("b", null)], "engineer", "th")).toEqual({ kind: "bind", tabId: "b" });
    expect(agentThreadOpenStep([op("a", "x"), op("b", null)], ZAVI, "th")).toEqual({ kind: "bind", tabId: "b" });
  });
  it("with preferHome, an operator thread opens on the pinned Home tab, not a new operator tab", () => {
    const preferHome = { preferHome: true };
    expect(agentThreadOpenStep([home(), tab({ kind: "autopilot" }, "g")], ZAVI, "th", preferHome)).toEqual({ kind: "bind", tabId: "h" });
    expect(agentThreadOpenStep([home("x"), op("a", "y")], ZAVI, "th", preferHome)).toEqual({ kind: "bind", tabId: "h" });
    expect(agentThreadOpenStep([home("th")], ZAVI, "th", preferHome)).toEqual({ kind: "activate", tabId: "h" });
    expect(agentThreadOpenStep([home(), op("a", "th")], ZAVI, "th", preferHome)).toEqual({ kind: "activate", tabId: "a" });
  });
  it("without preferHome (sidebar History), an operator thread keeps the agent-tab rule", () => {
    expect(agentThreadOpenStep([home(), tab({ kind: "autopilot" }, "g")], ZAVI, "th")).toEqual({ kind: "open" });
    expect(agentThreadOpenStep([home("x"), op("a", "y")], ZAVI, "th")).toEqual({ kind: "bind", tabId: "a" });
    expect(agentThreadOpenStep([home("th")], ZAVI, "th")).toEqual({ kind: "open" });
  });
});

describe("bindActivatesTab", () => {
  it("activates the pinned Home tab when the caller asks (Past chats 'from Home')", () => {
    expect(bindActivatesTab("home", true, false)).toBe(true);
  });
  it("leaves the URL alone for a send from Home", () => {
    expect(bindActivatesTab("home", false, true)).toBe(false);
  });
  it("navigates an on-screen Home that is being unbound", () => {
    expect(bindActivatesTab("home", false, true, true)).toBe(true);
    expect(bindActivatesTab("home", false, false, true)).toBe(false);
  });
  it("keeps agent and build tabs following when asked or on screen", () => {
    expect(bindActivatesTab("agent", false, true)).toBe(true);
    expect(bindActivatesTab("build", true, false)).toBe(true);
    expect(bindActivatesTab("agent", false, false)).toBe(false);
    expect(bindActivatesTab("dispute-detail", true, true)).toBe(false);
  });
});

describe("planThreadBind (WorkspaceShell.setTabThreadId)", () => {
  const A = "97a9c799-3a6e-418f-928b-5bb0f886af85";
  const homeTab = (threadId?: string | null): TabDescriptor => ({
    id: "home-default",
    kind: "home",
    title: "Home",
    payload: { kind: "home", ...(threadId === undefined ? {} : { threadId }) },
    dirty: false,
    pinned: true,
  });

  it("/workspace/A then unbinding Home lands on the fresh-Home ?tab=board", () => {
    const tabs = [homeTab(A)];
    const plan = planThreadBind(tabs, "home-default", null, `/workspace/${A}`, false);
    expect(plan?.activate).toBe(true);
    expect(workspaceTabHref(plan!.next, `/workspace/${A}`)).toBe("/workspace?tab=board");
  });

  it("a first send from Home binds in place and leaves the URL", () => {
    const plan = planThreadBind([homeTab()], "home-default", A, "/workspace?tab=board", false);
    expect(plan?.activate).toBe(false);
    expect(plan?.next.payload).toEqual({ kind: "home", threadId: A });
  });

  it("Past chats asking to activate Home lands on /workspace/<threadId>", () => {
    const plan = planThreadBind([homeTab()], "home-default", A, "/workspace?tab=growth-strategy", true);
    expect(plan?.activate).toBe(true);
    expect(workspaceTabHref(plan!.next, "/workspace?tab=growth-strategy")).toBe(`/workspace/${A}`);
  });

  it("ignores a tab that does not own a thread", () => {
    const growth: TabDescriptor = { id: "g", kind: "autopilot", title: "Growth", payload: { kind: "autopilot" }, dirty: false, pinned: false };
    expect(planThreadBind([homeTab(), growth], "g", A, "/workspace", true)).toBeNull();
  });
});
