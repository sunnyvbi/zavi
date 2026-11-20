// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Res = { ok: true; data: unknown } | { ok: false; message: string; status: number };

const net = vi.hoisted(() => ({
  calls: [] as { path: string; body?: unknown }[],
  threads: [] as unknown[],
  messages: [] as unknown[],
}));

vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  callJson: vi.fn(async (path: string, init?: { body?: unknown }): Promise<Res> => {
    net.calls.push({ path, body: init?.body });
    if (path === "/api/creators/threads") return { ok: true, data: { threads: net.threads } };
    if (path === "/api/creators/threads/t1/messages" && init?.body) {
      const message = { id: "m2", sender_kind: "tenant", body: (init.body as { body: string }).body, created_at: "2026-10-16T10:05:00.000Z" };
      net.messages.push(message);
      return { ok: true, data: { message } };
    }
    if (path === "/api/creators/threads/t1/messages") return { ok: true, data: { messages: [...net.messages] } };
    return { ok: false, message: "The external creator marketplace is not available.", status: 410 };
  }),
}));

import { MessagesDrawerHost } from "./MessagesDrawer";

const THREAD = {
  thread_id: "t1",
  human_member_id: "m1",
  display_name: "Maya Films",
  last_message: { body: "Hi", sender_kind: "creator", created_at: "2026-10-16T10:00:00.000Z" },
  last_message_at: "2026-10-16T10:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
  net.calls.length = 0;
  net.threads = [THREAD];
  net.messages = [{ id: "m1", sender_kind: "creator", body: "Hi", created_at: "2026-10-16T10:00:00.000Z" }];
});
afterEach(cleanup);

describe("creator messages with the marketplace retired", () => {
  it("lets a buyer read and answer an existing conversation without any offer or hire control", async () => {
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1");
    render(<MessagesDrawerHost />);

    await waitFor(() => expect(screen.getByText("Hi")).toBeTruthy());
    expect(screen.getByText("Messages with Maya Films")).toBeTruthy();
    expect(screen.queryByText(/custom offer/i)).toBeNull();
    expect(screen.queryByText(/Find creators/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /book|hire/i })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Message Maya"), { target: { value: "Thanks, looks good" } });
    fireEvent.submit(screen.getByPlaceholderText("Message Maya").closest("form")!);
    await waitFor(() => expect(screen.getByText("Thanks, looks good")).toBeTruthy());

    expect(net.calls).toContainEqual({ path: "/api/creators/threads/t1/messages", body: { body: "Thanks, looks good" } });
    const allowed = ["/api/creators/threads", "/api/creators/threads/t1/messages"];
    expect(net.calls.every((call) => allowed.includes(call.path))).toBe(true);
  });

  it("shows no composer when the workspace has no existing conversation", async () => {
    net.threads = [];
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc&drawer=thread&creator=someone-new");
    render(<MessagesDrawerHost />);
    await waitFor(() => expect(screen.getByText("No conversations with creators on existing jobs.")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(net.calls.some((call) => call.body !== undefined)).toBe(false);
    expect(net.calls.some((call) => call.path.includes("someone-new"))).toBe(false);
  });

  it.each(["find", "hire", "brief", "applicants", "inbox", "job", "review"])("does not open the %s drawer", (name) => {
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=ugc&drawer=${name}&job=j1&package=p1&brief=b1`);
    const { container } = render(<MessagesDrawerHost />);
    expect(container.innerHTML).toBe("");
    expect(net.calls).toEqual([]);
  });
});
