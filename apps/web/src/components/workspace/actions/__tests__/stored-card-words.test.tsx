// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

const setSteps = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/channelActionsApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace/channelActionsApi")>("@/lib/workspace/channelActionsApi");
  return { ...actual, setChannelActionSteps: setSteps };
});

afterEach(cleanup);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  setSteps.mockReset().mockResolvedValue({ ok: true, steps_done: [] });
});

function handlers(over: Partial<ActionHandlers> = {}) {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn(), ...over } satisfies ActionHandlers;
}
const card = (a: ChannelActionView, h = handlers()) => {
  render(<ChannelActionCard action={a} platform={platformFor(a.channel_slug)} handlers={h} />);
  return h;
};
const btn = (name: RegExp | string) => screen.getByRole("button", { name });

const PAST = /^(I did this|I posted it|I sent it|I published it|I put it on my site|I updated the page|I created it|Done|Approved)$/;

describe("copy kinds: Copy, then the done words", () => {
  it("page copy: Copy new text copies the raw text, then I updated the page marks acted", async () => {
    const a = makeAction("fix", {
      channel_slug: "blog",
      body: { step: { title: "Headline", body: "Why.", deliverable: { kind: "page_copy", label: "New headline", content: "Grow **faster**" } } },
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      how_to: ["Press Copy new text.", "Paste it."],
    });
    const h = card(a);
    expect(screen.queryByRole("button", { name: /I did this/ })).toBeNull();
    fireEvent.click(btn("Copy new text"));
    expect(writeText).toHaveBeenCalledWith("Grow **faster**");
    fireEvent.click(await screen.findByRole("button", { name: "I updated the page" }));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("a hand-built ad: Copy ad then I created it", async () => {
    const a = makeAction("create_ad", {
      channel_slug: "reddit_ads",
      body: { step: { title: "Ad", body: "b", deliverable: { kind: "ad", label: "Ad", content: "Headline: x" } } },
      card_kind: "ad_manual",
      primary_label: "Copy ad",
      done_label: "I created it",
      how_to: ["Press Copy ad."],
    });
    card(a);
    fireEvent.click(btn("Copy ad"));
    expect(await screen.findByRole("button", { name: "I created it" })).toBeTruthy();
  });
});

describe("plan: Approve plan marks it acted", () => {
  it("one click", () => {
    const a = makeAction("other", {
      channel_slug: "blog",
      body: { step: { title: "Plan", body: "b", deliverable: { kind: "strategy", label: "Blog plan", content: "# Plan\n\n- Week 1" } } },
      card_kind: "plan",
      primary_label: "Approve plan",
      done_label: "Approved",
      how_to: ["Read the plan."],
    });
    const h = card(a);
    fireEvent.click(btn("Approve plan"));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("renders the plan as markdown, not raw #", () => {
    const a = makeAction("other", {
      channel_slug: "blog",
      body: { step: { title: "Plan", body: "b", deliverable: { kind: "strategy", label: "Blog plan", content: "# The plan\n\nWeek one" } } },
      card_kind: "plan",
      primary_label: "Approve plan",
      done_label: "Approved",
      how_to: ["Read the plan."],
    });
    card(a);
    expect(screen.getByTestId("deliverable-markdown")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The plan" })).toBeTruthy();
    expect(screen.queryByText(/# The plan/)).toBeNull();
  });
});

describe("message: Open email", () => {
  const email = (content: string) =>
    makeAction("send_message", {
      channel_slug: "ugc",
      body: { step: { title: "Pitch", body: "b", deliverable: { kind: "email", label: "Collab idea", content } } },
      card_kind: "message",
      primary_label: "Open email",
      done_label: "I sent it",
      how_to: ["Press Open email."],
    });
  let assigned: string[];
  beforeEach(() => {
    assigned = [];
    Object.defineProperty(window, "location", { value: { set href(v: string) { assigned.push(v); } }, configurable: true });
  });

  it("opens the mail app with subject and body and an EMPTY To, then I sent it", async () => {
    card(email("Hi there"));
    fireEvent.click(btn(/Open email/));
    expect(assigned).toEqual(["mailto:?subject=Collab%20idea&body=Hi%20there"]);
    expect(await screen.findByRole("button", { name: "I sent it" })).toBeTruthy();
  });

  it("a body too long for a mailto URL goes on the clipboard, subject only in the URL", async () => {
    const long = "word ".repeat(600);
    card(email(long));
    fireEvent.click(btn(/Open email/));
    expect(assigned).toEqual(["mailto:?subject=Collab%20idea"]);
    expect(writeText).toHaveBeenCalledWith(long);
    await waitFor(() => expect(screen.getByTestId("primary-hint").textContent).toMatch(/Email body copied, paste it in/));
  });
});

describe("task: the run's steps are the right side; ticks save; Done is never gated", () => {
  const task = (over: Partial<ChannelActionView> = {}) =>
    makeAction("check", {
      channel_slug: "blog",
      body: { step: { title: "Sitemap", body: "Why.\n\n1. Open Search Console.\n2. Submit the sitemap." } },
      card_kind: "task",
      primary_label: "Verify",
      done_label: "It works",
      how_to: ["Open Search Console.", "Submit the sitemap."],
      steps_done: [1],
      ...over,
    });

  const bare = { body: { step: { title: "Sitemap", body: "Why." } } };

  it("the run's list is on the card; the main button is the stored words, never a bare Done, and no Show steps", () => {
    const a = task();
    const h = card(a);
    expect(screen.getByTestId(`action-${a.id}`).textContent).toMatch(/Open Search Console/);
    expect(screen.queryByRole("button", { name: "Show steps" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(btn("Verify"));
    fireEvent.click(btn("It works"));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("no link and no manage page: the stored words open the steps, then the done words", () => {
    const h = card(task(bare));
    expect(screen.queryByRole("link", { name: /Verify/ })).toBeNull();
    expect(screen.queryByTestId("how-to")).toBeNull();
    expect(btn("How it works").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn("Verify"));
    expect(screen.getByTestId("how-to")).toBeTruthy();
    expect(btn("How it works").getAttribute("aria-expanded")).toBe("true");
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(btn("It works")).toBeTruthy();
  });

  it("no link of its own: the stored words open the platform's manage page, then the done words", async () => {
    const a = makeAction("check", {
      channel_slug: "google_ads",
      body: { step: { title: "Conversion tag", body: "Why." } },
      card_kind: "task",
      primary_label: "Fix setup",
      done_label: "It's fixed",
      how_to: ["Open Google Ads.", "Check the tag."],
    });
    const h = card(a);
    const link = screen.getByRole("link", { name: /Fix setup/ });
    expect(link.getAttribute("href")).toBe(platformFor("google_ads")?.manageUrl);
    fireEvent.click(link);
    fireEvent.click(await screen.findByRole("button", { name: "It's fixed" }));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("a non-task card never gets the manage page as its main link", () => {
    const a = makeAction("create_ad", {
      channel_slug: "google_ads",
      body: { step: { title: "Ad", body: "b", deliverable: { kind: "ad", label: "Ad", content: "Headline: x" } } },
      card_kind: "ad_manual",
      primary_label: "Copy ad",
      done_label: "I created it",
      how_to: ["Press Copy ad."],
    });
    card(a);
    expect(screen.queryByRole("link", { name: /Copy ad/ })).toBeNull();
    expect(btn("Copy ad")).toBeTruthy();
  });

  it("the run's steps are not printed twice: no How to do this beside the right-side steps", () => {
    card(task());
    expect(screen.queryByTestId("how-to")).toBeNull();
  });

  it("with no list in the body, How it works is the tick list (ticks from the row)", () => {
    card(task(bare));
    expect(screen.queryByRole("button", { name: "How to do this" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(btn("How it works"));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
  });

  it("a tick saves the whole set; a failed save reverts and says so", async () => {
    card(task(bare));
    fireEvent.click(btn("How it works"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(setSteps).toHaveBeenCalledWith(expect.stringMatching(/^act-check/), [0, 1]);
    setSteps.mockRejectedValueOnce(new Error("500"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/didn't save/));
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("quick ticks save one at a time and the LATEST set wins", async () => {
    let release: (v: unknown) => void = () => {};
    setSteps.mockImplementationOnce(() => new Promise((r) => (release = r)));
    card(task({ ...bare, steps_done: [] }));
    fireEvent.click(btn("How it works"));
    const boxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(boxes()[0]);
    fireEvent.click(boxes()[1]);
    expect(setSteps).toHaveBeenCalledTimes(1);
    expect(setSteps).toHaveBeenLastCalledWith(expect.any(String), [0]);
    release({ ok: true, steps_done: [0] });
    await waitFor(() => expect(setSteps).toHaveBeenCalledTimes(2));
    expect(setSteps).toHaveBeenLastCalledWith(expect.any(String), [0, 1]);
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  });

  it("a copy card that arrives with nothing to copy points at its steps, never opens on the done words", () => {
    const a = makeAction("send_message", {
      channel_slug: "ugc",
      body: { step: { title: "DM", body: "b" } },
      card_kind: "message",
      primary_label: "Copy message",
      done_label: "I sent it",
      how_to: ["Open the app."],
    });
    card(a);
    expect(screen.queryByRole("button", { name: "I sent it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show steps" })).toBeNull();
    expect(screen.queryByText(/Open the app/)).toBeNull();
    fireEvent.click(btn("Copy message"));
    expect(screen.getByText(/Open the app/)).toBeTruthy();
    expect(btn("I sent it")).toBeTruthy();
  });

  it("a task with a link opens it, then Done", async () => {
    card(task({ primary_label: "Open Reddit", body: { step: { title: "t", body: "b" }, link: "https://www.reddit.com/r/x/" } }));
    const a = screen.getByRole("link", { name: /Open Reddit/ });
    expect(a.getAttribute("href")).toBe("https://www.reddit.com/r/x/");
    fireEvent.click(a);
    expect(await screen.findByRole("button", { name: "It works" })).toBeTruthy();
  });
});

describe("the developer's card: Send to dev opens a mail to them", () => {
  let assigned: string[];
  beforeEach(() => {
    assigned = [];
    Object.defineProperty(window, "location", { value: { set href(v: string) { assigned.push(v); } }, configurable: true });
  });
  const devTask = (over: Partial<ChannelActionView> = {}) =>
    makeAction("fix", {
      channel_slug: "blog",
      title: "Add the sitemap to robots.txt",
      body: { step: { title: "Sitemap", body: "Search engines cannot find your sitemap." }, owner: "developer", link: "https://example.com/robots.txt" },
      card_kind: "task",
      primary_label: "Send to dev",
      done_label: "I sent it to dev",
      how_to: ["Open robots.txt.", "Add the Sitemap line."],
      ...over,
    });

  it("opens the mail app with the title, lead, Step N steps and link, To empty, then the done words", async () => {
    const a = devTask();
    const h = card(a);
    fireEvent.click(btn(/Send to dev/));
    expect(assigned).toHaveLength(1);
    const url = assigned[0];
    expect(url.startsWith("mailto:?subject=Add%20the%20sitemap%20to%20robots.txt&body=")).toBe(true);
    const body = decodeURIComponent(url.split("&body=")[1]);
    expect(body).toContain("Add the sitemap to robots.txt");
    expect(body).toContain("Search engines cannot find your sitemap.");
    expect(body).toContain("Step 1: Open robots.txt.\nStep 2: Add the Sitemap line.");
    expect(body).toContain("Link: https://example.com/robots.txt");
    await waitFor(() => expect(screen.getByTestId("primary-hint").textContent).toBe("Your mail app opened. Add your developer's address and send it."));
    fireEvent.click(btn("I sent it to dev"));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("reads the model's step.owner when the server left body.owner unset", () => {
    card(devTask({ body: { step: { title: "Sitemap", body: "b", owner: "developer" } } }));
    fireEvent.click(btn(/Send to dev/));
    expect(assigned[0]).toMatch(/^mailto:/);
  });

  it("an email too long for a mailto URL is copied, with the hint", async () => {
    card(devTask({ how_to: Array.from({ length: 6 }, () => "word ".repeat(80)) }));
    fireEvent.click(btn(/Send to dev/));
    await waitFor(() => expect(screen.getByTestId("primary-hint").textContent).toMatch(/copied\. Paste it in, add your developer's address/));
    expect(assigned).toEqual(["mailto:?subject=Add%20the%20sitemap%20to%20robots.txt"]);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Step 1: word"));
  });

  it("a developer-owned code card offers Email this to your developer in ···; a founder's does not", async () => {
    const code = (owner: string) =>
      makeAction("fix", {
        channel_slug: "blog",
        title: "Add schema",
        body: { step: { title: "Schema", body: "b", deliverable: { kind: "code", label: "Schema", content: "<script>{\"a\":[1]}</script>" } }, owner },
        card_kind: "copy_to_site",
        primary_label: "Copy code",
        done_label: "I updated the page",
        how_to: ["Paste it in the head."],
      });
    card(code("developer"));
    fireEvent.click(btn("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Email this to your developer/ }));
    expect(decodeURIComponent(assigned[0])).toContain('<script>{"a":[1]}</script>');
    await waitFor(() => expect(screen.getByTestId("primary-hint").textContent).toMatch(/Your mail app opened/));
    cleanup();
    card(code("founder"));
    fireEvent.click(btn("More actions"));
    expect(screen.queryByRole("menuitem", { name: /Email this to your developer/ })).toBeNull();
  });
});

describe("post with a composer, and a post with none", () => {
  it("a stored post names the platform when it can post; opening the composer turns it into I posted it", async () => {
    const a = { ...FIXTURES.text_post, card_kind: "post" as const, primary_label: "Post on X", done_label: "I posted it", how_to: ["Press Post on X."] };
    card(a, handlers({ onPublish: vi.fn().mockResolvedValue(true) }));
    expect(btn("Post on X")).toBeTruthy();
    cleanup();
    const h = card(a);
    const link = screen.getByRole("link", { name: /Open draft/ });
    fireEvent.click(link);
    fireEvent.click(await screen.findByRole("button", { name: "I posted it" }));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("an Instagram post is copied, then I posted it", async () => {
    const a = makeAction("image_post", {
      channel_slug: "instagram_organic",
      body: { step: { title: "Reel", body: "b", deliverable: { kind: "post", label: "Caption", content: "Caption text" } } },
      card_kind: "copy_to_site",
      primary_label: "Copy post",
      done_label: "I posted it",
      how_to: ["Open the Instagram app and start a new post."],
    });
    card(a);
    fireEvent.click(btn("Copy post"));
    expect(writeText).toHaveBeenCalledWith("Caption text");
    expect(await screen.findByRole("button", { name: "I posted it" })).toBeTruthy();
  });
});

describe("invariants", () => {
  it("an executable ad change keeps its approve control, labelled with the stored words", () => {
    const a = { ...FIXTURES.update_ad, executable: true, card_kind: "executes" as const, primary_label: "Adjust budget", done_label: "Done", how_to: ["Check it."] };
    const h = card(a);
    const approve = screen.getByRole("button", { name: "Adjust budget" });
    expect(approve.hasAttribute("data-approve")).toBe(true);
    fireEvent.click(approve);
    expect(h.onApprove).toHaveBeenCalledWith(a);
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("S2 leaves the money path alone: an executable card's Approve and exact change are unchanged", () => {
    const base = { ...FIXTURES.update_ad, executable: true, card_kind: "executes" as const, primary_label: "Adjust budget", done_label: "Done", how_to: ["Check it."] };
    const a = {
      ...base,
      body: {
        ...base.body,
        link: null,
        owner: "developer",
        step: { ...base.body?.step, deliverable: { kind: "ad", label: "Ad", content: "Rent in [city] today." } },
      },
    } as ChannelActionView;
    const h = card(a);
    const change = screen.getByTestId("exact-change");
    expect(change.textContent).toContain("Daily budget");
    expect(change.textContent).toContain("$40");
    expect(change.textContent).toContain("$55");
    const approve = screen.getByRole("button", { name: "Adjust budget" }) as HTMLButtonElement;
    expect(approve.hasAttribute("data-approve")).toBe(true);
    expect(approve.disabled).toBe(false);
    expect(change.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("blanks-fill")).toBeNull();
    expect(screen.queryByRole("link", { name: /Adjust budget/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send to dev/ })).toBeNull();
    fireEvent.click(btn("More actions"));
    expect(screen.queryByRole("menuitem", { name: /Email this to your developer/ })).toBeNull();
    fireEvent.click(btn("More actions"));
    fireEvent.click(approve);
    expect(h.onApprove).toHaveBeenCalledWith(a);
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("its menu keeps 'I did this', never the ambiguous 'Done', beside an unapplied change", () => {
    const a = { ...FIXTURES.update_ad, executable: true, card_kind: "executes" as const, primary_label: "Adjust budget", done_label: "Done", how_to: ["Check it."] };
    card(a);
    fireEvent.click(btn("More actions"));
    expect(screen.getByRole("menuitem", { name: /I did this/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Done$/ })).toBeNull();
  });

  it("no stored card starts with a past-tense main button", () => {
    const kinds: Array<[ChannelActionView["action_type"], ChannelActionView["card_kind"], string, string]> = [
      ["fix", "copy_to_site", "Copy code", "I updated the page"],
      ["create_ad", "ad_manual", "Copy ad", "I created it"],
      ["other", "plan", "Approve plan", "Approved"],
      ["send_message", "message", "Copy message", "I sent it"],
      ["check", "task", "Verify", "It works"],
    ];
    for (const [t, kind, primary, done] of kinds) {
      const a = makeAction(t, {
        channel_slug: "blog",
        body: { step: { title: "t", body: "b", deliverable: { kind: "code", label: "x", content: "c" } } },
        card_kind: kind,
        primary_label: primary,
        done_label: done,
        how_to: ["s"],
      });
      card(a);
      const first = screen.getAllByRole("button").find((b) => b.hasAttribute("data-primary") || b.hasAttribute("data-done"));
      expect(first?.textContent?.trim()).toBe(primary);
      expect(first?.textContent?.trim()).not.toMatch(PAST);
      cleanup();
    }
  });

  it("every stored card has How it works, collapsed, numbered from 1 once opened", () => {
    const a = makeAction("fix", { channel_slug: "blog", card_kind: "task", primary_label: "Verify", done_label: "It works", how_to: ["One"] });
    card(a);
    expect(screen.queryByTestId("how-to")).toBeNull();
    fireEvent.click(btn("How it works"));
    const how = screen.getByTestId("how-to");
    expect(within(how).getByTestId("how-to-badge").textContent).toBe("1");
    expect(within(how).getByText(/One/)).toBeTruthy();
  });
});

describe("answer cards: Reply sends the founder's answer back to Zavi", () => {
  const answerCard = () =>
    makeAction("check", {
      channel_slug: "instagram_organic",
      body: { intent: "answer", step: { title: "Open two ExampleBrand-tagged posts and send back the handles", body: "b" } },
      card_kind: "task",
      primary_label: "Reply",
      done_label: "Sent",
      how_to: ["Open the two posts.", "Send back the handles."],
    });

  it("on a channel page, Reply opens the answer chat", () => {
    const a = answerCard();
    const h = card(a, handlers({ onOpenAnswerChat: vi.fn() }));
    fireEvent.click(btn("Reply"));
    expect(h.onOpenAnswerChat).toHaveBeenCalledWith(a);
    expect(h.onRedo).not.toHaveBeenCalled();
  });

  it("without a side chat, Reply opens a box that sends a redo with kind answer", () => {
    const a = answerCard();
    const h = card(a);
    fireEvent.click(btn("Reply"));
    const box = screen.getByPlaceholderText("Type your answer for Zavi");
    fireEvent.change(box, { target: { value: "@examplebrand_fan, @healthwithkim" } });
    fireEvent.submit(box.closest("form") as HTMLFormElement);
    expect(h.onRedo).toHaveBeenCalledWith(a, "@examplebrand_fan, @healthwithkim", "answer");
  });
});
