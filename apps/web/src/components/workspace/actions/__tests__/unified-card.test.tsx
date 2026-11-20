// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";
import type { ActionHandlers } from "../types";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (): ActionHandlers => ({
  onSetStatus: vi.fn(),
  onRedo: vi.fn(),
  onApprove: vi.fn(),
  onOpenChat: vi.fn(),
  onOpenRedoChat: vi.fn(),
});

function aboutText(id: string): string {
  fireEvent.click(within(screen.getByTestId(`action-${id}`)).getByRole("button", { name: "What it is" }));
  return screen.getByRole("dialog", { name: "Details" }).textContent ?? "";
}

function reachable(id: string): string {
  const rest = screen.getByTestId(`action-${id}`).textContent ?? "";
  return `${rest} ${aboutText(id)}`;
}

const NON_DRAFT = ["create_ad", "update_ad", "pause_ad", "fix", "check", "setup", "page", "other", "send_message"] as const;
const DRAFTS = ["text_post", "image_post", "video_post", "reply"] as const;

describe("every non-draft action renders the one card", () => {
  it.each(NON_DRAFT)("%s uses the unified card, on an organic channel", (t) => {
    const a = makeAction(t, {
      channel_slug: "blog",
      title: "Do the thing",
      body: { action_label: "Do it", step: { body: "Because of a reason.", effort: "minutes" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(within(card).queryByTestId("post-text")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /^Not now$/ })).toBeTruthy();
  });

  it.each(DRAFTS)("%s still uses the post card, with its editor", (t) => {
    const a = makeAction(t, { channel_slug: "x_organic" });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    expect(screen.getByTestId("post-text")).toBeTruthy();
  });
});

describe("the primary button", () => {
  it("reads the server's label, not a word derived in the browser", () => {
    const a = makeAction("pause_ad", {
      channel_slug: "google_ads",
      title: "Pause 4 keywords with no conversions",
      executable: true,
      body: { action_label: "Halt those keywords", change_sentence: "Zavi pauses 4 keywords." },
    });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={h} />);
    const btn = screen.getByRole("button", { name: "Halt those keywords" });
    fireEvent.click(btn);
    expect(h.onApprove).toHaveBeenCalledWith(a);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("is NOT a button, and NOT a primary link, on a non-executable action", () => {
    const a = makeAction("check", {
      channel_slug: "meta_ads",
      title: "Check why cost per result doubled",
      body: { action_label: "Check cost" },
    });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={h} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.querySelector("button[data-approve]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check cost" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Check cost" })).toBeNull();
    expect(h.onApprove).not.toHaveBeenCalled();
  });

  it("that LEAVES for the platform is visibly different from one that spends here", () => {
    const opens = makeAction("check", {
      channel_slug: "meta_ads",
      title: "Rebuild the campaign",
      primary_label: "Rebuild campaign",
      body: { link: "https://adsmanager.facebook.com" },
    });
    render(<ChannelActionCard action={opens} platform={platformFor("meta_ads")} handlers={handlers()} />);
    const out = screen.getByRole("link", { name: /Rebuild campaign/ });
    expect(out.querySelector("svg"), "the link-out must carry an external-link affordance").toBeTruthy();
    cleanup();

    const spends = makeAction("pause_ad", {
      channel_slug: "google_ads",
      title: "Pause 4 keywords",
      executable: true,
      body: { action_label: "Pause" },
    });
    render(<ChannelActionCard action={spends} platform={platformFor("google_ads")} handlers={handlers()} />);
    const btn = screen.getByRole("button", { name: "Pause" });
    expect(btn.querySelector("svg"), "the control that spends must NOT look like a link-out").toBeNull();
  });

  it("is absent entirely when the server sent no label and there is no link", () => {
    const a = makeAction("check", { channel_slug: "blog", title: "Check the thing", body: {} });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(within(card).getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Do it" })).toBeNull();
    expect(card.querySelector("a[class*='bg-ca-action']")).toBeNull();
    expect(card.querySelector("button[data-approve]")).toBeNull();
  });
});

describe("what the card must not lose", () => {
  it("shows the deliverable without expanding anything, and offers Copy", () => {
    const a = makeAction("send_message", {
      channel_slug: "email_marketing",
      title: "Send the win-back email",
      body: {
        action_label: "Send it",
        step: {
          body: "212 trials lapsed.",
          effort: "minutes",
          deliverable: { kind: "email", label: "Message", content: "Hi there, you started a trial..." },
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("email_marketing")} handlers={handlers()} />);
    expect(screen.getByTestId("email-code-box").textContent).toContain("Hi there, you started a trial");
    expect(screen.getByRole("button", { name: /^Copy/ })).toBeTruthy();
  });

  it("shows no ranking chrome — score, why-it-ranks and effort are gone; the kind is a quiet label", () => {
    const a = makeAction("check", {
      channel_slug: "blog",
      title: "Check it",
      body: { action_label: "Do it", step: { body: "b", effort: "hours" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.textContent).not.toContain("Check · a few hours");
    expect(within(card).queryByTestId("action-score")).toBeNull();
    expect(within(card).queryByRole("button", { name: /Why it ranks here/ })).toBeNull();
    expect(within(card).getByRole("heading", { name: "Check it" })).toBeTruthy();
  });

  it("offers a rewrite on a non-executable action, and never on one that spends", () => {
    const task = makeAction("fix", { channel_slug: "blog", title: "Fix the tag", body: { action_label: "Fix it" } });
    render(<ChannelActionCard action={task} platform={platformFor("blog")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /rewrite/i })).toBeTruthy();
    cleanup();

    const spends = makeAction("pause_ad", {
      channel_slug: "google_ads",
      title: "Pause 4 keywords",
      executable: true,
      body: { action_label: "Pause" },
    });
    render(<ChannelActionCard action={spends} platform={platformFor("google_ads")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /rewrite|redo/i })).toBeNull();
  });

  it("shows the WHOLE body when expanded — #2893's fix must not be undone", () => {
    const sentences = [
      "Mobile signups fell 38% week over week while desktop held flat.",
      "The drop is concentrated in Austin and Dallas, which carry 61% of paid spend.",
      "The signup_form_v2 experiment shipped on the 12th and only targets mobile.",
      "Open the funnel report and compare the two cities before changing any budget.",
    ];
    const a = makeAction("check", {
      channel_slug: "blog",
      title: "Check the mobile signup drop",
      body: { action_label: "Do it", step: { body: sentences.join(" "), effort: "hours" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const shown = reachable(a.id);
    for (const s of sentences) expect(shown, `lost: ${s}`).toContain(s);
  });

  it("MONEY: the exact change is on the card before anything can approve it", () => {
    const a = makeAction("update_ad", {
      channel_slug: "google_ads",
      title: "Raise the budget",
      executable: true,
      body: { action_label: "Adjust budget", exact_change: { rows: [{ item: "Daily budget", before: "$40", after: "$55" }] } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    const change = screen.getByTestId("exact-change");
    const button = screen.getByRole("button", { name: "Adjust budget" });
    expect(change.textContent).toContain("$55");
    expect(change.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.contains(change), "the exact change must be inside this card").toBe(true);
  });
});

describe("what the collapsed card carries", () => {
  it("shows Why this without a click, and keeps the rest behind Show more", () => {
    const a = makeAction("check", {
      channel_slug: "x_organic",
      title: "Confirm upcar.ai footer links @UpcarCarRental",
      body: {
        action_label: "Do it",
        step: {
          body: "The site footer was truncated in this run's read and could not be verified.",
          effort: "minutes",
          card_evidence: {
            stats: [
              { value: "0", caption: "anchor tags found in the footer" },
              { value: "312", caption: "visitors reached the footer last week" },
            ],
            estimate: [{ value: "+12", caption: "followers a month at current traffic" }],
          },
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const shown = reachable(a.id);
    expect(shown).toContain("312 visitors reached the footer last week");
    expect(shown).toContain("+12");
    expect(shown).toContain("followers a month at current traffic");
  });

  it("keeps all remaining prose one click away under What it is, with no Show more", () => {
    const body =
      "Homepage was read this run and the visible footer lists Help Center, Support, About Us, Blog, Careers, Terms, and Privacy — no x.com link in the visible section. " +
      "The page was truncated at 1 MB so the link may exist past the cut; check the page source. " +
      "If it is missing, this is a one-line HTML fix. The same footer is on every page, so one edit covers the whole site. " +
      "Every post you publish sends people nowhere if they cannot find the account.";
    const a = makeAction("fix", {
      channel_slug: "x_organic",
      title: "Link your X account from the site footer",
      body: { action_label: "Fix it", step: { body, effort: "minutes" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(reachable(a.id)).toContain("Every post you publish sends people nowhere");
  });

  it("at rest the card is the lead, not the whole paragraph, and the rest is one click away once", () => {
    const lead = "The site footer was truncated in this run's read and could not be verified.";
    const reason = "If the site does not link your X account, every visitor who wants to follow has nowhere to go.";
    const a = makeAction("check", {
      channel_slug: "x_organic",
      title: "Confirm upcar.ai footer links @UpcarCarRental",
      body: { action_label: "Do it", step: { body: `${lead} ${reason}`, effort: "minutes" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.textContent).toContain(lead);
    expect(card.textContent).not.toContain(reason);
    expect(aboutText(a.id).split(reason).length - 1, "printed twice").toBe(1);
  });

  it("never repeats a sentence the prose already said", () => {
    const s1 = "If the site does not link your X account, every visitor who wants to follow has nowhere to go.";
    const s2 = "One anchor tag in the footer.";
    const a = makeAction("check", {
      channel_slug: "x_organic",
      title: "Confirm upcar.ai footer links @UpcarCarRental",
      body: {
        action_label: "Do it",
        step: { body: `The site footer was truncated in this run's read and could not be verified. ${s1} ${s2}`, effort: "minutes" },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const text = screen.getByTestId(`action-${a.id}`).textContent ?? "";
    const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
    const about = aboutText(a.id);
    expect(occurrences(text, s1), "sentence printed twice").toBeLessThanOrEqual(1);
    expect(occurrences(text, s2), "sentence printed twice").toBeLessThanOrEqual(1);
    expect(occurrences(about, s1), "sentence printed twice").toBe(1);
    expect(occurrences(about, s2), "sentence printed twice").toBe(1);
  });

  it("keeps a measured stat on the card after expanding", () => {
    const a = makeAction("check", {
      channel_slug: "blog",
      title: "Check the drop",
      body: {
        action_label: "Do it",
        step: {
          body:
            "Mobile signups fell week over week. The drop is concentrated in two cities. " +
            "Desktop held flat over the same days. Neither city changed its budget in the window. " +
            "That leaves the creative refresh as the only change that lines up.",
          effort: "hours",
          card_evidence: { stats: [{ value: "38%", caption: "week-over-week fall on mobile" }, { value: "2", caption: "cities carrying the drop" }] },
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(reachable(a.id), "a measured stat must not disappear on expand").toContain("cities carrying the drop");
  });

  it("offers no Show more when there is genuinely nothing behind it", () => {
    const a = makeAction("check", {
      channel_slug: "blog",
      title: "Short one",
      body: { action_label: "Do it", step: { body: "A single short sentence.", effort: "minutes" } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.textContent).toContain("A single short sentence.");
    expect(screen.queryByRole("button", { name: /Show more/i })).toBeNull();
  });
});

describe("the raw agent evidence lines are not printed", () => {
  it("drops tool-shaped AND readable evidence lines — the block is not mounted", () => {
    const a = makeAction("check", {
      channel_slug: "meta_ads",
      title: "Rebuild the campaign",
      body: {
        action_label: "Do it",
        step: {
          body: [
            "This campaign has spent $598.82 with zero conversions.",
            "The daily spend has been flat since the 26th of July.",
            "Rebuild it as a conversion campaign before raising any budget.",
          ].join(" "),
          effort: "hours",
          evidence: [
            "meta_ads__daily_series campaign_id 120259468814150059: conversions=0 every day",
            "30 consecutive days confirmed",
          ],
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={handlers()} />);
    const text = screen.getByTestId(`action-${a.id}`).textContent ?? "";
    expect(text).not.toContain("meta_ads__daily_series");
    expect(text).not.toContain("120259468814150059");
    expect(text).not.toContain("30 consecutive days confirmed");
  });

});

describe("the controls, and the copy that survives expanding", () => {
  it("an executable row with NO served label still has a way to approve it", () => {
    const a = makeAction("update_ad", {
      channel_slug: "google_ads",
      title: "Raise the budget on the capped campaign",
      executable: true,
      body: { change_sentence: "Budget goes up while the campaign is capped." },
    });
    expect(a.body?.action_label, "fixture must have no served label").toBeUndefined();
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    const card = screen.getByTestId(`action-${a.id}`);
    const approve = card.querySelector("button[data-approve]");
    expect(approve, "an executable row must keep its approve control").not.toBeNull();
    expect(approve?.textContent).toBe("Apply change");
  });

  it("keeps the PROMOTED lead when expanding swaps the paragraph for the body", () => {
    const a = makeAction("check", {
      channel_slug: "blog",
      title: "Check the drop",
      body: {
        action_label: "Do it",
        step: {
          body:
            "Mobile signups fell week over week. The drop is concentrated in two cities. " +
            "Desktop held flat over the same days. Neither city changed its budget in the window. " +
            "That leaves the creative refresh as the only change that lines up.",
          effort: "hours",
          card_evidence: { stats: [{ value: "38%", caption: "week-over-week fall on mobile" }] },
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("blog")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    expect(reachable(a.id), "the measured lead must survive the swap").toContain("38% week-over-week fall on mobile");
  });

  it("does not drop the bullets on a card that expands for something OTHER than its body", () => {
    const a = makeAction("check", {
      channel_slug: "seo",
      title: "Check the drop",
      body: {
        action_label: "Do it",
        step: {
          body: "Mobile signups fell week over week. The drop is concentrated in two cities.",
          effort: "hours",
          card_evidence: { estimate: [{ value: "$4,120", caption: "a month at the current rate" }] },
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    const card = () => screen.getByTestId(`action-${a.id}`);
    fireEvent.click(within(card()).getByRole("button", { name: "What it is" }));
    const what = screen.getByRole("dialog", { name: "Details" });
    expect(what.textContent).toContain("The drop is concentrated in two cities");
    expect(within(what).getByTestId("about-evidence").textContent).toContain("$4,120");
    expect(what.textContent).toContain("a month at the current rate");
  });

  it("prints a rewritten sentence once, not twice, after expanding", () => {
    const a = makeAction("check", {
      channel_slug: "google_ads",
      title: "Check the paused campaign",
      body: {
        action_label: "Do it",
        step: {
          body:
            "Pause the ENABLED campaign before the weekend. Spend fell after the last change. " +
            "The two cities carrying it both refreshed creative. Neither changed its budget. " +
            "That leaves the refresh as the only thing that moved.",
          effort: "hours",
        },
      },
    });
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    const more = screen.queryByRole("button", { name: /Show more/i });
    if (more) fireEvent.click(more);
    const shown = screen.getByTestId(`action-${a.id}`).textContent ?? "";
    const occurrences = shown.split("campaign before the weekend").length - 1;
    expect(occurrences, "the lead must not be printed twice").toBe(1);
  });
});
