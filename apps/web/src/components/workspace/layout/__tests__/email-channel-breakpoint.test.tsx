// @vitest-environment jsdom
import React from "react";
import { forgetConnected } from "../../email/EmailConnectTiles";
import { forgetPaused } from "../../email/EmailSendingSwitch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const viewport = vi.hoisted(() => ({ compact: false, listeners: new Set<() => void>() }));
vi.mock("@/lib/responsive", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (fire: () => void) => {
    viewport.listeners.add(fire);
    return () => {
      viewport.listeners.delete(fire);
    };
  };
  const useIsCompact = () => useSyncExternalStore(subscribe, () => viewport.compact, () => false);
  return { useIsCompact, useMediaMatch: useIsCompact, COMPACT_MAX_PX: 639, COMPACT_QUERY: "(max-width: 639px)" };
});

const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Newsletter",
  created_at: "2026-10-01T00:00:00Z",
  latest: { id: "v-a", source_kind: "csv", source_label: "Email", contact_count: 12, created_at: "2026-10-01T00:00:00Z", consented: true },
  active: { id: "v-a", contact_count: 12, sendable: 11, unsubscribed_or_bounced: 1 },
  needs_consent: false,
};
const answers: Record<string, unknown> = {};
const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.push(url);
    const path = url.split("?")[0];
    return { ok: true, status: 200, json: async () => answers[path] ?? {} };
  }),
}));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: "Brightloop" }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../ChannelActionChat", () => ({ ChannelActionChat: () => <div data-testid="channel-chat" /> }));

const href = vi.hoisted(() => ({ value: "/workspace?tab=channels&channel=email_marketing", listeners: new Set<() => void>() }));
vi.mock("../../navigation/useWorkspaceLocation", async () => {
  const { useReducer, useEffect } = await import("react");
  return {
    useWorkspaceLocation: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        href.listeners.add(force);
        return () => {
          href.listeners.delete(force);
        };
      }, [force]);
      return href.value;
    },
  };
});
vi.mock("../../navigation/workspaceRoutes", async (importOriginal) => {
  const move = (next: string) => {
    href.value = next;
    href.listeners.forEach((fire) => fire());
  };
  return {
    ...(await importOriginal<typeof import("../../navigation/workspaceRoutes")>()),
    readWorkspaceLocation: () => href.value,
    replaceWorkspaceLocation: move,
    pushWorkspaceLocation: move,
  };
});

import { ChannelsPage, type ChannelEntry } from "../ChannelsPage";
import { ChannelDetailPage, type ChannelDetail } from "../ChannelDrawer";

const email = (CHANNELS as readonly Channel[]).find((c) => c.slug === "email_marketing")!;
const detail: ChannelDetail = {
  channel: email,
  mode: "produce",
  connected: false,
  connectors: [],
  workState: "idle",
  lastRunAt: null,
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};
const entry = { channel: email, count: 0, waiting: 0, subtitle: null, lock: null } as unknown as ChannelEntry;

function renderChannels() {
  return render(
    <ChannelsPage
      entries={[entry]}
      loading={false}
      onShow={() => {}}
      onUpgrade={() => {}}
      renderDetail={(_slug, close, leading) => (
        <ChannelDetailPage detail={detail} actionCount={0} error={null} leading={leading} onClose={close} onOpenConnectors={() => {}} />
      )}
    />,
  );
}

function resizeAcrossBreakpoint(compact: boolean) {
  act(() => {
    viewport.compact = compact;
    viewport.listeners.forEach((fire) => fire());
  });
}

const settingsTab = () => screen.getByRole("tab", { name: /^Settings/ });
const uploadDialog = () => screen.queryByRole("dialog", { name: "Upload contacts" });

beforeEach(() => {
  forgetConnected();
  forgetPaused();
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/api/workspace/email-pause"] = { paused: false };
  answers["/api/workspace/email-test-lists"] = { routes: [], orphans: [] };
  answers["/api/workspace/email-plan"] = { ok: true, role: "owner", timezone: "UTC", items: [], holds: [], released: [] };
  answers["/api/workspace/email-lists"] = { lists: [LIST] };
  answers["/api/workspace/email-contacts"] = { rows: [], total: 0, counts: { contacts: 1234, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false };
  window.matchMedia = ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  viewport.compact = false;
  href.value = "/workspace?tab=channels&channel=email_marketing";
  window.localStorage.clear();
});

async function openSettingsAndUploadDialog() {
  await waitFor(() => expect(settingsTab()).toBeTruthy());
  fireEvent.click(settingsTab());
  expect(settingsTab().getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(screen.getByTestId("stat-contacts").textContent).toBe("1,234"));
  fireEvent.click(screen.getByRole("button", { name: "Upload CSV" }));
  const dialog = await screen.findByRole("dialog", { name: "Upload contacts" });
  return { dialog };
}

describe("Flow 79: the email channel survives a resize across the phone breakpoint", () => {
  for (const [label, from, to] of [
    ["900px to 390px", false, true],
    ["390px to 1280px", true, false],
  ] as const) {
    it(`${label} keeps the Settings tab selected, the Upload CSV dialog open and the contacts not refetched`, async () => {
      viewport.compact = from;
      renderChannels();
      const { dialog } = await openSettingsAndUploadDialog();
      const listFetches = calls.filter((u) => u === "/api/workspace/email-lists").length;

      resizeAcrossBreakpoint(to);

      expect(settingsTab().getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("tab", { name: /^Overview/ }).getAttribute("aria-selected")).toBe("false");
      expect(uploadDialog()).toBe(dialog);
      expect(document.body.contains(dialog)).toBe(true);
      expect(href.value).toBe("/workspace?tab=channels&channel=email_marketing");

      resizeAcrossBreakpoint(from);

      expect(settingsTab().getAttribute("aria-selected")).toBe("true");
      expect(uploadDialog()).toBe(dialog);
      await act(async () => {});
      expect(calls.filter((u) => u === "/api/workspace/email-lists").length).toBe(listFetches);
    });
  }
});
