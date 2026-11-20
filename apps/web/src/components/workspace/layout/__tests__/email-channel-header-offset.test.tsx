// @vitest-environment jsdom
import { forgetConnected } from "../../email/EmailConnectTiles";
import { forgetPaused } from "../../email/EmailSendingSwitch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/font/local",() => ({ default: () => ({ className: "", style: {} }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn(), role: "owner", tenantName: "Brightloop" }),
  useWorkspaceOptional: () => ({ role: "owner" }),
}));

const answers: Record<string, unknown> = {};
const apiFetch = vi.fn(async (url: string, _init?: unknown) => {
  const path = url.split("?")[0];
  if (path.startsWith("/api/approvals")) return { ok: true, status: 200, json: async () => ({ decisions: [], channel_pending_counts: {} }) };
  if (path === "/api/channels")
    return {
      ok: true,
      status: 200,
      json: async () => ({
        channels: [
          {
            channel_slug: "email_marketing",
            delivery_mode: "execute",
            work_state: "idle",
            priority: 1,
            last_run_at: null,
            connected: true,
            connectors: ["email"],
            linked_connectors: ["email"],
            runnable: true,
          },
        ],
      }),
    };
  return { ok: true, status: 200, json: async () => answers[path] ?? {} };
});
vi.mock("@/lib/api", () => ({ apiFetch: (url: string, init?: unknown) => apiFetch(url, init) }));

import { ChannelsPanel, clearChannelBoardCache } from "../ChannelsPanel";
import { emailSettingsAnchor, gotoEmailSettings } from "../../email/emailSettingsNav";

const BROWSER_CSS =
  ".overflow-hidden{overflow:hidden}.overflow-clip{overflow:clip}.workspace-shell .ws-scroll{overflow-y:auto}";
const PUSH = 56.25;

type Axis = "scrollTop" | "scrollLeft";
const saved: Partial<Record<Axis, PropertyDescriptor>> = {};
let savedIntoView: Element["scrollIntoView"] | undefined;
let savedMatchMedia: typeof window.matchMedia | undefined;

const isScrollContainer = (el: Element) => {
  const s = window.getComputedStyle(el);
  return [s.overflow, s.overflowY, s.overflowX].some((v) => v === "hidden" || v === "auto" || v === "scroll");
};

function installBrowserScrolling() {
  const style = document.createElement("style");
  style.setAttribute("data-test", "browser-css");
  style.textContent = BROWSER_CSS;
  document.head.appendChild(style);
  for (const axis of ["scrollTop", "scrollLeft"] as const) {
    saved[axis] = Object.getOwnPropertyDescriptor(Element.prototype, axis);
    const offsets = new WeakMap<Element, number>();
    Object.defineProperty(Element.prototype, axis, {
      configurable: true,
      get(this: Element) {
        return offsets.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        if (!isScrollContainer(this)) return;
        const next = Math.max(0, Number(value) || 0);
        if ((offsets.get(this) ?? 0) === next) return;
        offsets.set(this, next);
        this.dispatchEvent(new Event("scroll"));
      },
    });
  }
  savedIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    for (let node = this.parentElement; node; node = node.parentElement) {
      if (isScrollContainer(node)) node.scrollTop = node.scrollTop + PUSH;
    }
  };
}

function uninstallBrowserScrolling() {
  document.querySelectorAll("style[data-test='browser-css']").forEach((n) => n.remove());
  for (const axis of ["scrollTop", "scrollLeft"] as const) {
    const d = saved[axis];
    if (d) Object.defineProperty(Element.prototype, axis, d);
    else delete (Element.prototype as unknown as Record<string, unknown>)[axis];
  }
  if (savedIntoView) Element.prototype.scrollIntoView = savedIntoView;
}

function setCompact(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const offsetAbove = (el: Element) => {
  let total = 0;
  for (let node = el.parentElement; node; node = node.parentElement) total += node.scrollTop + node.scrollLeft;
  return total;
};

async function mountEmailPage() {
  render(
    <div className="workspace-shell">
      <ChannelsPanel collapsed={false} onToggle={() => {}} variant="page" />
    </div>,
  );
  const aside = screen.getByRole("complementary", { name: "Growth Channels" });
  const tools = await screen.findByTestId("channel-title-tools", {}, { timeout: 4000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /New email/ })).toBeTruthy(), { timeout: 4000 });
  const headerRow = tools.parentElement!;
  expect(within(headerRow).getByRole("button", { name: "Close" })).toBeTruthy();
  expect(within(headerRow).getByRole("heading", { name: "Email campaigns" })).toBeTruthy();
  return { aside, tools, headerRow };
}

beforeEach(() => {
  clearChannelBoardCache();
  forgetConnected();
  forgetPaused();
  apiFetch.mockClear();
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/api/workspace/email-pause"] = { paused: false };
  answers["/api/workspace/email-test-lists"] = { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [] };
  answers["/api/workspace/email-plan"] = { ok: true, role: "owner", timezone: "UTC", items: [], holds: [], released: [] };
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
  savedMatchMedia = window.matchMedia;
  setCompact(false);
  installBrowserScrolling();
});

afterEach(() => {
  cleanup();
  uninstallBrowserScrolling();
  if (savedMatchMedia) window.matchMedia = savedMatchMedia;
  else delete (window as unknown as Record<string, unknown>).matchMedia;
  window.history.replaceState(null, "", "/");
});

describe("Email campaigns header row cannot be scrolled out of the Growth Channels page", () => {
  it("a programmatic offset pushed onto the page wrapper does not take, so the title and New email stay on top", async () => {
    const { aside, tools, headerRow } = await mountEmailPage();
    act(() => {
      aside.scrollTop = PUSH;
      aside.dispatchEvent(new Event("scroll"));
    });
    expect(aside.scrollTop).toBe(0);
    expect(offsetAbove(headerRow)).toBe(0);
    expect(tools.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: /New email/ })).toBeTruthy();
  });

  it("the Settings jump to the footer, then a browser scrollIntoView of that deep section, moves only the body scroller", async () => {
    const { aside, headerRow } = await mountEmailPage();
    act(() => gotoEmailSettings("footer"));
    await screen.findByTestId("email-settings", {}, { timeout: 4000 });
    const target = await waitFor(() => {
      const el = document.getElementById(emailSettingsAnchor("footer"));
      if (!el) throw new Error("footer section not mounted");
      return el;
    });
    const body = target.closest<HTMLElement>(".ws-scroll")!;
    expect(body.contains(headerRow)).toBe(false);
    act(() => target.scrollIntoView({ block: "start" }));
    expect(body.scrollTop).toBeGreaterThan(0);
    expect(aside.scrollTop).toBe(0);
    expect(offsetAbove(headerRow)).toBe(0);
    expect(screen.queryByRole("button", { name: /New email/ })).toBeNull();
    expect(within(headerRow).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("on a phone, the sliding list/detail wrapper cannot take a vertical or sideways offset either", async () => {
    setCompact(true);
    const { aside, headerRow } = await mountEmailPage();
    const root = aside.firstElementChild as HTMLElement;
    expect(root.contains(headerRow)).toBe(true);
    act(() => {
      root.scrollTop = PUSH;
      root.scrollLeft = 400;
      aside.scrollTop = PUSH;
    });
    expect(root.scrollTop).toBe(0);
    expect(root.scrollLeft).toBe(0);
    expect(offsetAbove(headerRow)).toBe(0);
    act(() => gotoEmailSettings("footer"));
    const target = await waitFor(() => {
      const el = document.getElementById(emailSettingsAnchor("footer"));
      if (!el) throw new Error("footer section not mounted");
      return el;
    });
    act(() => target.scrollIntoView({ block: "start" }));
    expect(root.scrollTop).toBe(0);
    expect(root.scrollLeft).toBe(0);
    expect(offsetAbove(headerRow)).toBe(0);
  });
});
