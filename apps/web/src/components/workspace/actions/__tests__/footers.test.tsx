// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { AdsPresentation } from "../ads/AdsPresentation";
import { ChannelActionCard } from "../ChannelActionCard";
import { toast } from "@/components/ui/toast";
import { resetExecFailureToasts } from "../ActionFooter";
import { platformFor, xIntentUrl } from "../platforms";
import { postContent, type ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

vi.mock("../managed-campaigns/ChannelBalance", () => ({
  ChannelBalance: ({ onDialogClosed }: { onDialogClosed?: () => void }) => (
    <div data-testid="balance-dialog">
      <button type="button" onClick={onDialogClosed}>Close balance</button>
    </div>
  ),
}));

afterEach(cleanup);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

function handlers(over: Partial<ActionHandlers> = {}) {
  return {
    onSetStatus: vi.fn(),
    onRedo: vi.fn(),
    onApprove: vi.fn(),
    onOpenChat: vi.fn(),
    ...over,
  } satisfies ActionHandlers;
}

const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));
const menu = (item: RegExp) => {
  click("More actions");
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};
const notNowFor = (choice: string) => {
  menu(/^Not now$/);
  fireEvent.click(within(screen.getByTestId("snooze-picker")).getByRole("button", { name: choice }));
};
const closeCard = () => fireEvent.click(screen.getByRole("button", { name: /^Close “/ }));
const didThis = () => {
  const visible = screen.queryByRole("button", { name: /^(I did this|Done)$/ });
  if (visible) return fireEvent.click(visible);
  menu(/^(I did this|Done)/);
};
const askZavi = (question: string) => {
  const visible = screen.queryByRole("button", { name: /^Ask Zavi$/ });
  if (visible) fireEvent.click(visible);
  else menu(/^Ask Zavi/);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: question } });
  click("Send");
};

const DAY = 24 * 60 * 60 * 1000;

function expectSnoozedFor(h: ActionHandlers, a: ChannelActionView, days: number) {
  const call = vi.mocked(h.onSetStatus).mock.calls.at(-1);
  expect(call?.[0]).toBe(a);
  expect(call?.[1]).toBe("snoozed");
  const until = new Date((call?.[2] as { until: string }).until).getTime();
  expect(Math.abs(until - (Date.now() + days * DAY))).toBeLessThan(60_000);
}

function footerLabels(a: ChannelActionView, wanted: string[]): string[] {
  return Array.from(screen.getByTestId(`action-${a.id}`).querySelectorAll("button, a"))
    .map((el) => el.textContent?.trim() ?? "")
    .filter((t) => wanted.includes(t));
}

describe("every card is a channel action", () => {
  it("fixtures carry source channel_action and the exec fields", () => {
    for (const a of Object.values(FIXTURES)) {
      expect(a.source).toBe("channel_action");
      expect(typeof a.executable).toBe("boolean");
      expect("exec_status" in a && "edited_body" in a).toBe(true);
    }
  });
});

describe("post footer", () => {
  const a = FIXTURES.text_post;
  const x = platformFor("x_organic");

  it("shows Open draft and Ask Zavi; Edit, Copy, Done, Reject, Not now, Redo sit in the menu", () => {
    render(<ChannelActionCard action={a} platform={x} handlers={handlers()} />);
    expect(footerLabels(a, ["Copy", "Edit", "AI edit", "Ask Zavi", "Open draft", "Done"])).toEqual(["Ask Zavi", "Open draft"]);
    expect(screen.queryByRole("button", { name: /^Reject$/ })).toBeNull();
    click("More actions");
    expect(screen.getAllByRole("menuitem").map((m) => m.querySelector(":scope > span > span")?.textContent)).toEqual(["Edit", "Copy", "Done", "Reject", "Not now", "Redo"]);
  });

  it("Ask Zavi opens the side chat and does not redo", () => {
    const h = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    askZavi("Why this one?");
    expect(h.onOpenChat).toHaveBeenCalledWith(a, "Why this one?");
    expect(h.onRedo).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Post publishes through the connected account, then marks acted", async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    const h = handlers({ onPublish });
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    await act(async () => {
      click("Post on X");
    });
    expect(onPublish).toHaveBeenCalledWith(a, { text: expect.stringContaining("Our rule for product feedback:"), thread: null });
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
  });

  it("Post publishes edited_body over body", async () => {
    const edited = makeAction("text_post", {
      body: FIXTURES.text_post.body,
      edited_body: { text: "The applied version.", thread: ["Second part."] },
    });
    const onPublish = vi.fn().mockResolvedValue(true);
    render(<ChannelActionCard action={edited} platform={x} handlers={handlers({ onPublish })} />);
    expect(screen.getByTestId("post-text").textContent).toContain("The applied version.");
    expect(screen.getByTestId("post-text").textContent).toContain("Second part.");
    await act(async () => {
      click("Post on X");
    });
    expect(onPublish).toHaveBeenCalledWith(edited, { text: "The applied version.", thread: ["Second part."] });
  });

  it("a failed publish does not mark acted", async () => {
    const h = handlers({ onPublish: vi.fn().mockResolvedValue(false) });
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    await act(async () => {
      click("Post on X");
    });
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("without a connection, Open draft opens the platform composer and does NOT mark acted", () => {
    const h = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    const link = screen.getByRole("link", { name: /^Open draft$/ });
    expect(link.getAttribute("href")).toBe(xIntentUrl(postContent(a).text));
    fireEvent.click(link);
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "I posted it" })).toBeTruthy();
  });

  it("Done marks acted, connected or not", () => {
    const h = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    menu(/^Done/);
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
    cleanup();
    const h2 = handlers({ onPublish: vi.fn().mockResolvedValue(true) });
    render(<ChannelActionCard action={a} platform={x} handlers={h2} />);
    menu(/^Done/);
    expect(h2.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
    expect(h2.onPublish).not.toHaveBeenCalled();
  });

  it("Edit changes the post in place; Copy and the composer use the edit", async () => {
    render(<ChannelActionCard action={a} platform={x} handlers={handlers()} />);
    menu(/^Edit/);
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Shorter version." } });
    click("Save");
    expect(screen.getByTestId("post-text").textContent).toBe("Shorter version.");
    expect(screen.getByRole("link", { name: /^Open draft$/ }).getAttribute("href")).toBe(xIntentUrl("Shorter version."));
    menu(/^Copy/);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Shorter version.");
  });

  it("the reject popup closes from a cross at the top and keeps Reject alone at the bottom", async () => {
    const h = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    menu(/Reject/);
    const panel = screen.getByTestId("note-panel");
    expect(within(panel).queryByRole("button", { name: "Cancel" })).toBeNull();
    const actions = within(panel).getByTestId("note-panel-actions");
    expect(within(actions).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Reject"]);
    const close = within(panel).getByRole("button", { name: "Close" });
    expect(panel.firstElementChild?.contains(close)).toBe(true);
    fireEvent.click(close);
    expect(screen.queryByTestId("note-panel")).toBeNull();
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("menu: Reject asks for a reason, Not now opens the picker, Redo sends a note", async () => {
    const h = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h} />);
    menu(/Reject/);
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Off brand" } });
    click(/^Reject$/);
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "rejected", { note: "Off brand", hold: true, keep: true });
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Rejected");

    cleanup();
    const h2 = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h2} />);
    menu(/Not now/);
    fireEvent.click(within(screen.getByTestId("snooze-picker")).getByRole("button", { name: "3 days" }));
    expectSnoozedFor(h2, a, 3);
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Not now");

    cleanup();
    const h3 = handlers();
    render(<ChannelActionCard action={a} platform={x} handlers={h3} />);
    menu(/Redo/);
    fireEvent.change(screen.getByLabelText("What should Zavi do differently?"), { target: { value: "Lead with the number" } });
    click(/^Redo$/);
    expect(h3.onRedo).toHaveBeenCalledWith(a, "Lead with the number");
  });

  it("over the platform limit, posting is blocked until the text is shortened", () => {
    const long = makeAction("text_post", {
      body: { step: { deliverable: { kind: "post", content: "word ".repeat(80) } } },
    });
    render(<ChannelActionCard action={long} platform={x} handlers={handlers()} />);
    expect(screen.getByRole("status").textContent).toContain("280-character limit");
    expect(screen.queryByRole("link", { name: /^Open draft$/ })).toBeNull();
    expect((screen.getByRole("button", { name: /^Open draft$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an unverified [CONFIRM: ...] fact blocks posting", () => {
    const risky = makeAction("text_post", {
      body: { step: { deliverable: { kind: "post", content: "We grew [CONFIRM: 40%] last month." } } },
    });
    render(<ChannelActionCard action={risky} platform={x} handlers={handlers({ onPublish: vi.fn().mockResolvedValue(true) })} />);
    expect((screen.getByRole("button", { name: "Post on X" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Fill the 1 blank");
  });
});

describe("ad footer, executable", () => {
  const gads = platformFor("google_ads");

  it("names the primary button from the SERVER's label, not 'Approve', and it calls onApprove", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, body: { ...FIXTURES.pause_ad.body, action_label: "Pause" } });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={gads} handlers={h} />);
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
    const primary = screen.getByRole("button", { name: /^Pause$/ });
    fireEvent.click(primary);
    expect(h.onApprove).toHaveBeenCalledWith(a);

    cleanup();
    const h2 = handlers();
    render(<ChannelActionCard action={a} platform={gads} handlers={h2} />);
    askZavi("Why pause these?");
    expect(h2.onOpenChat).toHaveBeenCalledWith(a, "Why pause these?");
    expect(h2.onApprove).not.toHaveBeenCalled();
  });

  it("has no Dismiss in the menu: the close icon is the way to drop the card", () => {
    const a = FIXTURES.pause_ad;
    const h = handlers();
    render(<ChannelActionCard action={a} platform={gads} handlers={h} />);
    click("More actions");
    expect(screen.queryByRole("menuitem", { name: /Dismiss/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /^Not now$/ })).toBeTruthy();
    click("More actions");
    closeCard();
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "rejected", { keep: true });
  });

  it("Not now in the menu snoozes for the chosen time", () => {
    const a = FIXTURES.pause_ad;
    const h = handlers();
    render(<ChannelActionCard action={a} platform={gads} handlers={h} />);
    expect(screen.queryByRole("button", { name: /^Not now$/ })).toBeNull();
    notNowFor("1 week");
    expectSnoozedFor(h, a, 7);
  });

  it("offers NO redo: the server refuses one on an exec_class row", () => {
    render(<ChannelActionCard action={FIXTURES.pause_ad} platform={gads} handlers={handlers()} />);
    click("More actions");
    expect(screen.queryByRole("menuitem", { name: /redo|revise/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Redo$/ })).toBeNull();
  });

  it.each(["queued", "dispatching"] as const)("while %s the footer is the working row, so nothing can be pressed", (exec_status) => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: `locked-${exec_status}`, exec_status });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={gads} handlers={h} />);
    expect(screen.getByTestId("exec-state").getAttribute("data-exec")).toBe(exec_status);
    for (const name of [/^Pause keywords$/, /Ask Zavi/, /I did this/, /Dismiss/, /More actions/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(h.onApprove).not.toHaveBeenCalled();
    expect(h.onRedo).not.toHaveBeenCalled();
  });

  it("once executed, the card says so and stops offering the change", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "done-1", exec_status: "executed" });
    render(<ChannelActionCard action={a} platform={gads} handlers={handlers()} />);
    const state = screen.getByTestId("exec-state");
    expect(state.getAttribute("data-exec")).toBe("executed");
    expect(state.textContent).toBe("Paused in Google Ads");
    expect(screen.queryByRole("button", { name: /^Pause keywords$/ })).toBeNull();
  });

  it("when failed, Not now works again", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "failed-snooze", exec_status: "failed", note: "Timeout", body: { ...FIXTURES.pause_ad.body, action_label: "Pause" } });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={gads} handlers={h} />);
    notNowFor("1 week");
    expectSnoozedFor(h, a, 7);
  });

  it("when failed, the error from note is toasted and the change can be retried", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "failed-1", exec_status: "failed", note: "Campaign not found", body: { ...FIXTURES.pause_ad.body, action_label: "Pause" } });
    const h = handlers();
    resetExecFailureToasts();
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    render(<ChannelActionCard action={a} platform={gads} handlers={h} />);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ title: "Google Ads did not take the change", description: "Campaign not found" });
    add.mockRestore();
    expect(screen.getByTestId("exec-state").getAttribute("data-exec")).toBe("failed");
    const retry = screen.getByRole("button", { name: /^Try again$/ }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(h.onApprove).toHaveBeenCalledWith(a);
  });
});

describe("ad footer, month-cap warning before an approve (decision D3)", () => {
  const cap_warning = "This puts you on track for $27,186 this month, $186 over your $27,000 cap";

  it("an open spend card shows the warning and still lets the founder approve", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "cap-1", cap_warning, body: { ...FIXTURES.pause_ad.body, action_label: "Raise" } });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={h} />);
    expect(screen.getByTestId("cap-warning").textContent).toContain(`${cap_warning}.`);
    fireEvent.click(screen.getByRole("button", { name: /^Raise$/ }));
    expect(h.onApprove).toHaveBeenCalledWith(a);
  });

  it("the warning is gone once the card is on its way or done", () => {
    for (const over of [{ exec_status: "queued" as const }, { exec_status: "executed" as const }, { status: "acted" as const }]) {
      const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: `cap-moved-${JSON.stringify(over)}`, cap_warning, ...over });
      render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
      expect(screen.queryByTestId("cap-warning")).toBeNull();
      cleanup();
    }
  });
});

describe("ad footer, held for the founder by Autopilot", () => {
  const held = { words: ["Pausing is your call"], evidence: "Last 7 days: $140 spent, 0 conversions.", wallet_short: false };

  it("a waiting card says why it is held, under the card, and keeps its own approve", () => {
    const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "held-1", held, body: { ...FIXTURES.pause_ad.body, action_label: "Pause" } });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={h} />);
    expect(screen.getByTestId("held-for-you").textContent).toBe("Held for you: Pausing is your call. Last 7 days: $140 spent, 0 conversions.");
    fireEvent.click(screen.getByRole("button", { name: /^Pause$/ }));
    expect(h.onApprove).toHaveBeenCalledWith(a);
    expect(screen.queryByRole("button", { name: /Add balance/ })).toBeNull();
  });

  it("the line is gone once the card moved", () => {
    for (const over of [{ exec_status: "queued" as const }, { exec_status: "executed" as const }, { status: "acted" as const }]) {
      const a = makeAction("pause_ad", { ...FIXTURES.pause_ad, id: `moved-${JSON.stringify(over)}`, held, ...over });
      render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
      expect(screen.queryByTestId("held-for-you")).toBeNull();
      cleanup();
    }
  });

  it("a ChatGPT card short on wallet offers Add balance first, then 'Balance added, approve & launch'", () => {
    const a = makeAction("pause_ad", {
      ...FIXTURES.pause_ad,
      id: "held-wallet",
      channel_slug: "chatgpt_ads",
      held: { words: ["the prepaid ChatGPT wallet cannot cover this campaign schedule; add balance or choose a smaller experiment"], evidence: null, wallet_short: true },
    });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={platformFor("chatgpt_ads")} handlers={h} />);
    expect(screen.getByTestId("held-for-you").textContent).toContain("prepaid ChatGPT wallet");
    expect(screen.queryByTestId("balance-dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add balance" }));
    expect(screen.getByTestId("balance-dialog")).toBeTruthy();
    expect(h.onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close balance" }));
    expect(screen.queryByTestId("balance-dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Balance added, approve & launch" }));
    expect(h.onApprove).toHaveBeenCalledWith(a);
  });
});

describe("ad footer, partial-risk failure", () => {
  const partial = (code: string, slug = "chatgpt_ads") =>
    makeAction("pause_ad", {
      ...FIXTURES.pause_ad,
      id: `partial-${code}-${slug}`,
      channel_slug: slug,
      exec_status: "failed",
      exec_code: code,
      note: "Created the campaign (paused), then the rest failed.",
      body: { ...FIXTURES.pause_ad.body, action_label: "Create campaign" },
    });

  it.each(["exec_partial", "exec_outcome_unknown"])("%s: no Try again, a link to the campaign list, and the no-retry hint", (code) => {
    const a = partial(code);
    const h = handlers();
    render(<ChannelActionCard action={a} platform={platformFor("chatgpt_ads")} handlers={h} />);
    expect(screen.queryByRole("button", { name: /^Try again$/ })).toBeNull();
    const link = screen.getByTestId("exec-partial-link");
    expect(link.getAttribute("href")).toBe("#campaigns");
    expect(link.textContent).toBe("Open campaign list");
    expect(screen.getByTestId("exec-state").textContent).toContain("will not run this again");
    expect(h.onApprove).not.toHaveBeenCalled();
  });

  it("a channel with no partial link still hides Try again", () => {
    render(<ChannelActionCard action={partial("exec_partial", "google_ads")} platform={platformFor("google_ads")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Try again$/ })).toBeNull();
    expect(screen.queryByTestId("exec-partial-link")).toBeNull();
  });

  it("an ordinary failure code still offers Try again", () => {
    const a = { ...partial("exec_partial"), exec_code: "google_ads_budget_drift" };
    render(<ChannelActionCard action={a} platform={platformFor("chatgpt_ads")} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
  });
});

describe("ad footer, not executable", () => {
  it("hands the change OUT to the platform instead of approving it here", () => {
    const a = makeAction("update_ad", { ...FIXTURES.update_ad, body: { ...FIXTURES.update_ad.body, action_label: "Adjust budget" } });
    const h = handlers();
    const platform = platformFor("google_ads");
    render(<ChannelActionCard action={a} platform={platform} handlers={h} />);
    expect(screen.queryByRole("button", { name: /^Adjust budget$/ })).toBeNull();
    expect(screen.getByTestId(`action-${a.id}`).querySelector("[data-approve]")).toBeNull();
    const out = screen.getByRole("link", { name: /^(Adjust budget|Review it)$/ });
    expect(out.getAttribute("href")).toBe("https://ads.google.com/aw/campaigns");

    askZavi("Is this enough?");
    expect(h.onOpenChat).toHaveBeenCalledWith(a, "Is this enough?");

    didThis();
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
    expect(h.onApprove).not.toHaveBeenCalled();

    cleanup();
    const h2 = handlers();
    render(<ChannelActionCard action={a} platform={platform} handlers={h2} />);
    closeCard();
    expect(h2.onSetStatus).toHaveBeenCalledWith(a, "rejected", { keep: true });
    expect(h2.onApprove).not.toHaveBeenCalled();

    expect(out.textContent?.trim()).toBe("Adjust budget");
  });
});

describe("not now picker", () => {
  it.each(["text_post"] as const)(
    "%s: offers Tomorrow / 3 days / 1 week, 1 week the default",
    (t) => {
      const a = FIXTURES[t];
      const h = handlers();
      render(<ChannelActionCard action={a} platform={platformFor(a.channel_slug)} handlers={h} />);
      menu(/Not now/);
      expect(h.onSetStatus).not.toHaveBeenCalled();
      const picker = screen.getByTestId("snooze-picker");
      expect(within(picker).getAllByRole("button").map((b) => b.textContent)).toEqual(["Tomorrow", "3 days", "1 week", "Cancel"]);
      const defaults = picker.querySelectorAll('[data-default="true"]');
      expect(defaults).toHaveLength(1);
      expect(defaults[0].textContent).toBe("1 week");
      fireEvent.click(within(picker).getByRole("button", { name: "1 week" }));
      expectSnoozedFor(h, a, 7);
      expect(screen.queryByTestId("snooze-picker")).toBeNull();
    },
  );

  it("Cancel closes the picker without snoozing", () => {
    const h = handlers();
    render(<ChannelActionCard action={FIXTURES.text_post} platform={platformFor("x_organic")} handlers={h} />);
    menu(/Not now/);
    fireEvent.click(within(screen.getByTestId("snooze-picker")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("snooze-picker")).toBeNull();
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });
});

describe("task footer", () => {
  it.each(["fix", "check", "setup", "page", "other", "send_message"] as const)(
    "%s: Done / Not now / Ask Zavi, and never an approve control",
    (t) => {
      const a = { ...FIXTURES[t], channel_slug: t === "send_message" ? "sms" : "blog" };
      const h = handlers();
      render(<ChannelActionCard action={a} handlers={h} />);
      askZavi("What do I do here?");
      expect(h.onOpenChat).toHaveBeenCalledWith(a, "What do I do here?");

      click("More actions");
      expect(screen.getByRole("menuitem", { name: /^Not now$/ })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /Dismiss/ })).toBeNull();
      click("More actions");
      expect(screen.getByTestId(`action-${a.id}`).querySelector("button[data-approve]")).toBeNull();
      expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Not now$/ })).toBeNull();

      didThis();
      expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", { keep: true });
      expect(h.onApprove).not.toHaveBeenCalled();
    },
  );

  it("the close icon rejects, and Not now snoozes for the chosen time", () => {
    const a = FIXTURES.check;
    const h = handlers();
    render(<ChannelActionCard action={a} handlers={h} />);
    closeCard();
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "rejected", { keep: true });

    cleanup();
    const h2 = handlers();
    render(<ChannelActionCard action={a} handlers={h2} />);
    notNowFor("3 days");
    expectSnoozedFor(h2, a, 3);
  });

  it("a rewrite goes through the side chat, and only where that chat exists", () => {
    const a = FIXTURES.check;
    const withChat = handlers({ onOpenRedoChat: vi.fn() });
    render(<ChannelActionCard action={a} handlers={withChat} />);
    menu(/rewrite/i);
    expect(withChat.onOpenRedoChat).toHaveBeenCalledWith(a);

    cleanup();
    const noChat = handlers();
    render(<ChannelActionCard action={a} handlers={noChat} />);
    click("More actions");
    expect(screen.queryByRole("menuitem", { name: /rewrite/i })).toBeNull();
  });

  it("offers NO rewrite on a card that spends, whatever the chat supplies", () => {
    const h = handlers({ onOpenRedoChat: vi.fn() });
    render(<ChannelActionCard action={FIXTURES.pause_ad} platform={platformFor("google_ads")} handlers={h} />);
    click("More actions");
    expect(screen.queryByRole("menuitem", { name: /rewrite|redo/i })).toBeNull();
  });
});

describe("ad Reject button", () => {
  it("opens a cancellable reason panel and requires feedback before submitting", () => {
    const action = makeAction("create_ad", { channel_slug: "chatgpt_ads", executable: true, status: "pending", exec_status: null });
    const h = handlers(); const platform = platformFor("chatgpt_ads");
    render(<AdsPresentation value={{ action, handlers: h, platform }}><ChannelActionCard action={action} handlers={h} platform={platform} /></AdsPresentation>);
    click(/^Reject$/);
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Why are you rejecting it?" })).toBeTruthy();
    click(/^Close$/);
    expect(h.onSetStatus).not.toHaveBeenCalled();
    click(/^Reject$/);
    const input = screen.getByRole("textbox", { name: "Why are you rejecting it?" });
    const reject = within(screen.getByTestId("note-panel-actions")).getByRole("button", { name: /^Reject$/ }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Wrong audience" } });
    fireEvent.click(reject);
    expect(h.onSetStatus).toHaveBeenCalledTimes(1);
    expect(h.onSetStatus).toHaveBeenCalledWith(action, "rejected", { note: "Wrong audience", hold: true, keep: true });
  });
});
