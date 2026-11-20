// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ start: vi.fn(), context: vi.fn(), fetch: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionContext: api.context,
}));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));
const pop = vi.hoisted(() => ({ add: vi.fn(), follow: vi.fn() }));
vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: pop.add, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));
vi.mock("../postToast", () => ({ followPostInToast: pop.follow }));

import { TopActionsRow } from "../TopActionsRow";
import { pinterest_organic } from "../../platforms/pinterest_organic";
import { x_organic } from "../../platforms/x_organic";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const IMAGE = `${TENANT}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const proposeCalls = () => api.fetch.mock.calls.filter(([u]) => u === "/api/social/propose");
const jpg = () => new File(["x"], "photo.jpg", { type: "image/jpeg" });
const scroll = vi.fn();
const scrolled: Element[] = [];
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  pop.add.mockReset();
  pop.follow.mockReset().mockResolvedValue({ state: "posted", url: null });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  scroll.mockReset();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    scrolled.push(this);
    scroll(arg);
  };
  api.start.mockReset().mockResolvedValue({ run_id: "run-1" });
  api.context.mockReset().mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
  api.fetch.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
    if (url === "/api/social/propose") return ok({ ok: true, decision_id: "d1" });
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

async function openPin() {
  render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
  await act(async () => {});
}

async function fillPin(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Upload an image"), { target: { files: [jpg()] } });
  });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Birthday cakes" } });
  fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: text } });
  fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
  fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://cakely.example/b" } });
}

describe("a description past its limit is shown, not cut", () => {
  it("keeps every character, counts them live, says why, and holds both buttons", async () => {
    await openPin();
    const area = screen.getByLabelText("Description (optional)") as HTMLTextAreaElement;
    expect(area.hasAttribute("maxlength")).toBe(false);
    expect(screen.getByText("0 / 500")).toBeTruthy();
    await fillPin("a".repeat(501));
    expect(area.value).toHaveLength(501);
    expect(screen.getByText("501 / 500")).toBeTruthy();
    expect(screen.getByText("Keep it under 500 characters.")).toBeTruthy();
    expect(button("Post").disabled).toBe(true);
    expect(button("Send for approval").disabled).toBe(true);
    fireEvent.click(button("Post"));
    await act(async () => {});
    expect(proposeCalls()).toHaveLength(0);
    fireEvent.change(area, { target: { value: "a".repeat(500) } });
    expect(screen.getByText("500 / 500")).toBeTruthy();
    expect(screen.queryByText("Keep it under 500 characters.")).toBeNull();
    expect(button("Post").disabled).toBe(false);
  });
});

describe("a refused submit is brought into view", () => {
  it("scrolls the server's reason into view on the alert itself", async () => {
    api.fetch.mockImplementation(async (url: string) =>
      url === "/api/chat/upload-image"
        ? ok({ image_path: IMAGE })
        : { ok: false, status: 422, json: async () => ({ error: { message: "The pin links to a site that is not your company's website. Link a page on your own site." } }) },
    );
    await openPin();
    await fillPin("Made to order.");
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(button("Send for approval"));
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("not your company's website");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scrolled).toEqual([alert]);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
  });

  it("does not scroll on open or while the founder types", async () => {
    await openPin();
    await fillPin("Made to order.");
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("a channel that is not connected says so before the founder fills the form", () => {
  it("names the missing connection, links to Integrations, and never sends", async () => {
    api.context.mockResolvedValue({ boards: [], connected: false });
    await openPin();
    const line = screen.getByText(/Pinterest is not connected\. Connect it in Integrations, then create a pin\./);
    expect(line).toBeTruthy();
    expect(screen.queryByText(/Post sends it to your connected Pinterest account now/)).toBeNull();
    const link = screen.getByRole("link", { name: "Open Integrations" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/workspace?tab=settings&section=integration");
    await fillPin("Made to order.");
    expect(button("Post").disabled).toBe(true);
    expect(button("Send for approval").disabled).toBe(true);
    fireEvent.click(button("Post"));
    fireEvent.click(button("Send for approval"));
    await act(async () => {});
    expect(proposeCalls()).toHaveLength(0);
  });

  it("a connected account, or a context that does not say, keeps the normal note and buttons", async () => {
    api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }], connected: true });
    await openPin();
    expect(screen.queryByText(/is not connected/)).toBeNull();
    expect(screen.getByText(/Post sends it to your connected Pinterest account now/)).toBeTruthy();
    await fillPin("Made to order.");
    expect(button("Post").disabled).toBe(false);
    cleanup();
    render(<TopActionsRow slug="x_organic" channelName="X" actions={x_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Post with image" }));
    await act(async () => {});
    expect(screen.queryByText(/is not connected/)).toBeNull();
  });
});
