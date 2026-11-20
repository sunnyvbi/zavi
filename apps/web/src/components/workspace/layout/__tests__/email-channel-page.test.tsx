// @vitest-environment jsdom
import { forgetPaused } from "../../email/EmailSendingSwitch";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const answers: Record<string, unknown> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    const body = answers[path] ?? {};
    return { ok: true, status: 200, json: async () => body };
  }),
}));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { ChannelDetailPage, type ChannelDetail } from "../ChannelDrawer";
import { gotoEmailSettings } from "../../email/emailSettingsNav";

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

beforeEach(() => {
  forgetPaused();
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/api/workspace/email-pause"] = { paused: false };
  answers["/api/workspace/email-test-lists"] = { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [] };
  answers["/api/workspace/email-plan"] = { ok: true, role: "owner", timezone: "UTC", items: [], holds: [], released: [] };
});
afterEach(cleanup);

describe("Email campaigns channel page", () => {
  it("has Overview, Analytics and Settings with one New email button and no old Overview panels", async () => {
    render(<ChannelDetailPage detail={detail} actionCount={0} error={null} onClose={() => {}} onOpenConnectors={() => {}} />);
    expect(await screen.findByRole("tab", { name: /^Analytics/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Settings/ })).toBeTruthy();
    expect(await screen.findAllByRole("button", { name: /New email/ })).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: "Email sending" })).toBeNull();
    expect(screen.queryByTestId("email-connect")).toBeNull();
    expect(screen.queryByTestId("actions-lead")).toBeNull();
    expect(screen.queryByText("How your emails are doing")).toBeNull();
  });

  it("a settings goto from anywhere opens the Settings tab with that section on the page", async () => {
    render(<ChannelDetailPage detail={detail} actionCount={0} error={null} onClose={() => {}} onOpenConnectors={() => {}} />);
    await screen.findAllByRole("button", { name: /New email/ });
    expect(screen.queryByTestId("email-settings")).toBeNull();
    act(() => gotoEmailSettings("footer"));
    expect(await screen.findByTestId("email-settings")).toBeTruthy();
    expect(document.querySelector("[data-settings-section='footer']")).toBeTruthy();
    expect(document.querySelector("[data-settings-section='contacts']")).toBeTruthy();
    expect(screen.getByTestId("channel-tab-overview").hidden).toBe(true);
    expect(screen.getByRole("heading", { name: "Before Zavi posts" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Email sending" })).toBeTruthy();
  });
});
