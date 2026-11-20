// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const run = vi.hoisted(() => ({ send: vi.fn() }));

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
  useAgentRun: () => ({ inflight: false, error: null, send: run.send }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));

import { Composer } from "./Composer";

Element.prototype.scrollIntoView = () => {};

type Seed = { text: string; nonce: number; autoSend?: boolean; onStarted?: () => void };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

function view(seed: Seed | undefined, opts: { running?: boolean; onSystem?: (t: string) => void } = {}) {
  return (
    <Composer
      agentSlug="operator"
      tabId="t"
      threadId={null}
      onOptimistic={() => "o"}
      onSent={() => {}}
      onSystem={opts.onSystem}
      seed={seed}
      externalStop={opts.running ? { ariaLabel: "Stop change", onStop: async () => null } : undefined}
    />
  );
}

afterEach(() => {
  cleanup();
  run.send.mockReset();
});

describe("Composer autoSend seed prop", () => {
  it("sends into an empty box and reports that it started", async () => {
    run.send.mockResolvedValue({ kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" });
    const onStarted = vi.fn();
    render(view({ text: "Write episode 2 now", nonce: 1, autoSend: true, onStarted }));
    await flush();
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("does not send over words the founder has typed, and keeps them", async () => {
    const onStarted = vi.fn();
    const { rerender } = render(view(undefined));
    fireEvent.change(box(), { target: { value: "my own question" } });
    rerender(view({ text: "Write episode 2 now", nonce: 1, autoSend: true, onStarted }));
    await flush();
    expect(run.send).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(box().value).toBe("my own question");
  });

  it("waits while a run is going: no send, no 'started', and the wait message", async () => {
    const onStarted = vi.fn();
    const onSystem = vi.fn();
    render(view({ text: "Write episode 2 now", nonce: 1, autoSend: true, onStarted }, { running: true, onSystem }));
    await flush();
    expect(run.send).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onSystem).toHaveBeenCalledWith("Wait for the current run to finish (or press Stop) before sending another message.");
  });
});
