// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PostOutcome } from "@/lib/workspace/socialPostWatch";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, tenantId: "tenant-ig", openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));
vi.mock("@/lib/analytics/posthog", () => ({ captureEvent: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));
const { watch, apiFetch, toastAdd } = vi.hoisted(() => ({ watch: vi.fn(), apiFetch: vi.fn(), toastAdd: vi.fn() }));
vi.mock("@/lib/workspace/socialPostWatch", () => ({ watchSocialPost: watch }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/components/ui/toast", async (original) => ({
  ...(await original<typeof import("@/components/ui/toast")>()),
  toast: { add: toastAdd, close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

const POST = {
  id: "ig-post-1", decision_class: "social.publish.v2", channel_slug: "instagram_organic",
  handler: "social.publish.v2", emitted_at: "2026-10-26T07:00:00.000Z", run_group: null,
  action_source: "decision", thread_id: null, status: "proposed",
  body: { channel: "instagram_image", scheduled_at: "2099-01-02T09:30:00.000Z", payload: { text: "Original caption", image_path: "tenant-ig/image.jpg" } },
};
let approved = false;
let status = 200;
let settle: (out: PostOutcome) => void;
let releaseApproval: (() => void) | null = null;
let holdApproval = false;
const writes = () => apiFetch.mock.calls.filter(([path, init]) => path === "/api/approvals/ig-post-1/approve" && init?.method === "POST");

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearChannelBoardCache();
  vi.clearAllMocks();
  approved = false;
  status = 200;
  holdApproval = false;
  releaseApproval = null;
  watch.mockImplementation(() => new Promise<PostOutcome>((resolve) => { settle = resolve; }));
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/approvals/ig-post-1/approve" && init?.method === "POST") {
      if (holdApproval) await new Promise<void>((resolve) => { releaseApproval = resolve; });
      approved = status < 400;
      return { ok: status < 400, status, json: async () => ({}), clone: () => ({ json: async () => ({}) }) };
    }
    if (path.startsWith("/api/approvals")) return { ok: true, json: async () => ({ decisions: approved ? [] : [POST], channel_pending_counts: { instagram_organic: approved ? 0 : 1 } }) };
    if (path.startsWith("/api/channels")) return { ok: true, json: async () => ({ channels: [{ channel_slug: "instagram_organic", delivery_mode: "produce", work_state: "needs_review", priority: 1, connected: true, connectors: ["composio.instagram"], runnable: true }] }) };
    return { ok: true, json: async () => ({}) };
  });
});
afterEach(cleanup);

async function openChannel() {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const button = screen.getAllByRole("button", { expanded: false }).find((b) => b.textContent?.startsWith("Instagram"));
    if (!button) throw new Error("Instagram not loaded");
    return button;
  });
  fireEvent.click(tile);
  await screen.findByRole("button", { name: "Edit caption" });
}
async function approve() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve" })));
  await screen.findByText("Posting to Instagram…");
}
async function finish(out: PostOutcome) {
  await act(async () => settle(out));
}

describe("Instagram approval outcomes", () => {
  it("keeps a queued card across refresh and shows the actual published receipt without approving twice", async () => {
    holdApproval = true;
    await openChannel();
    const button = screen.getByRole("button", { name: "Approve" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(writes()).toHaveLength(1);
    await act(async () => releaseApproval!());
    expect(await screen.findByText("Posting to Instagram…")).toBeTruthy();
    expect(watch).toHaveBeenCalledWith("ig-post-1", undefined, { platform: "Instagram" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await act(async () => window.dispatchEvent(new Event("zavi:approvals-changed")));
    expect(screen.getByText("Posting to Instagram…")).toBeTruthy();
    await finish({ state: "posted", url: "https://www.instagram.com/p/receipt/" });
    expect(screen.getByText(/Posted to Instagram/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open post/ }).getAttribute("href")).toBe("https://www.instagram.com/p/receipt/");
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Posted to Instagram" }));
    expect(writes()).toHaveLength(1);
  });

  it("keeps provider failure visible instead of silently removing the card", async () => {
    await openChannel();
    await approve();
    await finish({ state: "failed", message: "Instagram rejected the image." });
    expect(screen.getByRole("alert").textContent).toContain("Instagram rejected the image.");
    expect(screen.getByText("Original caption")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it("reconciles an ambiguous approval without sending a second request or claiming it failed", async () => {
    status = 502;
    await openChannel();
    await approve();
    await finish({ state: "uncertain", message: "Check Instagram before trying again." });
    expect(screen.getByRole("alert").textContent).toBe("Check Instagram before trying again.");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it("resumes a slow receipt on focus without repeating approval", async () => {
    await openChannel();
    await approve();
    await finish({ state: "slow" });
    expect(screen.getByRole("alert").textContent).toContain("Still posting. Instagram");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
    await finish({ state: "posted", url: null });
    expect(screen.getByText(/Posted to Instagram/)).toBeTruthy();
    expect(writes()).toHaveLength(1);
  });

  it("shows scheduled rather than claiming an immediately published post", async () => {
    await openChannel();
    await approve();
    await finish({ state: "scheduled", scheduledAt: POST.body.scheduled_at });
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Scheduled for Instagram" }));
    expect(screen.queryByText(/Posted to Instagram/)).toBeNull();
    expect(writes()).toHaveLength(1);
  });
});

describe("Instagram caption review", () => {
  it.each(["", "x".repeat(2201)])("explains invalid edited captions in both drawer and card until repaired", async (invalid) => {
    await openChannel();
    fireEvent.click(screen.getByRole("button", { name: "Edit caption" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Post text" }), { target: { value: invalid } });
    const drawer = within(screen.getByRole("dialog"));
    expect((drawer.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(drawer.getAllByRole("alert").some((node) => /caption.*before approving/.test(node.textContent ?? ""))).toBe(true);
    if (invalid) expect(drawer.queryByText(/will be cut:/)).toBeNull();
    fireEvent.click(drawer.getByRole("button", { name: "Close" }));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit caption" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Post text" }), { target: { value: "x".repeat(2198) + "🚗" } });
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    expect(writes()).toHaveLength(0);
  });
  it("preserves edited copy and focus across typing, close and list refresh, then sends it only on approval", async () => {
    await openChannel();
    fireEvent.click(screen.getByRole("button", { name: "Edit caption" }));
    const editor = await screen.findByRole("textbox", { name: "Post text" });
    editor.focus();
    fireEvent.change(editor, { target: { value: "Corrected caption 🚗" } });
    expect(document.activeElement).toBe(editor);
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.getByText("Corrected caption 🚗")).toBeTruthy();
    await act(async () => window.dispatchEvent(new Event("zavi:approvals-changed")));
    fireEvent.click(await screen.findByRole("button", { name: "Edit caption" }));
    expect((screen.getByRole("textbox", { name: "Post text" }) as HTMLTextAreaElement).value).toBe("Corrected caption 🚗");
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" })));
    expect(JSON.parse(writes()[0]![1].body)).toEqual({ expected_scheduled_at: POST.body.scheduled_at, payload_text: "Corrected caption 🚗" });
    expect(await screen.findByText("Posting to Instagram…")).toBeTruthy();
    expect(screen.getByText("Corrected caption 🚗")).toBeTruthy();
    await finish({ state: "failed", message: "Image could not be processed." });
    expect(writes()).toHaveLength(1);
  });

  it("keeps corrected copy when approval is refused and does not start a publication watcher", async () => {
    status = 400;
    await openChannel();
    fireEvent.click(screen.getByRole("button", { name: "Edit caption" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Post text" }), { target: { value: "Keep this correction" } });
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" })));
    expect((screen.getByRole("textbox", { name: "Post text" }) as HTMLTextAreaElement).value).toBe("Keep this correction");
    expect(watch).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it("retains edits if reconciliation says the original decision still awaits approval", async () => {
    status = 502;
    await openChannel();
    fireEvent.click(screen.getByRole("button", { name: "Edit caption" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Post text" }), { target: { value: "Still my caption" } });
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" })));
    await finish({ state: "approval_uncertain" });
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit caption" }));
    expect((screen.getByRole("textbox", { name: "Post text" }) as HTMLTextAreaElement).value).toBe("Still my caption");
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("original post") }));
    expect(writes()).toHaveLength(1);
  });
});
