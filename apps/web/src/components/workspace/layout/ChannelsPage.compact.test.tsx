// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const compact = { value: true };
const tablet = { value: false };
vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => compact.value,
  useMediaMatch: () => compact.value || tablet.value,
}));

const href = { value: "/workspace?tab=channels" };
const listeners = new Set<() => void>();
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      listeners.add(force);
      return () => {
        listeners.delete(force);
      };
    }, [force]);
    return href.value;
  },
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => href.value,
  replaceWorkspaceLocation: (next: string) => {
    href.value = next;
    listeners.forEach((fire) => fire());
  },
  pushWorkspaceLocation: (next: string) => {
    window.history.pushState(window.history.state, "", next);
    stack.push(href.value);
    href.value = next;
    listeners.forEach((fire) => fire());
  },
}));
const stack: string[] = [];
const browserBack = () =>
  act(() => {
    href.value = stack.pop() ?? href.value;
    listeners.forEach((fire) => fire());
  });

const wallet = vi.hoisted(() => vi.fn());
vi.mock("../actions/managed-campaigns/api", () => ({ campaignFetch: wallet }));
vi.mock("./ChannelActionChat", () => ({
  ChannelActionChat: ({ open }: { open: boolean }) => (
    <div data-testid="channel-chat" data-open={open ? "yes" : "no"} />
  ),
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

const channel = (slug: string, name: string) =>
  ({
    channel: {
      slug,
      name,
      connectors: [],
    },
    count: 0,
    waiting: 0,
    subtitle: null,
    lock: null,
  }) as unknown as ChannelEntry;

const ENTRIES = [channel("meta_ads", "Meta Ads"), channel("seo", "SEO")];

function renderPage() {
  return render(
    <ChannelsPage
      entries={ENTRIES}
      loading={false}
      onShow={() => {}}
      onUpgrade={() => {}}
      renderDetail={(slug, close) => (
        <div data-testid="channel-detail" data-slug={slug}>
          <button type="button" onClick={close}>
            Close channel
          </button>
        </div>
      )}
    />,
  );
}

const track = () =>
  document.querySelector<HTMLElement>('[class*="w-[200%]"]');

const openChannel = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));

const reducedMotion = { value: false };
beforeEach(() => {
  vi.spyOn(window.history, "back").mockImplementation(() => {
    href.value = stack.pop() ?? href.value;
    listeners.forEach((fire) => fire());
  });
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion.value,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

afterEach(() => {
  compact.value = true;
  tablet.value = false;
  reducedMotion.value = false;
  href.value = "/workspace?tab=channels";
  stack.length = 0;
  vi.restoreAllMocks();
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

const endSlide = () =>
  act(() => {
    const ev = new Event("transitionend", { bubbles: true }) as Event & {
      propertyName: string;
    };
    Object.defineProperty(ev, "propertyName", { value: "transform" });
    track()!.dispatchEvent(ev);
  });

describe("ChannelsPage browser history", () => {
  it("Back from an opened channel returns to the channel list", () => {
    compact.value = false;
    renderPage();
    openChannel("Meta Ads");
    expect(href.value).toBe("/workspace?tab=channels&channel=meta_ads");
    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("meta_ads");

    browserBack();

    expect(href.value).toBe("/workspace?tab=channels");
    expect(screen.queryByTestId("channel-detail")).toBeNull();
  });

  it("closing a channel it opened pops that entry instead of stacking a second list", () => {
    compact.value = false;
    reducedMotion.value = true;
    Element.prototype.scrollIntoView = () => {};
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));

    expect(href.value).toBe("/workspace?tab=channels");
    expect(stack).toEqual([]);
  });
});

describe("ChannelsPage history after another push", () => {
  it("closing after a card pushed another entry does not go Back to the old channel", async () => {
    const routes = await import("../navigation/workspaceRoutes");
    compact.value = false;
    reducedMotion.value = true;
    Element.prototype.scrollIntoView = () => {};
    renderPage();
    openChannel("Meta Ads");
    act(() => routes.pushWorkspaceLocation("/workspace?tab=channels&channel=seo"));
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));

    expect(window.history.back).not.toHaveBeenCalled();
    expect(href.value).toBe("/workspace?tab=channels");
  });
});

describe("ChannelsPage on a phone", () => {
  it("pushes the list off screen instead of squeezing the channel between two rails", () => {
    renderPage();
    expect(track()?.style.transform).toBe("translate3d(0, 0, 0)");

    openChannel("Meta Ads");

    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("meta_ads");
    expect(track()?.style.transform).toBe("translate3d(-50%, 0, 0)");
    expect(document.querySelector("h1")?.textContent).toBe("Channels");
    expect(track()?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens NEITHER side rail, so nothing squeezes the channel from either edge", () => {
    renderPage();
    openChannel("Meta Ads");

    expect(screen.queryByRole("navigation", { name: "Growth Channels" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Collapse channel list/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the chat" })).toBeNull();
  });

  it("keeps the chat off the channel until it is asked for, then covers it", () => {
    renderPage();
    openChannel("Meta Ads");

    expect(screen.queryByTestId("channel-chat")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Chat with Zavi about this channel" }),
    );
    expect(screen.getByTestId("channel-chat").dataset.open).toBe("yes");
  });

  it("does not let a desktop-open chat column cover the channel the founder just opened", () => {
    window.localStorage.setItem("zavi:channel-chat-open", "1");

    renderPage();
    openChannel("Meta Ads");

    expect(screen.queryByTestId("channel-chat")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Chat with Zavi about this channel" }),
    ).toBeTruthy();
  });

  it("slides the list back with the channel still painted, and drops it when the slide ends", () => {
    vi.useFakeTimers();
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));

    expect(track()?.style.transform).toBe("translate3d(0, 0, 0)");
    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("meta_ads");
    expect(track()?.firstElementChild?.getAttribute("aria-hidden")).toBeNull();
    expect(track()?.firstElementChild?.hasAttribute("inert")).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Chat with Zavi about this channel" }),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.getByTestId("channel-detail")).toBeTruthy();

    endSlide();
    expect(screen.queryByTestId("channel-detail")).toBeNull();
  });

  it("drops the painted channel on the 300ms fallback when no transitionend ever fires", () => {
    vi.useFakeTimers();
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));
    expect(screen.getByTestId("channel-detail")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId("channel-detail")).toBeNull();
    expect(track()?.style.transform).toBe("translate3d(0, 0, 0)");
  });

  it("ignores a transitionend that bubbles up from something inside the channel", () => {
    vi.useFakeTimers();
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));

    act(() => {
      const ev = new Event("transitionend", { bubbles: true });
      Object.defineProperty(ev, "propertyName", { value: "background-color" });
      screen.getByTestId("channel-detail").dispatchEvent(ev);
    });
    expect(screen.getByTestId("channel-detail")).toBeTruthy();
  });

  it("drops the channel at once when motion is reduced", () => {
    reducedMotion.value = true;
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));

    expect(screen.queryByTestId("channel-detail")).toBeNull();
  });

  it("swaps straight to the next channel when one is opened mid-slide", () => {
    vi.useFakeTimers();
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));
    openChannel("SEO");

    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("seo");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("seo");
  });

  it("does not leave the drop timer running after unmount", () => {
    vi.useFakeTimers();
    const view = renderPage();
    openChannel("Meta Ads");
    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes the off-screen list out of the Tab order while a channel is open", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderPage();
      const list = track()?.firstElementChild as HTMLElement;
      expect(list.hasAttribute("inert")).toBe(false);
      const listButton = list.querySelector("button") as HTMLElement;
      expect(listButton).not.toBeNull();

      openChannel("Meta Ads");

      expect(list.getAttribute("aria-hidden")).toBe("true");
      expect(list.hasAttribute("inert")).toBe(true);
      expect(list.getAttribute("inert")).toBe("");
      expect(listButton.closest("[inert]")).toBe(list);
      expect(list.className).toContain("pointer-events-none");

      fireEvent.click(screen.getByRole("button", { name: "Close channel" }));
      expect(list.hasAttribute("inert")).toBe(false);
      expect(list.hasAttribute("aria-hidden")).toBe(false);

      const inertWarnings = errors.mock.calls.filter((args) =>
        args.some((a) => String(a).includes("inert")),
      );
      expect(inertWarnings).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("makes the off-screen list truly inert without React's empty-string boolean warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage();
    const list = track()?.firstElementChild as HTMLElement;
    const listButton = screen.getByRole("button", { name: /SEO/ });

    openChannel("Meta Ads");

    expect(list.hasAttribute("inert")).toBe(true);
    expect(list.getAttribute("inert")).toBe("");
    expect(list.getAttribute("inert")).not.toBe("[object Object]");
    expect(listButton.closest("[inert]")).toBe(list);
    const inertWarnings = errors.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === "string" && /inert|non-boolean/.test(arg)),
    );
    expect(inertWarnings).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));
    act(() => {
      track()!.dispatchEvent(Object.assign(new Event("transitionend", { bubbles: true }), { propertyName: "transform" }));
    });
    expect(list.hasAttribute("inert")).toBe(false);
    expect(list.getAttribute("inert")).toBeNull();
    expect(errors.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === "string" && /inert|non-boolean/.test(arg)),
    )).toEqual([]);
    errors.mockRestore();
  });

  it("closes the sheet again when the founder moves to another channel", () => {
    renderPage();
    openChannel("Meta Ads");
    fireEvent.click(
      screen.getByRole("button", { name: "Chat with Zavi about this channel" }),
    );
    expect(screen.getByTestId("channel-chat").dataset.open).toBe("yes");

    fireEvent.click(screen.getByRole("button", { name: "Close channel" }));
    openChannel("SEO");

    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("seo");
    expect(screen.queryByTestId("channel-chat")).toBeNull();
  });
});

describe("ChannelsPage on a portrait tablet", () => {
  it("uses the same list-to-detail transition instead of squeezing three columns together", () => {
    compact.value = false;
    tablet.value = true;
    renderPage();

    openChannel("Meta Ads");

    expect(screen.getByTestId("channel-detail").dataset.slug).toBe("meta_ads");
    expect(track()?.style.transform).toBe("translate3d(-50%, 0, 0)");
    expect(screen.queryByRole("navigation", { name: "Growth Channels" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the chat" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Chat with Zavi about this channel" }),
    ).toBeTruthy();
  });
});

describe("the floating chat button", () => {
  it("carries the hook the dark-mode rule needs", () => {
    renderPage();
    openChannel("Meta Ads");

    const fab = screen.getByRole("button", {
      name: "Chat with Zavi about this channel",
    });
    expect(fab.className).toContain("channel-chat-fab");
  });

  it("clears the home indicator by moving up, not by padding its own 48px box", () => {
    renderPage();
    openChannel("Meta Ads");

    const fab = screen.getByRole("button", {
      name: "Chat with Zavi about this channel",
    });
    const classes = fab.className.split(/\s+/);
    expect(classes).not.toContain("compact-safe-bottom");
    expect(classes).not.toContain("bottom-4");
    expect(classes).toContain(
      "bottom-[calc(1rem+env(safe-area-inset-bottom,0px))]",
    );
    expect(classes).toContain("h-12");
    expect(classes).toContain("w-12");
  });
});

describe("the push track cannot be squeezed by its own flex parent", () => {
  it("keeps the track and both panes unshrinkable", () => {
    renderPage();

    const el = track();
    expect(el?.className).toContain("shrink-0");
    const panes = Array.from(el?.children ?? []) as HTMLElement[];
    expect(panes).toHaveLength(2);
    for (const pane of panes) expect(pane.className).toContain("shrink-0");
  });
});

describe("ChannelsPage on a wide screen is untouched", () => {
  it("still opens the list rail and the chat rail beside the channel", () => {
    compact.value = false;
    renderPage();
    openChannel("Meta Ads");

    expect(screen.getByRole("navigation", { name: "Growth Channels" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the chat" })).toBeTruthy();
    expect(track()).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Chat with Zavi about this channel" }),
    ).toBeNull();
  });
});

describe("ChannelsPage wheel preview", () => {
  it("a hover/focus preview calls onPeek, not onShow (opening marks actions seen)", () => {
    compact.value = false;
    window.localStorage.setItem("zavi:channels-view", "wheel");
    const onShow = vi.fn();
    const onPeek = vi.fn();
    render(
      <ChannelsPage
        entries={ENTRIES}
        loading={false}
        onShow={onShow}
        onPeek={onPeek}
        onUpgrade={() => {}}
        renderDetail={() => null}
      />,
    );
    const seo = document.querySelector<HTMLElement>('[data-channel-slug="seo"]')!;
    fireEvent.focus(seo);
    expect(onPeek).toHaveBeenCalledWith(ENTRIES[1]);
    expect(onShow).not.toHaveBeenCalled();
  });
});

const lockedChatgptPage = () => {
  href.value = "/workspace?tab=channels&channel=chatgpt_ads";
  const entry = channel("chatgpt_ads", "ChatGPT Ads"); entry.lock = { kind: "soon" };
  render(<ChannelsPage entries={[entry]} loading={false} onShow={() => {}} onUpgrade={() => {}} renderDetail={() => <div data-testid="forbidden-detail" />} />);
};

it.each(["list", "wheel"])("keeps financial controls reachable for locked channels in %s view", async mode => {
  window.localStorage.setItem("zavi:channels-view", mode);
  wallet.mockResolvedValue({ balance_cents: 0, reserved_cents: 0, auto_refill_enabled: true, pending: false });
  lockedChatgptPage();
  const manage = await screen.findByRole("button", { name: "Manage ChatGPT Ads balance and pauses" });
  const chip = document.querySelector('[data-channel-slug="chatgpt_ads"]')!;
  expect(chip.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByTestId("forbidden-detail")).toBeNull();
});

it("shows no financial controls for a locked channel when the workspace has no ads money at stake", async () => {
  window.localStorage.setItem("zavi:channels-view", "list");
  wallet.mockImplementation(async (path: string) => path === "/api/ads/wallet" ? { balance_cents: 0, reserved_cents: 0, auto_refill_enabled: false, pending: false } : { campaigns: [], complete: true });
  lockedChatgptPage();
  await waitFor(() => expect(wallet).toHaveBeenCalledWith("/api/ads/wallet"));
  await Promise.resolve();
  expect(screen.queryByRole("button", { name: "Manage ChatGPT Ads balance and pauses" })).toBeNull();
});

it("puts a plan-locked channel's financial controls inside that channel's row", async () => {
  window.localStorage.setItem("zavi:channels-view", "list");
  wallet.mockResolvedValue({ balance_cents: 0, reserved_cents: 0, auto_refill_enabled: true, pending: false });
  href.value = "/workspace?tab=channels";
  const locked = channel("chatgpt_ads", "ChatGPT Ads"); locked.lock = { kind: "plan", label: "Pro plan", tier: "pro" } as never;
  render(<ChannelsPage entries={[channel("seo", "SEO"), locked]} loading={false} onShow={() => {}} onUpgrade={() => {}} renderDetail={() => null} />);
  const manage = await screen.findByRole("button", { name: "Manage ChatGPT Ads balance and pauses" });
  const rowSection = document.querySelector('[data-channel-slug="chatgpt_ads"]')!.closest("section")!;
  expect(rowSection.contains(manage)).toBe(true);
});
