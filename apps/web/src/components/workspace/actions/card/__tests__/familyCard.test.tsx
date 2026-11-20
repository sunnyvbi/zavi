// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FamilyCard } from "../FamilyCard";
import { makeAction } from "../../__tests__/fixtures";
import type { ActionHandlers } from "../../types";
import type { ChannelActionBody } from "@/lib/workspace/channelActionsApi";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(cleanup);

function handlers(over: Partial<ActionHandlers> = {}): ActionHandlers {
  return { onSetStatus: vi.fn(async () => true), onRedo: vi.fn(), onReopen: vi.fn(async () => true), ...over };
}

describe("organic card", () => {
  it("copies, asks to confirm, marks acted and can undo", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const h = handlers();
    const a = makeAction("text_post", { card_kind: "post", primary_label: "Copy post", done_label: "I posted it", title: "Renter question", body: { step: { deliverable: { kind: "post", content: "Hello renters" } } } });
    render(<FamilyCard action={a} handlers={h} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy post" })));
    expect(writeText).toHaveBeenCalledWith("Hello renters");
    expect(screen.getByText("Copied")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "I posted it" })));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
    expect(screen.getByRole("status").textContent).toBe("I posted it");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(h.onReopen).toHaveBeenCalledWith(a);
    expect(screen.getByRole("button", { name: "Copy post" })).toBeTruthy();
  });

  it("the close icon closes the card toward History, and undoes", async () => {
    const h = handlers();
    const a = makeAction("fix", { title: "No pinned post" });
    render(<FamilyCard action={a} handlers={h} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close “No pinned post”" })));
    expect(screen.getByRole("status").textContent).toBe("Closed");
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "rejected", expect.objectContaining({ keep: true }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(screen.getByRole("article", { name: "No pinned post" })).toBeTruthy();
  });

  it("toggles How it works and sends an Ask Zavi question to the side chat", async () => {
    const onOpenChat = vi.fn();
    const a = makeAction("fix", { title: "Fix bio", how_to: ["Open settings", "Paste it", "Save"], brief: { title: "Fix bio", lead: null, points: [], steps: ["Open settings", "Paste it", "Save"] } });
    render(<FamilyCard action={a} handlers={handlers({ onOpenChat })} />);
    const how = screen.getByRole("button", { name: "How it works" });
    fireEvent.click(how);
    expect(how.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Paste it")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Zavi" }));
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Why now?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onOpenChat).toHaveBeenCalledWith(a, "Why now?");
  });

  it("posts the edited text", async () => {
    const onPublish = vi.fn(async () => true);
    const h = handlers({ onPublish });
    const a = makeAction("text_post", { title: "Post it", body: { step: { deliverable: { kind: "post", content: "Old" } } } });
    render(<FamilyCard action={a} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit post" }), { target: { value: "New words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post on X" })));
    expect(onPublish).toHaveBeenCalledWith(a, { text: "New words", thread: null });
    expect(screen.getByRole("status").textContent).toBe("Posted on X");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("paid card", () => {
  it.each<[string, ChannelActionBody, string]>([
    ["an image link on the review", { ad_review: { creatives: [{ title: "Rent cars from $39/day", body: "Flexible extensions", call_to_action: "LEARN_MORE", image_url: "https://cdn.example.com/car.jpg" }] } }, "img"],
    ["media attached to the card", { media: { kind: "image", url: "https://cdn.example.com/car.jpg" }, ad_review: { creatives: [{ title: "Rent cars from $39/day", body: "Flexible extensions", call_to_action: "LEARN_MORE" }] } }, "img"],
    ["a video on the review", { ad_review: { creatives: [{ title: "Rent cars from $39/day", body: "Flexible extensions", call_to_action: "LEARN_MORE", video_url: "https://cdn.example.com/car.mp4" }] } }, "video"],
  ])("draws %s as a thumbnail beside the copy", (_, body, tag) => {
    const a = makeAction("create_ad", { channel_slug: "meta_ads", title: "Add the ad", body });
    render(<FamilyCard action={a} handlers={handlers()} />);
    const preview = screen.getByTestId("ads-preview");
    expect(preview.querySelector(tag)).not.toBeNull();
    expect(within(preview).getByText("Rent cars from $39/day")).toBeTruthy();
    expect(within(preview).getByText("Flexible extensions")).toBeTruthy();
    expect(within(preview).getByText("Learn more")).toBeTruthy();
    expect(screen.getByTestId("action-kind").textContent).toBe(tag === "video" ? "Video ad" : "Image ad");
  });

  it("shows change rows and approves without undo", async () => {
    const onApprove = vi.fn(async () => true);
    const a = makeAction("update_ad", { channel_slug: "meta_ads", executable: true, primary_label: "Adjust budget", title: "Raise the host ad set", body: { funding_source: "provider", exact_change: { rows: [{ item: "Daily budget", before: "$69", after: "$83" }] } } });
    render(<FamilyCard action={a} handlers={handlers({ onApprove })} />);
    const change = screen.getByTestId("exact-change");
    expect(within(change).getByText("$69")).toBeTruthy();
    expect(within(change).getByText("$83")).toBeTruthy();
    expect(screen.queryByText("From your ads balance", { exact: false })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Adjust budget" })));
    expect(onApprove).toHaveBeenCalledWith(a);
    expect(screen.getByText("Approved. Sending to Meta Ads.").getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("labels the shared ads balance only when the card carries wallet funding evidence", () => {
    const wallet = makeAction("update_ad", { channel_slug: "meta_ads", executable: true, title: "Raise the managed campaign", body: { funding_source: "wallet" } });
    render(<FamilyCard action={wallet} handlers={handlers({ onApprove: vi.fn() })} />);
    expect(screen.getByText("From your ads balance", { exact: false })).toBeTruthy();
  });

  it("rejects with undo", async () => {
    const h = handlers({ onApprove: vi.fn() });
    const a = makeAction("pause_ad", { channel_slug: "google_ads", executable: true, primary_label: "Pause", title: "Pause it" });
    render(<FamilyCard action={a} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(h.onSetStatus).not.toHaveBeenCalled();
    const reason = screen.getByRole("textbox", { name: "Why are you rejecting it?" });
    const reject = within(reason.parentElement!).getByRole("button", { name: "Reject" }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "Wrong audience" } });
    await act(async () => fireEvent.click(reject));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "rejected", { note: "Wrong audience", hold: true, keep: true });
    expect(screen.getByText("Rejected").getAttribute("role")).toBe("status");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("draws a done card with the live line", () => {
    const a = makeAction("create_ad", { channel_slug: "meta_ads", executable: true, exec_status: "executed", title: "Add the ad" });
    render(<FamilyCard action={a} handlers={handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Live in Meta Ads");
    expect(screen.queryByTestId("exec-title")).toBeNull();
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();
  });
});
