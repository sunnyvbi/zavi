// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelActionBody } from "@/lib/workspace/channelActionsApi";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { CopyButton } from "../ActionFooter";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));

afterEach(cleanup);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });
const EMAIL = "Hi [First name],\n\nYour car is ready.\n\n--\n[Postal address: required by US law on every marketing email]";

describe("CopyButton", () => {
  it("clean text: plain Copy, no line", async () => {
    render(<CopyButton text="All done." />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("All done.");
    expect(screen.queryByTestId("copy-blanks")).toBeNull();
  });

  it("blanks: the label counts them, pressing still copies and names them", async () => {
    render(<CopyButton text={EMAIL} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy (2 blanks to fill)" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(EMAIL);
    expect(screen.getByTestId("copy-blanks").textContent).toBe("Fill before sending: [First name], [Postal address: required by US law on…]");
  });
});

describe("on a card: fill these in first", () => {
  const emailCard = () =>
    makeAction("send_message", {
      channel_slug: "email_marketing",
      body: { step: { title: "Email", body: "b", deliverable: { kind: "email", label: "Email", content: EMAIL } } },
      card_kind: "message",
      primary_label: "Copy email",
      done_label: "I sent it",
      how_to: ["Press Copy email."],
    });

  it("a stored Copy email waits for its blanks; the postal address is asked for in Settings, not on the card", async () => {
    render(<ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    const fill = screen.getByTestId("blanks-fill");
    expect(fill.textContent).toContain("2 blanks to fill");
    expect(screen.getByTestId("email-code-box").contains(fill)).toBe(true);
    const main = screen.getByRole("button", { name: "Copy email (2 blanks to fill)" }) as HTMLButtonElement;
    expect(main.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Maya" } });
    expect(screen.queryByLabelText(/^Postal address/)).toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("footer-slot").textContent).toContain("Postal address missing");
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add postal address" }));
    await act(async () => {});
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a pressed Copy message with an empty blank copies nothing, says why and puts the cursor in the blank", async () => {
    const DM = "Hi! We'd also license the video for ads for [term, to be decided]. What's your rate?";
    const a = makeAction("send_message", {
      channel_slug: "ugc",
      body: { step: { title: "First DM to a creator", body: "b", deliverable: { kind: "message", label: "First DM to a creator", content: DM } } },
      card_kind: "message",
      primary_label: "Copy message",
      done_label: "I sent it",
      how_to: ["Press Copy message."],
    });
    render(<ChannelActionCard action={a} platform={platformFor("ugc")} handlers={handlers()} />);
    const waiting = screen.getByRole("button", { name: "Copy message (1 blank to fill)" }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(false);
    fireEvent.click(waiting);
    await act(async () => {});
    expect(writeText).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("term, to be decided"));
    expect(screen.getByTestId("primary-hint").textContent).toContain("Fill the 1 blank");
    expect(screen.getByTestId("primary-hint").textContent).toContain("Copy with blanks");
    expect(screen.queryByRole("button", { name: /I sent it/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("term, to be decided"), { target: { value: "12 months" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Hi! We'd also license the video for ads for 12 months. What's your rate?");
    expect(screen.getByRole("button", { name: /I sent it/ })).toBeTruthy();
  });

  it("··· Copy with blanks takes the text as it is and names the blanks", async () => {
    const a = makeAction("page", {
      channel_slug: "geo",
      title: "Publish the page",
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      body: { step: { body: "b", deliverable: { kind: "page", label: "Page copy", content: "Serving [city] since [FOUNDER: year]." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("geo")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy with blanks/ }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Serving [city] since [FOUNDER: year].");
    expect(screen.getByTestId("copy-blanks").textContent).toBe("Fill before sending: [city], [FOUNDER: year]");
  });

  it("the values are local to the card: filled in, ··· Copy is plain again and takes them", async () => {
    const a = makeAction("page", {
      channel_slug: "geo",
      title: "Publish the page",
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      body: { step: { body: "b", deliverable: { kind: "page", label: "Page copy", content: "Serving [city] since [city]." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("geo")} handlers={handlers()} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("city"), { target: { value: "Austin" } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy(?! with)(?! all)/ }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Serving Austin since Austin.");
  });

  it("a post with a blank cannot go out until it is filled, and then posts the filled text", async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    const a = makeAction("text_post", {
      channel_slug: "x_organic",
      body: { step: { title: "Post", body: "b", deliverable: { kind: "post", label: "Post", content: "I rented a [BRACKET: make/model/year] last week." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={{ ...handlers(), onPublish }} />);
    expect(screen.getByText("Fill the 1 blank above before posting.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Post on X" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy with blanks/ }));
    await act(async () => {});
    expect(screen.getByTestId("copy-blanks").textContent).toBe("Fill before sending: [BRACKET: make/model/year]");
    fireEvent.change(screen.getByLabelText("BRACKET: make/model/year"), { target: { value: "2021 Tesla Model 3" } });
    expect(screen.queryByText(/before posting/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
    });
    expect(onPublish).toHaveBeenCalledWith(a, { text: "I rented a 2021 Tesla Model 3 last week.", thread: null });
  });

  it("a clean post keeps plain Copy and no inputs", () => {
    render(<ChannelActionCard action={FIXTURES.text_post} platform={platformFor("x_organic")} handlers={handlers()} />);
    expect(screen.queryByTestId("blanks-fill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /^Copy/ }).textContent).not.toMatch(/blank/);
  });

  it("a code deliverable has no blanks: plain Copy, no inputs", () => {
    const a = makeAction("page", {
      channel_slug: "geo",
      title: "Add the JSON-LD",
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      body: { step: { body: "b", deliverable: { kind: "code", label: "JSON-LD", content: '{ "sameAs": [linkedin, facebook] }' } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("geo")} handlers={handlers()} />);
    expect(screen.queryByTestId("blanks-fill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /^Copy/ }).textContent).not.toMatch(/blank/);
  });

  it("the blanks notice after a ··· Copy goes away once the post is edited", async () => {
    const a = makeAction("text_post", {
      channel_slug: "x_organic",
      body: { step: { title: "Post", body: "b", deliverable: { kind: "post", label: "Post", content: "Hi [city] renters." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy with blanks/ }));
    await act(async () => {});
    expect(screen.getByTestId("copy-blanks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Hi Austin renters." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByTestId("copy-blanks")).toBeNull();
  });
});

describe("nothing leaves the card with an empty blank unless the founder chose Copy with blanks", () => {
  const PARTS = [
    { label: "A", content: "Hi [First name], welcome." },
    { label: "B", content: "See you in [city]." },
  ];
  const joined = PARTS.map((p) => `${p.label}\n${p.content}`).join("\n\n");
  const partsCard = (parts = PARTS) =>
    makeAction("fix", {
      channel_slug: "made_up_site",
      title: "Two versions",
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      body: { step: { body: "b", deliverable: { kind: "copy", label: "Copy", content: joined, parts } } },
    });
  const menuItem = (name: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    return screen.getByRole("menuitem", { name }) as HTMLButtonElement;
  };

  it("F1: the part tab's Copy waits for the blank, then copies the filled part", async () => {
    render(<ChannelActionCard action={partsCard()} platform={platformFor("made_up_site")} handlers={handlers()} />);
    const tabCopy = () => within(screen.getByTestId("part-tabs")).getByRole("button", { name: "Copy" }) as HTMLButtonElement;
    expect(tabCopy().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Sam" } });
    fireEvent.click(tabCopy());
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Hi Sam, welcome.");
  });

  it("F4: Copy all on an action card waits while a part on another tab has a blank", () => {
    render(<ChannelActionCard action={partsCard([{ label: "A", content: "Clean." }, PARTS[1]])} platform={platformFor("made_up_site")} handlers={handlers()} />);
    expect(menuItem(/^Copy all/).disabled).toBe(true);
    expect(screen.getByRole("menuitem", { name: /^Copy all/ }).textContent).toContain("Fill the blanks in each part first");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("tab", { name: "B" }));
    fireEvent.change(screen.getByLabelText("city"), { target: { value: "Austin" } });
    const all = menuItem(/^Copy all/);
    expect(all.disabled).toBe(false);
    fireEvent.click(all);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("See you in Austin."));
  });

  it("F5: Copy all on a post card waits while another variant has a blank", () => {
    const a = makeAction("text_post", {
      channel_slug: "made_up_social",
      title: "Two posts",
      body: { step: { body: "b", deliverable: { kind: "post", label: "Post", content: "x", parts: [{ label: "A", content: "Clean post." }, { label: "B", content: "Try [product] today." }] } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("made_up_social")} handlers={handlers()} />);
    expect(menuItem(/^Copy all/).disabled).toBe(true);
  });

  const devCard = (kind: "task" | "copy_to_site") =>
    makeAction("fix", {
      channel_slug: "seo",
      title: "Set the callback",
      body: {
        step: { title: "Callback", body: "b", deliverable: { kind: kind === "task" ? "list" : "page_copy", label: "Setting", content: "Set callback to [URL]" } },
        owner: "developer",
      },
      card_kind: kind,
      primary_label: kind === "task" ? "Send to dev" : "Copy new text",
      done_label: kind === "task" ? "I sent it to dev" : "I updated the page",
      how_to: ["Do it."],
    });

  it("F2: Send to dev waits for the blank", () => {
    render(<ChannelActionCard action={devCard("task")} platform={platformFor("seo")} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: /^Send to dev/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://x.test/cb" } });
    expect(screen.getByRole("button", { name: /^Send to dev/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("F3: Email this to your developer waits for the blank", () => {
    render(<ChannelActionCard action={devCard("copy_to_site")} platform={platformFor("seo")} handlers={handlers()} />);
    expect(menuItem(/Email this to your developer/).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://x.test/cb" } });
    expect(menuItem(/Email this to your developer/).disabled).toBe(false);
  });
});
