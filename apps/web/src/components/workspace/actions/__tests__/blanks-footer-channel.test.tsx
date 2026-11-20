// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { ChannelSurface } from "../ChannelSurface";
import { BlanksFill, clearBlankContextCache, useBlankFills } from "../BlanksFill";
import { makeAction } from "./fixtures";
import type { ActionHandlers } from "../types";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/draft") || path.includes("/post")) return json({ revision: "a".repeat(64), content: null, editable: true });
    if (path === "/api/channels/email_marketing/settings") return json({ fields: {} });
    if (path === "/api/workspace/email-template") return json({ template: null, fonts: [], can_edit: true });
    return json({}, 404);
  });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

function Harness({ text, channel }: { text: string; channel?: string | null }) {
  const fills = useBlankFills([text], null, channel);
  return (
    <>
      <BlanksFill fills={fills} />
      <output data-testid="filled">{fills.fill(text)}</output>
      <output data-testid="left">{fills.left}</output>
    </>
  );
}

describe("a social post with an address blank", () => {
  it("shows a typed input, and Post sends the filled text only once it is filled", async () => {
    const onPublish = vi.fn(async () => true);
    const handlers: ActionHandlers = { onPublish, onRedo: vi.fn(), onSetStatus: vi.fn(async () => true) };
    const action = makeAction("text_post", {
      id: "22222222-2222-4222-8222-222222222222",
      channel_slug: "x_organic",
      run_id: null,
      post_revision: "a".repeat(64),
      body: { step: { deliverable: { kind: "post", content: "Visit us at [address]" } } },
    });
    render(<ChannelSurface slug="x_organic"><ChannelActionCard action={action} handlers={handlers} /></ChannelSurface>);
    await flush();
    expect(screen.queryByTestId("blank-footer-missing")).toBeNull();
    const field = screen.getByRole("textbox", { name: /address/i }) as HTMLInputElement;
    expect(field.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
    await flush();
    expect(onPublish).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "9 Pine Rd, Reno" } });
    fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect((onPublish.mock.calls[0] as unknown[])[1]).toMatchObject({ text: "Visit us at 9 Pine Rd, Reno" });
  });

  it("with no channel named, keeps the unsubscribe blank as an input too", async () => {
    render(<Harness text="Unsubscribe: [your email tool's unsubscribe link]" />);
    await flush();
    expect(screen.queryByTestId("blanks-footer")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://x.example/u" } });
    expect(screen.getByTestId("filled").textContent).toBe("Unsubscribe: https://x.example/u");
    expect(screen.getByTestId("left").textContent).toBe("0");
  });
});

describe("an email card", () => {
  const POSTAL = "See you soon.\n\n[Postal address: required by US law on every marketing email]";

  it("still hides the footer blanks and points at Footer settings on the email channel", async () => {
    const goto = vi.fn();
    window.addEventListener("zavi:email-settings-goto", goto);
    render(<ChannelSurface slug="email_marketing"><Harness text={POSTAL} channel="email_marketing" /></ChannelSurface>);
    await flush();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("left").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Open Footer settings" }));
    expect(goto).toHaveBeenCalledTimes(1);
    expect((goto.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: "footer" });
    window.removeEventListener("zavi:email-settings-goto", goto);
  });

  it("off the email channel page, links to the email channel instead of firing an event nobody hears", async () => {
    render(<Harness text={POSTAL} channel="email_marketing" />);
    await flush();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Footer settings" })).toBeNull();
    const link = screen.getByRole("link", { name: "Open Email campaigns" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=channels&channel=email_marketing");
  });
});
