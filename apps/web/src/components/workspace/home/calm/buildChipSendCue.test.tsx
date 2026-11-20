// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import type * as React from "react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));

type Seed = { text: string; nonce: number; autoSend?: boolean };
type BeforeSend = (message: string) => Promise<{ handled: boolean; system?: string; consumed?: boolean }>;

const chat = vi.hoisted(() => ({
  removeOptimisticUser: vi.fn(),
  appendOptimisticUser: vi.fn(() => "optimistic-1"),
  appendOptimisticSystem: vi.fn(),
}));

const composerLog = vi.hoisted(() => ({ autoSends: [] as string[] }));

vi.mock("../../Composer", () => ({
  Composer: (props: {
    seed?: Seed;
    onBeforeSend?: BeforeSend;
    onOptimistic?: (text: string) => string | null | undefined;
    onSystem?: (text: string) => void;
    externalStop?: unknown;
    disabled?: boolean;
  }) => {
    const [value, setValue] = useState("");
    const { seed } = props;
    useEffect(() => {
      if (!seed) return;
      if (seed.autoSend) {
        composerLog.autoSends.push(seed.text);
        return;
      }
      setValue(seed.text);
      document.getElementById("stand-in-composer")?.focus();
    }, [seed]);
    const send = async () => {
      const message = value;
      props.onOptimistic?.(message);
      setValue("");
      const out = await props.onBeforeSend?.(message);
      if (out?.system) props.onSystem?.(out.system);
    };
    return (
      <div>
        <textarea
          id="stand-in-composer"
          aria-label="Message"
          data-locked={props.disabled ? "true" : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {props.externalStop ? null : (
          <button type="button" onClick={() => void send()}>
            Send
          </button>
        )}
      </div>
    );
  },
}));
vi.mock("../../ChatThread", () => ({ ChatThread: () => <div /> }));
vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({ ChatExpandButton: () => null }));
vi.mock("../../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: [],
    activityRows: [],
    activityByRun: new Map(),
    loading: false,
    errorMsg: null,
    activeRunId: null,
    activeTrigger: null,
    activeRunStartedAt: null,
    activeRunTurnStartedAt: null,
    removeOptimisticUser: chat.removeOptimisticUser,
    appendOptimisticUser: chat.appendOptimisticUser,
    appendOptimisticSystem: chat.appendOptimisticSystem,
    markRunStopped: vi.fn(),
    unmarkRunStopped: vi.fn(),
    refetch: vi.fn(),
  }),
}));

import { CHIP_BUSY_HINT, CHIP_SEND_CUE, CHIPS_LOCKED_HINT, HomeChatPanel } from "./HomeChatPanel";
import { BUILD_CHANGE_BUSY_MESSAGE, startBuildRefine } from "@/lib/workspace/useBuildSession";
import { resolveBuildRefine } from "../../website/websiteChatEdit";
import { PUBLISH_CHANGES_BLOCKED } from "../../build/BuildModePane";

const CHIPS = [
  { key: "checkout", label: "Add Checkout Flow", prompt: "Add a checkout flow with cart and payment." },
  { key: "orders", label: "Create Order Management", prompt: "Create an order management page." },
];

const refineViaServer: BeforeSend = (message) =>
  resolveBuildRefine(message, async (m) => {
    const error = await startBuildRefine("session-1", m);
    if (!error) return { ok: true as const };
    return { ok: false as const, message: typeof error === "string" ? error : "headline" in error ? error.headline : error.message };
  });

function renderPanel(overrides: Partial<React.ComponentProps<typeof HomeChatPanel>> = {}) {
  return render(
    <HomeChatPanel
      greeting="Hello"
      pulse="Ready"
      suggestions={[]}
      expanded={false}
      onExpandedChange={() => {}}
      width={430}
      dragging={false}
      separatorProps={{} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"]}
      composerSuggestions={CHIPS}
      onBeforeSend={vi.fn(async () => ({ handled: false }))}
      onBuildSuggestionSend={refineViaServer}
      {...overrides}
    />,
  );
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const refinePosts = () =>
  apiFetch.mock.calls.filter(([path, init]) => String(path).endsWith("/refine-product") && init?.method === "POST");

beforeEach(() => {
  apiFetch.mockReset();
  chat.removeOptimisticUser.mockClear();
  chat.appendOptimisticSystem.mockClear();
  chat.appendOptimisticUser.mockClear();
  composerLog.autoSends = [];
});

afterEach(cleanup);

describe("Build chip click never starts a change by itself", () => {
  it("fills and focuses the composer, shows the Send cue, and posts nothing", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Add Checkout Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Order Management" }));

    await waitFor(() => expect(box().value).toBe("Create an order management page."));
    expect(document.activeElement).toBe(box());
    expect(screen.getByRole("status").textContent).toBe(CHIP_SEND_CUE);
    expect(screen.getByRole("button", { name: "Create Order Management" }).getAttribute("aria-describedby")).toBe(
      "build-chip-hint",
    );
    expect(composerLog.autoSends).toEqual([]);
    expect(refinePosts()).toHaveLength(0);
  });
});

describe("Build chips while a change is running", () => {
  it("disables every chip and swaps the cue for the one-at-a-time hint", async () => {
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add Checkout Flow" }));
    await waitFor(() => expect(box().value).toBe("Add a checkout flow with cart and payment."));

    const props = {
      greeting: "Hello",
      pulse: "Ready",
      suggestions: [] as string[],
      expanded: false,
      onExpandedChange: () => {},
      width: 430,
      dragging: false,
      separatorProps: {} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"],
      composerSuggestions: CHIPS,
      onBuildSuggestionSend: refineViaServer,
    };
    rerender(
      <HomeChatPanel {...props} externalStop={{ ariaLabel: "Stop change", onStop: async () => null }} />,
    );

    for (const chip of CHIPS) {
      expect((screen.getByRole("button", { name: chip.label }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByRole("status").textContent).toBe(CHIP_BUSY_HINT);
    fireEvent.click(screen.getByRole("button", { name: "Create Order Management" }));
    expect(box().value).toBe("Add a checkout flow with cart and payment.");

    rerender(<HomeChatPanel {...props} />);
    expect((screen.getByRole("button", { name: "Add Checkout Flow" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(CHIP_SEND_CUE);
  });

  it("locks the chips while a Send is still waiting on the server", async () => {
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementation(
      () => new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add Checkout Flow" }));
    await waitFor(() => expect(box().value).toBe("Add a checkout flow with cart and payment."));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect((screen.getByRole("button", { name: "Create Order Management" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("status").textContent).toBe(CHIPS_LOCKED_HINT);
    await act(async () => {
      release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create Order Management" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("Send while another change runs (server 409)", () => {
  it("maps build_already_in_progress to plain copy", async () => {
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "build_already_in_progress", message: "another build or refine is already in progress for this tenant" },
        }),
        { status: 409 },
      ),
    );
    await expect(startBuildRefine("session-1", "x")).resolves.toBe(BUILD_CHANGE_BUSY_MESSAGE);
    expect(BUILD_CHANGE_BUSY_MESSAGE).not.toMatch(/tenant|—/);
  });

  it("keeps the typed text in the composer and pins a persistent message in the chat", async () => {
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "build_already_in_progress", message: "another build or refine is already in progress for this tenant" },
        }),
        { status: 409 },
      ),
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Create Order Management" }));
    await waitFor(() => expect(box().value).toBe("Create an order management page."));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box().value).toBe("Create an order management page."));
    expect(refinePosts()).toHaveLength(1);
    expect(chat.appendOptimisticSystem).toHaveBeenCalledTimes(1);
    expect(chat.appendOptimisticSystem).toHaveBeenCalledWith(BUILD_CHANGE_BUSY_MESSAGE, { persists: false });
    expect(chat.removeOptimisticUser).toHaveBeenCalledWith("optimistic-1");
    expect(screen.getByRole("status").textContent).toBe(CHIP_SEND_CUE);

    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(refinePosts()).toHaveLength(2));
    expect(refinePosts()[1][1].body).toContain("Create an order management page.");
  });
});

describe("Send while the first publish is running", () => {
  const busy409 = () =>
    new Response(
      JSON.stringify({
        error: { code: "build_already_in_progress", message: "another build or refine is already in progress for this tenant" },
      }),
      { status: 409 },
    );
  const baseProps = {
    greeting: "Hello",
    pulse: "Ready",
    suggestions: [] as string[],
    expanded: false,
    onExpandedChange: () => {},
    width: 430,
    dragging: false,
    separatorProps: {} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"],
    composerSuggestions: CHIPS,
    onBeforeSend: refineViaServer,
    onBuildSuggestionSend: refineViaServer,
  };

  it("shows the publishing notice, posts nothing, keeps the text, and never claims another change is running", async () => {
    apiFetch.mockImplementation(async () => busy409());
    renderPanel({ onBeforeSend: refineViaServer, sendBlockedNotice: PUBLISH_CHANGES_BLOCKED });

    expect(screen.getByTestId("build-publish-blocks-changes").textContent).toBe(PUBLISH_CHANGES_BLOCKED);
    expect(box().getAttribute("data-locked")).toBe("true");
    for (const chip of CHIPS) {
      expect((screen.getByRole("button", { name: chip.label }) as HTMLButtonElement).disabled).toBe(true);
    }

    fireEvent.change(box(), { target: { value: "Make the header green" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box().value).toBe("Make the header green"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(chat.appendOptimisticSystem).not.toHaveBeenCalled();
    expect(chat.removeOptimisticUser).toHaveBeenCalledWith("optimistic-1");
    expect(screen.queryByText(BUILD_CHANGE_BUSY_MESSAGE)).toBeNull();
  });

  it("sends normally the moment publishing finishes mid-session", async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { rerender } = render(<HomeChatPanel {...baseProps} sendBlockedNotice={PUBLISH_CHANGES_BLOCKED} />);
    fireEvent.change(box(), { target: { value: "Make the header green" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box().value).toBe("Make the header green"));
    expect(refinePosts()).toHaveLength(0);

    rerender(<HomeChatPanel {...baseProps} sendBlockedNotice={null} />);
    expect(screen.queryByTestId("build-publish-blocks-changes")).toBeNull();
    expect((screen.getByRole("button", { name: "Add Checkout Flow" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(refinePosts()).toHaveLength(1));
    expect(refinePosts()[0][1].body).toContain("Make the header green");
  });

  it("blocks a send on an already-mounted panel once publishing starts under it", async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { rerender } = render(<HomeChatPanel {...baseProps} sendBlockedNotice={null} />);
    rerender(<HomeChatPanel {...baseProps} sendBlockedNotice={PUBLISH_CHANGES_BLOCKED} />);
    fireEvent.change(box(), { target: { value: "Add a footer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box().value).toBe("Add a footer"));
    expect(refinePosts()).toHaveLength(0);
  });
});
