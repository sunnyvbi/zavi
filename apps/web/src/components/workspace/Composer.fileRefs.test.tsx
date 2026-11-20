// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const run = vi.hoisted(() => ({
  send: vi.fn(),
  feedback: vi.fn(async () => ({ ok: true })),
  tabSeeds: {} as Record<string, { text: string; nonce: number }>,
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const consumeComposerSeed = (tabId: string) => {
    delete run.tabSeeds[tabId];
  };
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: noop,
      role: "owner",
      composerSeeds: run.tabSeeds,
      consumeComposerSeed,
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
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: run.feedback }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));

import { Composer } from "./Composer";

Element.prototype.scrollIntoView = () => {};

const T = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const hero = {
  name: "hero.jpeg",
  url: `http://localhost:3011/api/public/workspace-files/${T}/cd9ec0c2-1c87-483f-9930-4a18bc701015/hero.jpeg`,
};
const team = {
  name: "team.png",
  url: `http://localhost:3011/api/public/workspace-files/${T}/aaaaaaaa-1c87-483f-9930-4a18bc701015/team.png`,
};

function mount(seed: { text: string; nonce: number; files?: typeof hero[] }) {
  const onOptimistic = vi.fn((_text: string) => "opt-1");
  const view = render(
    <Composer agentSlug="operator" tabId="t" threadId={null} seed={seed} onOptimistic={onOptimistic} onSent={() => {}} />,
  );
  return { ...view, onOptimistic };
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
const chips = () => screen.queryByRole("list", { name: /attached photo/i });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  for (const key of Object.keys(run.tabSeeds)) delete run.tabSeeds[key];
  run.send.mockReset();
});

describe("Composer photo chips", () => {
  it("keeps the plus and microphone hover targets fully circular", () => {
    mount({ text: "", nonce: 0 });

    const attach = screen.getByRole("button", {
      name: /Attach image|Add to this message/,
    });
    const microphone = screen.getByRole("button", { name: /dictation/i });

    for (const control of [attach, microphone]) {
      expect(control.classList.contains("rounded-full")).toBe(true);
      expect(control.classList.contains("rounded-lg")).toBe(false);
    }
  });

  it("swaps Send for the same stop-square while a Build change is running", async () => {
    const onStop = vi.fn(async () => null as string | null);
    render(
      <Composer
        agentSlug="operator"
        tabId="t"
        threadId={null}
        externalStop={{ ariaLabel: "Stop change", onStop }}
        onOptimistic={() => "o"}
        onSent={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop change" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });

  it("blocks Enter while a Build change exposes only Stop", async () => {
    const onSystem = vi.fn();
    render(
      <Composer
        agentSlug="operator"
        tabId="t"
        threadId={null}
        externalStop={{ ariaLabel: "Stop change", onStop: async () => null }}
        onOptimistic={() => "o"}
        onSent={() => {}}
        onSystem={onSystem}
      />,
    );

    fireEvent.change(box(), { target: { value: "add another section" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();

    expect(run.send).not.toHaveBeenCalled();
    expect(onSystem).toHaveBeenCalledWith(expect.stringContaining("current build change"));
    expect(screen.getByRole("button", { name: "Stop change" })).toBeTruthy();
  });

  it("shows picked photos as chips, not links, and sends them with the typed words", async () => {
    run.send.mockResolvedValue({ kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" });
    const { onOptimistic } = mount({ text: "", nonce: 1, files: [hero, team] });
    expect(box().value).toBe("");
    expect(within(chips()!).getByText("hero.jpeg")).toBeTruthy();
    expect(within(chips()!).getByText("team.png")).toBeTruthy();
    expect(sendButton().disabled).toBe(false);

    fireEvent.change(box(), { target: { value: "put these in the hero" } });
    fireEvent.click(sendButton());
    await flush();

    const sent = `put these in the hero\n\nUse these photos on the site:\nhero.jpeg: ${hero.url}\nteam.png: ${team.url}`;
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.send.mock.calls[0]![1]).toBe(sent);
    expect(onOptimistic.mock.calls[0]![0]).toBe(sent);
    expect(chips()).toBeNull();
    expect(box().value).toBe("");
  });

  it("drops a removed chip from what is sent, and an empty box with no chips cannot send", async () => {
    mount({ text: "", nonce: 2, files: [hero] });
    fireEvent.click(screen.getByRole("button", { name: "Remove hero.jpeg" }));
    expect(chips()).toBeNull();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    await flush();
    expect(run.send).not.toHaveBeenCalled();
  });

  it("puts a failed send back as chips plus the typed words, never as raw links", async () => {
    run.send.mockResolvedValue(null);
    mount({ text: "", nonce: 3, files: [hero] });
    fireEvent.change(box(), { target: { value: "use it" } });
    fireEvent.click(sendButton());
    await flush();
    expect(run.send).toHaveBeenCalled();
    expect(box().value).toBe("use it");
    expect(within(chips()!).getByText("hero.jpeg")).toBeTruthy();
  });

  it("brings a photo message back as chips when it is edited", () => {
    run.tabSeeds.t = { text: `fix the hero\n\nUse this photo on the site:\nhero.jpeg: ${hero.url}`, nonce: 1 };
    render(<Composer agentSlug="operator" tabId="t" threadId={null} onOptimistic={() => "o"} onSent={() => {}} />);
    expect(box().value).toBe("fix the hero");
    expect(within(chips()!).getByText("hero.jpeg")).toBeTruthy();
  });

  it("treats an unchanged photo edit as unchanged and never mixes in photos staged before it", async () => {
    const props = { agentSlug: "operator", tabId: "t", threadId: null, onOptimistic: () => "o", onSent: () => {} };
    const seed = { text: "", nonce: 8, files: [team] };
    const view = render(<Composer {...props} seed={seed} />);
    expect(within(chips()!).getByText("team.png")).toBeTruthy();

    run.tabSeeds.t = {
      text: `Use the "landing" photos on the site:\nhero.jpeg: ${hero.url}`,
      nonce: 1,
      origin: "edit",
    } as { text: string; nonce: number };
    view.rerender(<Composer {...props} seed={seed} />);
    await flush();
    expect(within(chips()!).getAllByRole("listitem")).toHaveLength(1);
    expect(within(chips()!).getByText("hero.jpeg")).toBeTruthy();
    expect(box().value).toBe("");
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.click(sendButton());
    await flush();
    expect(run.send).not.toHaveBeenCalled();

    fireEvent.change(box(), { target: { value: "and brighter" } });
    expect(sendButton().disabled).toBe(false);
  });

  it("turns an old link-style message seeded back into the box into chips", () => {
    mount({ text: `Use this photo on the site:\nhero.jpeg: ${hero.url}`, nonce: 4 });
    expect(box().value).toBe("");
    expect(within(chips()!).getByText("hero.jpeg")).toBeTruthy();
  });

  it("keeps a slash command's words its own: /feedback never carries the photo links", async () => {
    mount({ text: "", nonce: 5, files: [hero] });
    fireEvent.change(box(), { target: { value: "/feedback shorter replies please" } });
    fireEvent.click(sendButton());
    await flush();
    expect(run.send).not.toHaveBeenCalled();
    expect(run.feedback).toHaveBeenCalledTimes(1);
    expect((run.feedback.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe("shorter replies please");
    expect(within(chips()!).getByText("hero.jpeg")).toBeTruthy();
  });
});
