// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const run = vi.hoisted(() => ({ send: vi.fn() }));
const ws = vi.hoisted(() => ({ role: "owner" }));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: noop,
      role: ws.role,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const retryButton = () => screen.getByRole("button", { name: "Retry build" }) as HTMLButtonElement;

function view(props: {
  onRetry?: () => Promise<void>;
  retrying?: boolean;
  running?: boolean;
  buildRunning?: boolean;
  onStop?: () => Promise<string | null>;
  retry?: boolean;
}) {
  return (
    <Composer
      agentSlug="operator"
      tabId="t"
      threadId={null}
      onOptimistic={() => "o"}
      onSent={() => {}}
      externalStop={
        props.running
          ? { ariaLabel: "Stop change", onStop: async () => null }
          : props.buildRunning
            ? { ariaLabel: "Stop build", allowSend: true, onStop: props.onStop ?? (async () => null) }
            : undefined
      }
      externalRetry={
        props.retry === false
          ? undefined
          : { ariaLabel: "Retry build", retrying: props.retrying, onRetry: props.onRetry ?? (async () => {}) }
      }
    />
  );
}

afterEach(() => {
  cleanup();
  run.send.mockReset();
  ws.role = "owner";
});

describe("Composer Retry build", () => {
  it("takes the Send slot on an empty box and fires one retry however often it is pressed", async () => {
    const pending = deferred();
    const onRetry = vi.fn(() => pending.promise);
    render(view({ onRetry }));

    const retry = retryButton();
    expect(retry.querySelector(".lucide-rotate-cw")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(retry);
    await flush();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryButton().getAttribute("aria-busy")).toBe("true");
    expect(retryButton().disabled).toBe(true);
    expect(retryButton().querySelector(".animate-spin")).not.toBeNull();

    pending.resolve();
    await flush();
    expect(retryButton().getAttribute("aria-busy")).toBeNull();
    fireEvent.click(retryButton());
    await flush();
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(run.send).not.toHaveBeenCalled();
  });

  it("clears the spinner when the retry rejects, so a failed call can be pressed again", async () => {
    const onRetry = vi.fn(() => Promise.reject(new Error("boom")));
    render(view({ onRetry }));
    fireEvent.click(retryButton());
    await flush();
    expect(retryButton().getAttribute("aria-busy")).toBeNull();
    fireEvent.click(retryButton());
    await flush();
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("hands the slot back to Send once the founder types, and sends instead of retrying", async () => {
    const onRetry = vi.fn(async () => {});
    run.send.mockResolvedValue({ kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" });
    render(view({ onRetry }));

    fireEvent.change(box(), { target: { value: "Make the hero pink" } });
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await flush();
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.change(box(), { target: { value: "   " } });
    expect(retryButton()).toBeTruthy();
  });

  it("stays busy while the host reports a retry already in flight", () => {
    const onRetry = vi.fn(async () => {});
    render(view({ onRetry, retrying: true }));
    fireEvent.click(retryButton());
    expect(onRetry).not.toHaveBeenCalled();
    expect(retryButton().getAttribute("aria-busy")).toBe("true");
  });

  it("never shows while a change is running: Stop owns the slot", () => {
    render(view({ running: true }));
    expect(screen.getByRole("button", { name: "Stop change" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
  });

  it("is absent without a retry control", () => {
    render(view({ retry: false }));
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("gives a view-only member no Retry, since only the Send they cannot use belongs there", () => {
    ws.role = "viewer";
    const onRetry = vi.fn(async () => {});
    render(view({ onRetry }));
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("Composer Stop build", () => {
  it("shows Stop on an empty box and stops once", async () => {
    const onStop = vi.fn(async () => null);
    render(view({ buildRunning: true, retry: false, onStop }));
    const stop = screen.getByRole("button", { name: "Stop build" });
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    fireEvent.click(stop);
    fireEvent.click(stop);
    await flush();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("still lets the founder chat while the build runs: typing brings Send back and the message goes out", async () => {
    const onStop = vi.fn(async () => null);
    run.send.mockResolvedValue({ kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" });
    render(view({ buildRunning: true, retry: false, onStop }));
    fireEvent.change(box(), { target: { value: "Is the order form done yet?" } });
    expect(screen.queryByRole("button", { name: "Stop build" })).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.queryByText(/Wait for the current build change to finish/)).toBeNull();
  });

  it("keeps a running change strict: Stop change still blocks a new turn", async () => {
    render(view({ running: true, retry: false }));
    fireEvent.change(box(), { target: { value: "Also make it blue" } });
    expect(screen.getByRole("button", { name: "Stop change" })).toBeTruthy();
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(run.send).not.toHaveBeenCalled();
  });
});
