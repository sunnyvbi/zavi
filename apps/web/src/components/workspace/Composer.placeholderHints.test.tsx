// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: noop,
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: noop,
    }),
  };
});
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ inflight: false, error: null, send: vi.fn() }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));

import { Composer } from "./Composer";
import { WEBSITE_COMPOSER_HINTS } from "@/lib/workspace/buildFraming";

Element.prototype.scrollIntoView = () => {};

const GROWTH_HINT = /growth|channel|marketing|dollar|@ to bring/i;

async function hintsSeen(container: HTMLElement): Promise<string> {
  let seen = "";
  for (let i = 0; i < 8; i += 1) {
    seen += ` ${container.querySelector("span[aria-hidden]")?.textContent ?? ""}`;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
  }
  return seen;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Build chat's example prompts", () => {
  it("cycle through website changes only, never growth or channel prompts", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <Composer
        agentSlug="operator"
        tabId="t"
        threadId={null}
        onOptimistic={() => "o"}
        onSent={() => {}}
        placeholderHints={WEBSITE_COMPOSER_HINTS}
      />,
    );
    const seen = await hintsSeen(container);
    for (const hint of WEBSITE_COMPOSER_HINTS) expect(seen).toContain(hint);
    expect(seen).not.toMatch(GROWTH_HINT);
  });

  it("keep the old growth prompts when no override is passed", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <Composer agentSlug="operator" tabId="t" threadId={null} onOptimistic={() => "o"} onSent={() => {}} />,
    );
    const seen = await hintsSeen(container);
    expect(seen).toContain("Ask Zavi what's holding your growth back");
    expect(seen).toContain("Type @ to bring a channel into the chat");
  });
});

describe("a locked composer (e.g. while a site publishes)", () => {
  it("disables the text area and Send, and Enter sends nothing", async () => {
    const onOptimistic = vi.fn(() => "o");
    const { container } = render(
      <Composer agentSlug="operator" tabId="t" threadId={null} onOptimistic={onOptimistic} onSent={() => {}} disabled />,
    );
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    const send = container.querySelector("button[aria-label='Send message']") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onOptimistic).not.toHaveBeenCalled();
  });
});
