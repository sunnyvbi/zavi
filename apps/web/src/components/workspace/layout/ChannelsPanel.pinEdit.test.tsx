// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, tenantId: "tenant-1", openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));
vi.mock("@/lib/workspace/socialPostWatch", () => ({ watchSocialPost: () => new Promise(() => {}) }));
vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve(null) }));

const ORIGINAL = "Layered cake for weekend brunch";
const PIN = {
  id: "pin-1",
  decision_class: "social.publish.v2",
  channel_slug: "pinterest_organic",
  handler: "social.publish.v2",
  emitted_at: "2026-10-16T07:09:07.000Z",
  run_group: null,
  action_source: "decision",
  thread_id: null,
  status: "proposed",
  body: { channel: "pinterest_pin", payload: { title: "Cake", text: ORIGINAL, board_name: "Yoga", board_id: "1", link: "https://sweet-layers.example.com" } },
};

let approveBodies: Array<Record<string, unknown> | null> = [];
let approveStatus = 200;
let approveError: Record<string, unknown> = { code: "invalid_edit", message: "The edited post could not be applied. Review the post before approving." };
let pinReadiness: unknown = undefined;
let contextCalls = 0;
let madeBoards: Array<{ id: string; label: string }> = [];
const BOARDS = [
  { id: "1", label: "Yoga" },
  { id: "2", label: "Brunch ideas" },
];
const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: unknown) => apiFetch(path, init) }));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearChannelBoardCache();
  vi.clearAllMocks();
  approveBodies = [];
  approveStatus = 200;
  approveError = { code: "invalid_edit", message: "The edited post could not be applied. Review the post before approving." };
  pinReadiness = undefined;
  contextCalls = 0;
  madeBoards = [];
  apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && path.startsWith("/api/approvals/pin-1/approve")) {
      approveBodies.push(init.body ? JSON.parse(init.body) : null);
      const payload = approveStatus < 400 ? { ok: true } : { error: approveError };
      return { ok: approveStatus < 400, status: approveStatus, json: async () => payload, clone: () => ({ json: async () => payload }) };
    }
    const pin = pinReadiness === undefined ? PIN : { ...PIN, body: { ...PIN.body, readiness: pinReadiness } };
    if (path === "/api/channels/pinterest_organic/top-actions/create_pin/context") {
      contextCalls++;
      return { ok: true, status: 200, json: async () => ({ boards: [...BOARDS, ...madeBoards] }) };
    }
    if (path.startsWith("/api/approvals?channel=")) return { ok: true, json: async () => ({ decisions: [pin] }) };
    if (path.startsWith("/api/approvals"))
      return { ok: true, json: async () => ({ decisions: [pin], channel_pending_counts: { pinterest_organic: 1 } }) };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "pinterest_organic",
              delivery_mode: "execute",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-10-16T06:00:00.000Z",
              connected: true,
              connectors: ["composio.pinterest"],
              linked_connectors: ["composio.pinterest"],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(cleanup);

async function openPinterest() {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const t = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.startsWith("Pinterest") && /\d+ actions? waiting/.test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
  await screen.findByRole("button", { name: "Approve" });
}

async function clickApprove() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  });
}

describe("editing a staged Pinterest pin's description before approving", () => {
  it("sends the edited description as payload_text with the approve", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    const box = screen.getByRole("textbox", { name: "Post text" }) as HTMLTextAreaElement;
    expect(box.value).toBe(ORIGINAL);
    expect(screen.getByText(`${ORIGINAL.length} / 500`)).toBeTruthy();
    fireEvent.change(box, { target: { value: "Three-layer lemon cake for Sunday brunch" } });
    expect(screen.getByText("40 / 500")).toBeTruthy();
    await clickApprove();
    expect(approveBodies).toHaveLength(1);
    expect(approveBodies[0]?.payload_text).toBe("Three-layer lemon cake for Sunday brunch");
  });

  it("sends no payload_text when the description was not edited", async () => {
    await openPinterest();
    await clickApprove();
    expect(approveBodies).toHaveLength(1);
    expect(approveBodies[0] === null || !("payload_text" in approveBodies[0])).toBe(true);
  });

  it("sends no payload_text when the editor was opened but the text is unchanged", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    await clickApprove();
    expect(approveBodies).toHaveLength(1);
    expect(approveBodies[0] === null || !("payload_text" in approveBodies[0])).toBe(true);
  });

  it("disables Approve past 500 characters and sends nothing", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Post text" }), { target: { value: "a".repeat(501) } });
    expect(screen.getByText("501 / 500")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await clickApprove();
    expect(approveBodies).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox", { name: "Post text" }), { target: { value: "a".repeat(500) } });
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the server's refusal on the card and keeps the edit for another try", async () => {
    approveStatus = 400;
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Post text" }), { target: { value: "Edited copy" } });
    await clickApprove();
    expect((await screen.findByTestId("pin-approve-error")).textContent).toBe(
      "The edited post could not be applied. Review the post before approving.",
    );
    expect((screen.getByRole("textbox", { name: "Post text" }) as HTMLTextAreaElement).value).toBe("Edited copy");
    expect(screen.queryByTestId("pin-posting")).toBeNull();
  });
});

const CHECKED = { board: { status: "pass" }, media: { status: "pass" }, link: { status: "pass" }, identity: { status: "pass" } };

describe("editing a staged pin's title, board and link before approving", () => {
  it("loads the account's boards and sends only the fields that changed", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    const board = (await screen.findByRole("combobox", { name: "Pin board" })) as HTMLSelectElement;
    await vi.waitFor(() => expect(Array.from(board.options).map((o) => o.textContent)).toEqual(["Yoga", "Brunch ideas"]));
    expect(contextCalls).toBe(1);
    expect(board.value).toBe("1");
    const title = screen.getByRole("textbox", { name: "Pin title" }) as HTMLInputElement;
    expect(title.value).toBe("Cake");
    expect(screen.getByText("4 / 100")).toBeTruthy();
    fireEvent.change(title, { target: { value: "Lemon layer cake" } });
    fireEvent.change(board, { target: { value: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Pin link" }), { target: { value: "https://sweet-layers.example.com/lemon" } });
    await clickApprove();
    expect(approveBodies).toEqual([{ expected_scheduled_at: null, title: "Lemon layer cake", board_id: "2", link: "https://sweet-layers.example.com/lemon" }]);
  });

  it("sends nothing extra when the editor was opened and nothing changed", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    await screen.findByRole("combobox", { name: "Pin board" });
    await clickApprove();
    expect(approveBodies).toHaveLength(1);
    expect(approveBodies[0]).toEqual({ expected_scheduled_at: null });
  });

  it("will not approve a link that is not https or a title over 100 characters", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    const link = screen.getByRole("textbox", { name: "Pin link" });
    fireEvent.change(link, { target: { value: "http://sweet-layers.example.com" } });
    expect(screen.getByText("Use a full web address that starts with https://")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(link, { target: { value: "https://sweet-layers.example.com" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Pin title" }), { target: { value: "t".repeat(101) } });
    expect(screen.getByText("101 / 100")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    await clickApprove();
    expect(approveBodies).toHaveLength(0);
  });
});

describe("the preview while a pin's board or link is being edited", () => {
  function checkRows() {
    return Array.from(screen.getByRole("list", { name: "Pinterest checks" }).querySelectorAll("li")).map((li) => li.textContent);
  }

  it("shows the edited link and stops claiming the old board and link checks", async () => {
    pinReadiness = { ok: true, checks: CHECKED };
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    await screen.findByRole("combobox", { name: "Pin board" });
    expect(screen.getByText("Links to https://sweet-layers.example.com")).toBeTruthy();
    expect(checkRows()).toEqual(["Board · Checked", "Image · Checked", "Link · Checked", "Your site · Checked"]);
    expect(screen.queryByText("Zavi checks the new board and link again when you approve.")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Pin link" }), { target: { value: "https://shop.sweet-layers.example.com/lemon" } });
    expect(screen.getByText("Links to https://shop.sweet-layers.example.com/lemon")).toBeTruthy();
    expect(screen.queryByText("Links to https://sweet-layers.example.com")).toBeNull();
    expect(checkRows()).toEqual(["Image · Checked"]);
    expect(screen.getByText("Zavi checks the new board and link again when you approve.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Pin link" }), { target: { value: "https://sweet-layers.example.com" } });
    expect(checkRows()).toEqual(["Board · Checked", "Image · Checked", "Link · Checked", "Your site · Checked"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Pin board" }), { target: { value: "2" } });
    expect(checkRows()).toEqual(["Image · Checked"]);
    expect(screen.getByText("Zavi checks the new board and link again when you approve.")).toBeTruthy();
  });

  it("lists a board made since the editor was last opened", async () => {
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    const first = (await screen.findByRole("combobox", { name: "Pin board" })) as HTMLSelectElement;
    await vi.waitFor(() => expect(Array.from(first.options).map((o) => o.textContent)).toEqual(["Yoga", "Brunch ideas"]));
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    madeBoards = [{ id: "3", label: "Lemon cakes" }];
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    const board = (await screen.findByRole("combobox", { name: "Pin board" })) as HTMLSelectElement;
    await vi.waitFor(() => expect(Array.from(board.options).map((o) => o.textContent)).toEqual(["Yoga", "Brunch ideas", "Lemon cakes"]));
    expect(contextCalls).toBe(2);
    fireEvent.change(board, { target: { value: "3" } });
    await clickApprove();
    expect(approveBodies).toEqual([{ expected_scheduled_at: null, board_id: "3" }]);
  });
});

describe("a pin with an unverified check asks before it posts", () => {
  it("a plain Approve shows the reasons and posts nothing; Post anyway sends the confirm", async () => {
    pinReadiness = { ok: true, checks: { ...CHECKED, identity: { status: "unverified", reason_code: "pinterest_identity_unverified", reason: "Your company website is not on file." } } };
    await openPinterest();
    await clickApprove();
    expect(approveBodies).toHaveLength(0);
    const box = screen.getByTestId("pin-unverified-confirm");
    expect(box.textContent).toContain("Zavi could not check everything on this pin");
    expect(box.textContent).toContain("Your site: Your company website is not on file.");
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.queryByTestId("pin-unverified-confirm")).toBeNull();
    expect(approveBodies).toHaveLength(0);
    await clickApprove();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post anyway" }));
    });
    expect(approveBodies).toEqual([{ expected_scheduled_at: null, confirm_unverified: true }]);
  });

  it("a fully checked pin approves on one click, with no confirm flag", async () => {
    pinReadiness = { ok: true, checks: CHECKED };
    await openPinterest();
    await clickApprove();
    expect(screen.queryByTestId("pin-unverified-confirm")).toBeNull();
    expect(approveBodies).toHaveLength(1);
    expect(approveBodies[0] === null || !("confirm_unverified" in approveBodies[0])).toBe(true);
  });

  it("when an edited link comes back unverified from the server, asks with the server's reasons and resends the edit", async () => {
    pinReadiness = { ok: true, checks: CHECKED };
    approveStatus = 409;
    approveError = { code: "requires_unverified_confirm", message: "Zavi could not check everything on this pin. Link: The page only partly loaded.", unverified: ["Link: The page only partly loaded."] };
    await openPinterest();
    fireEvent.click(screen.getByRole("button", { name: "Edit pin" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Pin link" }), { target: { value: "https://shop.sweet-layers.example.com/lemon" } });
    await clickApprove();
    expect(approveBodies).toEqual([{ expected_scheduled_at: null, link: "https://shop.sweet-layers.example.com/lemon" }]);
    const box = await screen.findByTestId("pin-unverified-confirm");
    expect(box.textContent).toContain("Link: The page only partly loaded.");
    expect(screen.queryByTestId("pin-approve-error")).toBeNull();
    approveStatus = 200;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post anyway" }));
    });
    expect(approveBodies[1]).toEqual({ expected_scheduled_at: null, link: "https://shop.sweet-layers.example.com/lemon", confirm_unverified: true });
  });
});
