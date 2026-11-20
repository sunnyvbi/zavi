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

type Intercept = { handled: boolean; system?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
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
const sendButton = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
const queued = { kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" };

function view(props: { onBeforeSend?: (m: string) => Promise<Intercept>; running?: boolean }) {
  return (
    <Composer
      agentSlug="operator"
      tabId="t"
      threadId={null}
      onOptimistic={() => "o"}
      onSent={() => {}}
      onBeforeSend={props.onBeforeSend}
      externalStop={props.running ? { ariaLabel: "Stop change", onStop: async () => null } : undefined}
    />
  );
}

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
}

afterEach(() => {
  cleanup();
  run.send.mockReset();
});

describe("Composer send → loader → Stop", () => {
  it("spins a solid Send circle from the press until the change starts, then shows the Stop square", async () => {
    const classify = deferred<Intercept>();
    const posted = deferred<typeof queued>();
    const onBeforeSend = vi.fn(() => classify.promise);
    run.send.mockReturnValue(posted.promise);
    const { rerender } = render(view({ onBeforeSend }));

    type("Add three sample menu items");
    await flush();

    const busy = sendButton();
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.querySelector(".animate-spin")).not.toBeNull();
    expect(busy.querySelector(".lucide-arrow-up")).toBeNull();
    expect(busy.className).toContain("bg-ink ");
    expect(busy.className).not.toContain("bg-ink/15");
    expect(busy.disabled).toBe(true);

    type("second message");
    fireEvent.click(busy);
    await flush();
    expect(onBeforeSend).toHaveBeenCalledTimes(1);

    classify.resolve({ handled: false });
    await flush();
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(sendButton().getAttribute("aria-busy")).toBe("true");

    posted.resolve(queued);
    await flush();
    rerender(view({ onBeforeSend, running: true }));

    const stop = screen.getByRole("button", { name: "Stop change" });
    expect(stop.querySelector(".animate-spin")).toBeNull();
    expect(stop.querySelector("span.bg-current")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("drops the loader when the post returns, so a send that started no run never spins forever", async () => {
    const posted = deferred<typeof queued>();
    run.send.mockReturnValue(posted.promise);
    render(view({}));

    type("What changed this week?");
    await flush();
    expect(sendButton().getAttribute("aria-busy")).toBe("true");

    posted.resolve(queued);
    await flush();
    expect(sendButton().getAttribute("aria-busy")).toBeNull();
    expect(sendButton().querySelector(".animate-spin")).toBeNull();
  });

  it("drops the loader when the host applies the edit itself and no run is sent", async () => {
    const classify = deferred<Intercept>();
    render(view({ onBeforeSend: () => classify.promise }));

    type("Change the tagline to Fresh every morning");
    await flush();
    expect(sendButton().getAttribute("aria-busy")).toBe("true");

    classify.resolve({ handled: true, system: "Updated the tagline." });
    await flush();
    expect(run.send).not.toHaveBeenCalled();
    expect(sendButton().getAttribute("aria-busy")).toBeNull();
  });
});
