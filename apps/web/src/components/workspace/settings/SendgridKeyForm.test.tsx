// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sendgridCampaignReady } from "@zavi/shared";

const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
const resp: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} };
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: resp.ok, status: resp.status, json: () => Promise.resolve(resp.body) });
  },
}));

import { SENDGRID_CONNECTED_EVENT, SendgridKeyForm, SendgridPermissionList } from "./SendgridKeyForm";

const KEY = "SG.northwindKeyId01.northwindSecret_abcdefghij";
const perms = (missing: string[]) =>
  [
    ["mail_send", "Mail Send"],
    ["marketing_lists_read", "Marketing: lists"],
    ["single_sends_write", "Marketing: Single Sends"],
    ["stats_read", "Stats"],
    ["senders_read", "Sender verification (read)"],
    ["suppression_groups_read", "Unsubscribe groups (read)"],
  ].map(([group, label]) => ({ group, label, passed: !missing.includes(group) }));

beforeEach(() => {
  calls.length = 0;
  resp.ok = true;
  resp.status = 200;
});
afterEach(cleanup);

async function paste(onConnected?: () => void) {
  render(<SendgridKeyForm onClose={() => {}} onConnected={onConnected} />);
  fireEvent.change(screen.getByPlaceholderText("SG.…"), { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(calls).toHaveLength(1));
}

describe("SendgridKeyForm", () => {
  it("posts the key once and shows every permission passed", async () => {
    resp.body = { ok: true, campaign_ready: true, permissions: perms([]) };
    await paste();
    expect(calls[0]).toEqual({ url: "/api/connectors/email", init: { method: "POST", body: JSON.stringify({ api_key: KEY }) } });
    await waitFor(() => expect(screen.getByText("SendGrid is connected")).toBeDefined());
    expect(screen.getAllByText("passed")).toHaveLength(6);
  });

  it("the key steps say Custom Access, the name SendGrid uses, never Restricted Access", () => {
    render(<SendgridKeyForm onClose={() => {}} />);
    const steps = screen.getByText(/How to connect SendGrid/).parentElement?.textContent ?? "";
    expect(steps).toContain("create a key with Custom Access");
    expect(steps).not.toMatch(/restricted/i);
  });

  it("a key missing campaign permissions says so and names them", async () => {
    resp.body = { ok: true, campaign_ready: false, permissions: perms(["stats_read", "suppression_groups_read"]) };
    await paste();
    await waitFor(() => expect(screen.getByText("Needs more permissions for campaigns")).toBeDefined());
    expect(screen.getAllByText("missing")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "SendGrid permissions" }).textContent).toContain("Unsubscribe groups (read)");
  });

  it("a refused key shows the server's sentence and stores nothing on screen", async () => {
    resp.ok = false;
    resp.status = 400;
    resp.body = { error: { message: "SendGrid did not accept this key." } };
    await paste();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn’t connect SendGridSendGrid did not accept this key.");
    expect(screen.queryByText("SendGrid is connected")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("SG.…"), { target: { value: KEY + "x" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells the page to re-read connectors once the key is saved, so the card flips to connected", async () => {
    const onConnected = vi.fn();
    resp.body = { ok: true, campaign_ready: true, permissions: perms([]) };
    await paste(onConnected);
    await waitFor(() => expect(screen.getByText("SendGrid is connected")).toBeDefined());
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("re-reads connectors for a key saved without campaign permissions too", async () => {
    const onConnected = vi.fn();
    resp.body = { ok: true, campaign_ready: false, permissions: perms(["stats_read"]) };
    await paste(onConnected);
    await waitFor(() => expect(screen.getByText("Needs more permissions for campaigns")).toBeDefined());
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("never claims a connection when the key is refused or the server answers 200 with an error", async () => {
    const onConnected = vi.fn();
    resp.ok = false;
    resp.status = 400;
    resp.body = { error: { message: "SendGrid did not accept this key." } };
    await paste(onConnected);
    expect((await screen.findByRole("alert")).textContent).toContain("SendGrid did not accept this key.");
    cleanup();
    calls.length = 0;
    resp.ok = true;
    resp.status = 200;
    resp.body = { error: { message: "Could not save the SendGrid connection." } };
    await paste(onConnected);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save the SendGrid connection.");
    expect(screen.queryByText("SendGrid is connected")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("SendgridKeyForm exits", () => {
  it("entering a key shows Connect and Cancel and no Close; the result shows exactly one Done and no Cancel", async () => {
    resp.body = { ok: true, campaign_ready: false, permissions: perms(["stats_read"]) };
    const onClose = vi.fn();
    render(<SendgridKeyForm onClose={onClose} />);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByPlaceholderText("SG.…"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("button", { name: "Done" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /close|cancel/i })).toBeNull();
  });
});

describe("SendgridKeyForm review fixes", () => {
  it("saving tells the page immediately; Done closes in place without reloading", async () => {
    resp.body = { ok: true, campaign_ready: true, permissions: perms([]) };
    const onClose = vi.fn();
    const onConnected = vi.fn();
    const heard = vi.fn();
    window.addEventListener(SENDGRID_CONNECTED_EVENT, heard);
    const reload = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...loc, reload, pathname: "/workspace" } });
    try {
      render(<SendgridKeyForm onClose={onClose} onConnected={onConnected} />);
      fireEvent.change(screen.getByPlaceholderText("SG.…"), { target: { value: KEY } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
      expect(heard).toHaveBeenCalledTimes(1);
      fireEvent.click(await screen.findByRole("button", { name: "Done" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: loc });
      window.removeEventListener(SENDGRID_CONNECTED_EVENT, heard);
    }
  });

  it("links to SendGrid's API keys page, says Send without asking is the exception, and uses design tokens, not hex colors", async () => {
    const { container } = render(<SendgridKeyForm onClose={() => {}} />);
    const link = screen.getByRole("link", { name: /API Keys/ });
    expect(link.getAttribute("href")).toBe("https://app.sendgrid.com/settings/api_keys");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(container.textContent).toMatch(/unless you turn on Send without asking in Autopilot/);
    const guide = screen.getByText("How to connect SendGrid (~2 min)").parentElement!;
    expect(guide.outerHTML).not.toMatch(/#[0-9a-fA-F]{6}/);
    cleanup();
    const list = render(<SendgridPermissionList result={{ campaign_ready: false, permissions: perms(["stats_read"]) }} />);
    expect(list.container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

describe("sendgridCampaignReady", () => {
  it("is true only when every group is in the stored list", () => {
    expect(sendgridCampaignReady(perms([]).map((p) => p.group))).toBe(true);
    expect(sendgridCampaignReady(["mail_send"])).toBe(false);
    expect(sendgridCampaignReady(null)).toBe(false);
  });
});
