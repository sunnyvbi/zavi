import { describe, it, expect } from "vitest";
import { homeIsCurrent } from "./ContextPanel";
import type { TabDescriptor } from "@/lib/workspace/types";

const agent = (threadId: string | null | undefined): TabDescriptor =>
  ({
    id: "t",
    kind: "agent",
    title: "operator",
    payload: { kind: "agent", slug: "operator", threadId },
    dirty: false,
    pinned: false,
  }) as TabDescriptor;

const staticTab = (kind: string): TabDescriptor =>
  ({
    id: "s",
    kind,
    title: kind,
    payload: { kind },
    dirty: false,
    pinned: false,
  }) as unknown as TabDescriptor;

describe("homeIsCurrent", () => {
  it("is Home for a blank chat — threadId null, which is what openAgentTab stores", () => {
    expect(homeIsCurrent(agent(null), true)).toBe(true);
  });

  it("is NOT Home for an ABSENT thread id, which means a conversation still loading", () => {
    expect(homeIsCurrent(agent(undefined), true)).toBe(false);
  });

  it("is NOT Home once a real conversation is bound — that row owns the highlight", () => {
    expect(homeIsCurrent(agent("2b8e1f6c-0000-4000-8000-000000000000"), true)).toBe(false);
  });

  it("is never Home on another destination, or when chat is not the focus", () => {
    expect(homeIsCurrent(staticTab("channels"), true)).toBe(false);
    expect(homeIsCurrent(staticTab("home"), true)).toBe(false);
    expect(homeIsCurrent(agent(null), false)).toBe(false);
    expect(homeIsCurrent(undefined, true)).toBe(false);
  });
});
