// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  calls: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    net.calls.push(path);
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) =>
        resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => r.body,
        }),
      );
      net.pending.set(key, queue);
    });
  },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => {},
}));

import { BuildTranscript } from "./BuildModePane";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const RUN_CREDITS = "/api/billing/run-credits";

const PROMPT = "A **bakery** site\n\n- menu page\n- `order` form";
const FIRST = "Make the hero *bigger*\nand add [a link](https://x.test)";
const FIRST_SUMMARY = "Made the hero **larger** and linked `x.test`.";
const SECOND = "## Add pricing\n1. Free\n2. Pro";
const SECOND_SUMMARY = "Added a pricing section with **two** tiers.";
const RUNNING = "Swap the font to *serif*";
const FAILED = "Add a > quote block";
const PARKED = "Rename the footer `links`";

const run = (status: string) => ({
  id: SESSION,
  objective: `Build product: Mohit — ${PROMPT}`,
  status,
  created_at: "2026-09-24T06:55:00.000Z",
  updated_at: "2026-09-24T07:10:00.000Z",
  stages: [],
});

const refine = (
  id: string,
  message: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `${id}0000000-0000-4000-8000-000000000000`,
  message,
  status,
  created_at: "2026-09-24T08:00:00.000Z",
  ...extra,
});

const transcript = [
  refine("a", FIRST, "done", { summary: FIRST_SUMMARY }),
  refine("b", SECOND, "done", { summary: SECOND_SUMMARY }),
  refine("c", RUNNING, "running", { summary: "Half-written summary so far" }),
  refine("d", FAILED, "failed", {
    summary: "Partial summary",
    failure_message: "Deploy failed",
  }),
  refine("e", PARKED, "done", {
    summary: "Built but parked",
    awaiting_review: true,
  }),
];

async function reply(path: string, r: Reply) {
  await waitFor(() =>
    expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0),
  );
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mount(status = "done", refines: unknown[] = transcript) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, {
    status: 200,
    body: { run: run(status), target: { live_url: "https://shop.test" } },
  });
  await reply(REFINES, { status: 200, body: { refines } });
}

function bubbleOf(raw: string): HTMLElement {
  const firstLine = raw.split("\n")[0]!;
  const hit = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="build-user-bubble"]'),
  ).find((el) => (el.textContent ?? "").includes(firstLine));
  if (!hit) throw new Error(`no bubble for ${firstLine}`);
  return hit;
}

function replyOf(text: string): HTMLElement {
  const reply = screen
    .getByText(text)
    .closest('[data-testid="build-reply"]') as HTMLElement | null;
  if (!reply) throw new Error(`no reply for ${text}`);
  return reply;
}

function summaryCopy(summary: string): HTMLElement {
  return within(replyOf(summary)).getByRole("button", { name: "Copy message" });
}

let writeText: Mock<[string], Promise<void>>;

beforeEach(() => {
  writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.calls = [];
  vi.useRealTimers();
});

describe("BuildTranscript copy", () => {
  it("renders the finished build Copy and More controls outside the summary box", async () => {
    await mount("done", []);

    const summaryToggle = screen.getByRole("button", {
      name: /Your app is ready/,
    });
    const card = summaryToggle.closest(".rounded-2xl") as HTMLElement;
    const more = screen.getByRole("button", { name: "More options" });
    const actions = more.parentElement?.parentElement as HTMLElement;
    const copy = within(actions).getByRole("button", { name: "Copy message" });

    expect(card.contains(copy)).toBe(false);
    expect(card.contains(more)).toBe(false);
    const reply = card.closest('[data-testid="build-root-reply"]') as HTMLElement;
    expect(actions.parentElement).toBe(reply);
    expect(actions.previousElementSibling?.contains(card)).toBe(true);
    expect(copy.parentElement).toBe(actions);
  });

  it("rates the finished build and each finished change from their footers, last in the row", async () => {
    const finished = refine("a", FIRST, "done", { summary: FIRST_SUMMARY });
    await mount("done", [finished]);
    const more = screen.getAllByRole("button", { name: "More options" })[0]!;
    const actions = more.parentElement?.parentElement as HTMLElement;
    const good = within(actions).getByRole("button", { name: "Good build" });
    expect(actions.lastElementChild?.contains(good)).toBe(true);
    const reply = replyOf(FIRST_SUMMARY);
    expect(within(reply).getByRole("button", { name: "Bad change" })).toBeTruthy();
  });

  it("keeps work time, credit usage, and preview inside More beside Copy", async () => {
    const finished = refine("a", FIRST, "done", {
      summary: FIRST_SUMMARY,
      updated_at: "2026-09-24T08:03:16.000Z",
      finished_at: "2026-09-24T08:03:16.000Z",
    });
    await mount("done", [finished]);

    const reply = replyOf(FIRST_SUMMARY);
    const copy = within(reply).getByRole("button", { name: "Copy message" });
    const more = within(reply).getByRole("button", { name: "More options" });
    expect(copy.parentElement).toBe(more.parentElement?.parentElement);
    expect(within(reply).queryByText(/3m 16s/)).toBeNull();
    expect(within(reply).queryByText(/credits/i)).toBeNull();
    expect(within(reply).queryByRole("link", { name: "Preview" })).toBeNull();

    fireEvent.click(more);

    const runId = finished.id;
    await waitFor(() =>
      expect(
        net.calls.some((path) => path.includes(encodeURIComponent(runId))),
      ).toBe(true),
    );
    const creditCalls = net.calls.filter((path) =>
      path.startsWith(RUN_CREDITS),
    );
    const requestIndex = creditCalls.findIndex((path) =>
      path.includes(encodeURIComponent(runId)),
    );
    const resolveCredits = net.pending
      .get(RUN_CREDITS)!
      .splice(requestIndex, 1)[0]!;
    await act(async () => {
      resolveCredits({
        status: 200,
        body: {
          runs: { [runId]: { credits: 338, usd: 0.845, status: "settled" } },
        },
      });
    });

    expect(within(reply).getByText("Worked for")).toBeTruthy();
    expect(within(reply).getByText("3m 16s")).toBeTruthy();
    expect(within(reply).getByText("Credits")).toBeTruthy();
    expect(within(reply).queryByText("Credits used")).toBeNull();
    expect(within(reply).getByText("338 credits")).toBeTruthy();
    const preview = within(reply).getByRole("link", {
      name: "Preview",
    });
    expect(preview.getAttribute("href")).toBe("https://shop.test/");
    expect(preview.getAttribute("target")).toBe("_blank");
    expect(within(bubbleOf(FIRST)).queryByText(/credits/i)).toBeNull();

    fireEvent.mouseDown(document.body);
    expect(
      within(reply).queryByRole("dialog", { name: "Run details" }),
    ).toBeNull();
  });

  it("copies the exact raw text of the message whose button was clicked, never a neighbour's", async () => {
    await mount();

    await act(async () => {
      fireEvent.click(
        within(bubbleOf(SECOND)).getByRole("button", { name: "Copy message" }),
      );
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(SECOND);
    expect(
      within(bubbleOf(SECOND)).getByRole("button", { name: "Copied" }),
    ).toBeTruthy();
    expect(
      within(bubbleOf(FIRST)).getByRole("button", { name: "Copy message" }),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(bubbleOf(PROMPT)).getByRole("button", { name: "Copy message" }),
      );
    });
    expect(writeText).toHaveBeenLastCalledWith(PROMPT);

    await act(async () => {
      fireEvent.click(
        within(bubbleOf(FIRST)).getByRole("button", { name: "Copy message" }),
      );
    });
    expect(writeText).toHaveBeenLastCalledWith(FIRST);

    await act(async () => {
      fireEvent.click(summaryCopy(FIRST_SUMMARY));
    });
    expect(writeText).toHaveBeenLastCalledWith(FIRST_SUMMARY);

    await act(async () => {
      fireEvent.click(summaryCopy(SECOND_SUMMARY));
    });
    expect(writeText).toHaveBeenLastCalledWith(SECOND_SUMMARY);
    expect(writeText).toHaveBeenCalledTimes(5);
  });

  it("offers copy without exposing billing details, never on a running card", async () => {
    await mount();
    const buttons = screen.getAllByRole("button", { name: "Copy message" });
    expect(buttons).toHaveLength(11);
    for (const raw of [PROMPT, FIRST, SECOND, RUNNING, FAILED, PARKED]) {
      expect(
        within(bubbleOf(raw)).getAllByRole("button", { name: "Copy message" }),
      ).toHaveLength(1);
    }
    expect(
      within(replyOf("Getting started…")).queryByRole("button", {
        name: /Copy|Copied|Message options/,
      }),
    ).toBeNull();
    for (const title of ["This change didn't finish", "Saved, not live yet"]) {
      const reply = replyOf(title);
      const copy = within(reply).getByRole("button", { name: "Copy message" });
      const card = within(reply)
        .getByText(title)
        .closest(".rounded-2xl") as HTMLElement;
      expect(card.contains(copy)).toBe(false);
      expect(
        card.compareDocumentPosition(copy.parentElement!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        within(copy.parentElement as HTMLElement).getByRole("button", {
          name: "More options",
        }),
      ).toBeTruthy();
    }
    for (const raw of [PROMPT, FIRST, SECOND, RUNNING, FAILED, PARKED]) {
      const button = within(bubbleOf(raw)).getByRole("button", {
        name: "Copy message",
      });
      const above = button.parentElement
        ?.previousElementSibling as HTMLElement | null;
      expect(above?.classList.contains("rounded-[20px]")).toBe(true);
      expect((above?.textContent ?? "").includes(raw.split("\n")[0]!)).toBe(
        true,
      );
      expect(
        within(button.parentElement as HTMLElement).queryByRole("button", {
          name: "More options",
        }),
      ).toBeNull();
    }
    expect(screen.queryByText("Half-written summary so far")).toBeTruthy();
    for (const button of buttons) {
      fireEvent.click(button);
    }
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(11));
    const copied = writeText.mock.calls.map((call) => call[0]);
    expect(copied).not.toContain("Half-written summary so far");
    expect(
      copied.some((text) => text.startsWith("This change didn't finish\n")),
    ).toBe(true);
    expect(copied).toContain(
      "Saved, not live yet\nBuilt but parked\nYour change is built and saved. It isn't on the live preview yet.",
    );
  });

  it("a draft change shows only the Publish hint, with what changed folded under What changed", async () => {
    const DRAFT = "Make the menu prices bold";
    const BARE = "Tidy the footer";
    await mount("done", [
      refine("f", DRAFT, "done", { summary: "Menu prices are now bold.", draft: true }),
      refine("g", BARE, "done", { summary: null, draft: true }),
    ]);
    const card = within(replyOf("Menu prices are now bold."))
      .getByText("Menu prices are now bold.")
      .closest(".rounded-2xl") as HTMLElement;
    expect(within(card).getByText("Ready in your preview")).toBeTruthy();
    const shown = Array.from(card.querySelectorAll("p")).filter((p) => !p.closest("details")).map((p) => p.textContent);
    expect(shown).toEqual(["Press Publish to put it on your live app."]);
    const fold = within(card).getByTestId("change-summary") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText("What changed")).toBeTruthy();
    expect(within(fold).getByText("Menu prices are now bold.")).toBeTruthy();
    const bareReplies = screen
      .getAllByText("Press Publish to put it on your live app.")
      .map((el) => el.closest('[data-testid="build-reply"]'));
    expect(bareReplies).toHaveLength(2);
    const bareCard = bareReplies.find((r) => !(r?.textContent ?? "").includes("Menu prices"))!;
    expect(Array.from(bareCard.querySelectorAll(".rounded-2xl p")).map((p) => p.textContent)).toEqual([
      "Press Publish to put it on your live app.",
    ]);
    fireEvent.click(within(replyOf("Menu prices are now bold.")).getByRole("button", { name: "Copy message" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Ready in your preview\nMenu prices are now bold.\nPress Publish to put it on your live app.",
      ),
    );
  });

  it("a question the engineer asked shows as a question to reply to, never a spinner or 'Ready in your preview' (round 9)", async () => {
    await mount("done", [
      refine("q", "Change the footer tagline to Baked fresh.", "done", {
        draft: true,
        declared_outcome: "needs_input",
        declared_message: "Your site has no footer yet. Should I add one with this tagline?",
      }),
    ]);
    const card = within(replyOf("Your site has no footer yet. Should I add one with this tagline?"))
      .getByText("A question for you")
      .closest(".rounded-2xl") as HTMLElement;
    expect(within(card).getByText("Reply in the chat and I'll make the change.")).toBeTruthy();
    expect(within(card).queryByText("Ready in your preview")).toBeNull();
    expect(screen.queryByText("Update in progress")).toBeNull();
  });

  it("a change the engineer refused says it didn't happen, with the reason", async () => {
    await mount("done", [
      refine("x", "Connect my Stripe account", "done", {
        declared_outcome: "refused",
        declared_message: "Payments are set up in Settings, not from a change.",
      }),
    ]);
    const card = within(replyOf("Payments are set up in Settings, not from a change."))
      .getByText("This change didn't happen")
      .closest(".rounded-2xl") as HTMLElement;
    expect(within(card).queryByText(/Press Publish/)).toBeNull();
  });

  it("a change that found nothing to change says so, never 'Ready in your preview' or a Publish hint", async () => {
    await mount("done", [
      refine("h", "Change the footer tagline to Baked fresh every morning.", "done", { summary: "The footer already reads that.", draft: true, no_change: true }),
    ]);
    const card = within(replyOf("That already says what you asked for, nothing to change."))
      .getByText("Nothing to change")
      .closest(".rounded-2xl") as HTMLElement;
    expect(within(card).queryByText("Ready in your preview")).toBeNull();
    expect(within(card).queryByText(/Press Publish/)).toBeNull();
  });

  it("puts no copy on the live build checklist while the build is running", async () => {
    await mount("running", []);
    const checklist = screen
      .getByText("Building your app")
      .closest(".rounded-2xl") as HTMLElement;
    expect(
      within(checklist).queryByRole("button", { name: /Copy|Copied/ }),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Copy message" }),
    ).toHaveLength(1);
    expect(
      within(bubbleOf(PROMPT)).getByRole("button", { name: "Copy message" }),
    ).toBeTruthy();
  });

  it("does not claim Copied when the clipboard write rejects", async () => {
    writeText.mockImplementation(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );
    await mount();
    await act(async () => {
      fireEvent.click(
        within(bubbleOf(FIRST)).getByRole("button", { name: "Copy message" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(FIRST);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(
      within(bubbleOf(FIRST)).getByRole("button", { name: "Copy message" }),
    ).toBeTruthy();
  });

  it("does not throw or claim Copied when the clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    await mount();
    await act(async () => {
      fireEvent.click(summaryCopy(FIRST_SUMMARY));
    });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});

describe("the build's own reply", () => {
  it("carries the Zavi mascot on its left like every change reply, never the old wordmark tile", async () => {
    await mount();
    const reply = screen
      .getByText("Your app is ready")
      .closest('[data-testid="build-root-reply"]') as HTMLElement;
    expect(reply.querySelector('img[src="/mascots/video/zavi-still.webp"]')).not.toBeNull();
    expect(document.querySelector('img[src="/zavi-white.svg"]')).toBeNull();
    const mascot = reply.querySelector('img[src="/mascots/video/zavi-still.webp"]') as HTMLImageElement;
    expect(mascot.className).toContain("h-10 w-10");
    expect(mascot.parentElement!.className).toContain("w-6");
    const footer = within(reply).getByRole("button", { name: "Copy message" }).parentElement!;
    expect(footer.className).toContain("pl-[34px]");
    expect(footer.parentElement).toBe(reply);
    for (const summary of [FIRST_SUMMARY, SECOND_SUMMARY]) {
      expect(replyOf(summary).querySelector('img[src="/mascots/video/zavi-still.webp"]')).not.toBeNull();
    }
  });
});
