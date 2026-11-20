// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

let pauseBody: unknown = { paused: false, held: "disabled" };
let pauseCalls = 0;
let failNext = false;
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) => {
    if (url === "/api/workspace/email-pause") {
      pauseCalls++;
      if (failNext) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: "down" } }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(pauseBody) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));

import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { EmailSendingSwitch, forgetPaused } from "../EmailSendingSwitch";

function mount() {
  const badge = document.createElement("span");
  document.body.appendChild(badge);
  return render(
    <ChannelPageHeaderSlotProvider element={null} badgeElement={badge}>
      <EmailSendingSwitch />
    </ChannelPageHeaderSlotProvider>,
  );
}

beforeEach(() => {
  forgetPaused();
  pauseBody = { paused: false, held: "disabled" };
  pauseCalls = 0;
  failNext = false;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the Zavi sender stopped badge follows the server without a reload", () => {
  it("disappears on window focus once staff clear the hold, without remounting", async () => {
    mount();
    expect(await screen.findByTestId("email-held-badge")).toBeTruthy();
    const sw = screen.getByRole("switch", { name: "Email sending" });
    pauseBody = { paused: false, held: null };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.queryByTestId("email-held-badge")).toBeNull());
    expect(screen.getByRole("switch", { name: "Email sending" })).toBe(sw);
  });

  it("disappears when the tab becomes visible again", async () => {
    mount();
    await screen.findByTestId("email-held-badge");
    pauseBody = { paused: false, held: null };
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.queryByTestId("email-held-badge")).toBeNull());
  });

  it("a failed refresh keeps the last known state instead of blanking the switch", async () => {
    mount();
    await screen.findByTestId("email-held-badge");
    failNext = true;
    const before = pauseCalls;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(pauseCalls).toBe(before + 1));
    expect(screen.getByTestId("email-held-badge")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Email sending" })).toBeTruthy();
  });

  it("stops listening after unmount", async () => {
    const view = mount();
    await screen.findByTestId("email-held-badge");
    view.unmount();
    const before = pauseCalls;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pauseCalls).toBe(before);
  });
});
