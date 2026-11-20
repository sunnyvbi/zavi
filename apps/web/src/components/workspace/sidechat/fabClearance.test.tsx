// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { CHANNELS, type Channel } from "@zavi/shared";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/components/workspace/agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
vi.mock("@/lib/workspace/agentChatsApi", () => ({ listAgentChats: async () => [] }));
vi.mock("@/lib/workspace/useGrowthStrategy", () => ({
  useGrowthStrategy: () => ({ strategy: {}, intakeStarted: true, loading: false, reload: vi.fn() }),
}));
vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({
    seedComposer: vi.fn(),
    tabs: [],
    openAgentTab: vi.fn(),
    setActiveTab: vi.fn(),
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("@/components/workspace/GrowthCoachPage", () => ({
  GrowthCoachPage: () => <p>plan</p>,
}));
vi.mock("@/components/workspace/sidechat/SideChat", async (orig) => ({
  ...(await orig<typeof import("./SideChat")>()),
  SideChat: (props: { id?: string; open?: boolean; title?: ReactNode }) => (
    <aside id={props.id} hidden={!props.open}>
      {props.title}
    </aside>
  ),
}));

import { SideChatFab } from "./SideChat";
import { ChannelDetailPage } from "../layout/ChannelDrawer";
import type { ChannelDetail } from "../layout/channelDetail";
import { AutopilotTab } from "../AutopilotTab";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function setCompact(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: compact && query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/settings")) return ok({ fields: {} });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
  setCompact(true);
});
afterEach(cleanup);

const REM = 16;
const SAFE_AREAS = [0, 20, 34, 47];
const MIN_GAP_PX = 8;

function lengthOf(raw: string, safeArea: number): number {
  const scale = /^\d+(\.\d+)?$/.exec(raw);
  if (scale) return Number(raw) * 4;
  const arbitrary = /^\[(.+)\]$/.exec(raw);
  if (!arbitrary) throw new Error(`unreadable length: ${raw}`);
  let expr = arbitrary[1];
  const calc = /^calc\((.+)\)$/.exec(expr);
  if (calc) expr = calc[1];
  const terms = expr.split(/\+(?![^(]*\))/);
  return terms.reduce((sum, term) => {
    const t = term.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(\d+(?:\.\d+)?)rem$/.exec(t))) return sum + Number(m[1]) * REM;
    if ((m = /^(\d+(?:\.\d+)?)px$/.exec(t))) return sum + Number(m[1]);
    if (/^env\(safe-area-inset-bottom(,0px)?\)$/.test(t)) return sum + safeArea;
    throw new Error(`unreadable term: ${t}`);
  }, 0);
}

function lastToken(className: string, pattern: RegExp): string | null {
  let found: string | null = null;
  for (const token of className.split(/\s+/)) {
    const m = pattern.exec(token);
    if (m) found = m[1];
  }
  return found;
}

function fabTopFromBottom(fab: HTMLElement, safeArea: number): number {
  const bottom = lastToken(fab.className, /^bottom-(.+)$/);
  const height = lastToken(fab.className, /^h-(.+)$/);
  expect(bottom).not.toBeNull();
  expect(height).not.toBeNull();
  return lengthOf(bottom!, safeArea) + lengthOf(height!, safeArea);
}

function phoneBottomPadding(el: HTMLElement, safeArea: number): number {
  const compact = lastToken(el.className, /^compact:pb-(.+)$/);
  const plain = lastToken(el.className, /^(?:pb|py|p)-(.+)$/);
  const raw = compact ?? plain;
  return raw === null ? 0 : lengthOf(raw, safeArea);
}

function renderFab(): HTMLElement {
  render(<SideChatFab onOpen={() => {}} label="probe fab" />);
  const fab = screen.getByRole("button", { name: "probe fab" });
  cleanup();
  return fab;
}

const detail = (slug: string): ChannelDetail => ({
  channel: (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!,
  mode: "produce",
  connected: true,
  connectors: [],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
});

describe("content under the floating chat button on a phone", () => {
  it("reads the FAB geometry it guards against, safe area included", () => {
    const fab = renderFab();
    expect(fabTopFromBottom(fab, 0)).toBe(64);
    expect(fabTopFromBottom(fab, 34)).toBe(98);
  });

  it.each(SAFE_AREAS)(
    "a channel page's scroll body ends clear of the FAB with a %ipx home-indicator inset",
    async (safeArea) => {
      const fabTop = fabTopFromBottom(renderFab(), safeArea);
      const { container } = render(
        <ChannelDetailPage
          detail={detail("generated_video")}
          actionCount={0}
          error={null}
          onClose={() => {}}
          onOpenConnectors={() => {}}
        />,
      );
      await waitFor(() => expect(apiFetch).toHaveBeenCalled());
      const body = container.querySelector<HTMLElement>(".ws-scroll")!;
      expect(body).not.toBeNull();
      expect(phoneBottomPadding(body, safeArea)).toBeGreaterThanOrEqual(fabTop + MIN_GAP_PX);
    },
  );

  it.each(SAFE_AREAS)(
    "Growth's plan ends clear of its FAB with a %ipx home-indicator inset",
    (safeArea) => {
      const { container } = render(<AutopilotTab />);
      const fab = screen.getByRole("button", { name: "Chat with Zavi about your growth" });
      const fabTop = fabTopFromBottom(fab, safeArea);
      const scroller = container.querySelector<HTMLElement>("main")!;
      const content = scroller.firstElementChild as HTMLElement;
      const pad = phoneBottomPadding(scroller, safeArea) + phoneBottomPadding(content, safeArea);
      expect(pad).toBeGreaterThanOrEqual(fabTop + MIN_GAP_PX);
    },
  );

  it("leaves the desktop bottom padding of a channel page as it was", async () => {
    const { container } = render(
      <ChannelDetailPage
        detail={detail("generated_video")}
        actionCount={0}
        error={null}
        onClose={() => {}}
        onOpenConnectors={() => {}}
      />,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = container.querySelector<HTMLElement>(".ws-scroll")!;
    const tokens = body.className.split(/\s+/);
    expect(tokens).toContain("pb-6");
    expect(tokens.filter((t) => /^pb-/.test(t))).toEqual(["pb-6"]);
  });
});
