// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const KEY = "SG.northwindKeyId01.northwindSecret_abcdefghij";
const post = vi.hoisted(() => ({ body: {} as unknown }));
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: () => Promise.resolve(post.body) };
    return { ok: true, status: 200, json: () => Promise.resolve({ routes: [], gmail: { status: "off" } }) };
  },
}));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: vi.fn(() => Promise.resolve()) }));

import { EmailConnectTiles, forgetConnected } from "../EmailConnectTiles";

const perms = (missing: string[]) => ["mail_send", "stats_read"].map((g) => ({ group: g, label: g, passed: !missing.includes(g) }));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  forgetConnected();
});
afterEach(cleanup);

async function openForm() {
  render(<EmailConnectTiles />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect SendGrid" }));
  return screen.getByRole("dialog", { name: "Connect SendGrid" });
}

async function submit(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByPlaceholderText("SG.…"), { target: { value: KEY } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
  await within(dialog).findByRole("button", { name: "Done" });
}

describe("Connect SendGrid popup single exit", () => {
  it("while entering a key: Connect and Cancel only, no X, no Close, no footer bar", async () => {
    const dialog = await openForm();
    expect(within(dialog).queryByRole("button", { name: /close/i })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(within(dialog).queryByTestId("action-modal-footer")).toBeNull();
  });

  it("Cancel closes the popup", async () => {
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Connect SendGrid" })).toBeNull();
  });

  it("needs-more-permissions result has exactly one Done, nothing named Close, and Done closes it", async () => {
    post.body = { ok: true, campaign_ready: false, permissions: perms(["stats_read"]) };
    const dialog = await openForm();
    await submit(dialog);
    expect(within(dialog).getByText("Needs more permissions for campaigns")).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: "Done" })).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: /close/i })).toBeNull();
    expect(within(dialog).queryByTestId("action-modal-footer")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Connect SendGrid" })).toBeNull();
  });

  it("connected result has exactly one Done and no Close", async () => {
    post.body = { ok: true, campaign_ready: true, permissions: perms([]) };
    const dialog = await openForm();
    await submit(dialog);
    expect(within(dialog).getByText("SendGrid is connected")).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: "Done" })).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("Escape still closes the popup", async () => {
    const dialog = await openForm();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect SendGrid" })).toBeNull());
  });
});
