// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const { apiFetch, openTab } = vi.hoisted(() => ({ apiFetch: vi.fn(), openTab: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ openTab }) }));

import { QUESTIONS_ANCHOR_ID, QUESTIONS_JUMP_EVENT, WaitingForYou, WaitingForYouLink, takeQuestionsJump } from "./WaitingForYou";
import { TeamNoteStrip } from "./chat/TeamNoteStrip";
import { NOTICE_DOT, NOTICE_SURFACE } from "./chat/composerNotice";

const question = (id: string) => ({ id, ordinal: 1, ask: "Raise prices?", recommended: null, why: null, yes_no: true });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  apiFetch.mockReset();
  openTab.mockReset();
  window.localStorage.clear();
});
afterEach(() => cleanup());

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);
const withAll = (root: Element, cls: string) =>
  [...root.querySelectorAll<HTMLElement>("*")].filter((el) => tokens(cls).every((t) => el.classList.contains(t)));

describe("WaitingForYouLink", () => {
  it("is one clickable pill with a real arrow icon, the whole surface opens Your CGO", async () => {
    apiFetch.mockResolvedValue(ok({ questions: [question("q1")] }));
    const { container } = render(<WaitingForYouLink />);
    const nudge = await screen.findByTestId("questions-nudge");

    expect(container.querySelectorAll("button, a")).toHaveLength(2);
    expect(nudge.querySelector("button")).toBeNull();
    expect(nudge.tagName).toBe("BUTTON");
    expect(nudge.textContent).toBe("Zavi has 1 question for youOpen Your CGO");
    expect(nudge.textContent).not.toContain("→");
    const arrows = nudge.querySelectorAll("svg");
    expect(arrows).toHaveLength(1);
    expect(arrows[0].getAttribute("aria-hidden")).toBe("true");
    expect(arrows[0].getAttribute("class")).toContain("group-hover:translate-x-0.5");
    expect(tokens(nudge.className)).toEqual(expect.arrayContaining(["group", ...tokens(NOTICE_SURFACE)]));
    expect(nudge.className).toMatch(/hover:bg-/);
    expect(nudge.className).toMatch(/focus-visible:outline/);

    const label = within(nudge).getByText("Zavi has 1 question for you");
    const action = within(nudge).getByText("Open Your CGO");
    expect(label.className).toContain("text-inkMuted");
    expect(action.className).toContain("font-medium");
    expect(action.className).toContain("text-ink");

    fireEvent.click(label);
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab.mock.calls[0][0]).toMatchObject({ kind: "autopilot", title: "Your CGO" });
  });

  it("asks the Growth page to land on the questions, once", async () => {
    apiFetch.mockResolvedValue(ok({ questions: [question("q1"), question("q2"), question("q3")] }));
    takeQuestionsJump();
    const heard = vi.fn();
    window.addEventListener(QUESTIONS_JUMP_EVENT, heard);
    render(<WaitingForYouLink embedded />);
    fireEvent.click(await screen.findByTestId("questions-nudge"));
    window.removeEventListener(QUESTIONS_JUMP_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(takeQuestionsJump()).toBe(true);
    expect(takeQuestionsJump()).toBe(false);
  });

  it("the jump target is the first question still open, none when all are answered", () => {
    const q2 = { ...question("q2"), ask: "Second?" };
    const view = render(
      <ul>
        <WaitingForYou questions={[question("q1"), q2]} canAnswer answered={{ q1: { label: "Answered: Yes", note: null } }} onAnswered={() => {}} />
      </ul>,
    );
    expect(document.getElementById(QUESTIONS_ANCHOR_ID)?.textContent).toContain("Second?");
    view.rerender(
      <ul>
        <WaitingForYou
          questions={[question("q1"), q2]}
          canAnswer
          answered={{ q1: { label: "Answered: Yes", note: null }, q2: { label: "Answered: No", note: null } }}
          onAnswered={() => {}}
        />
      </ul>,
    );
    expect(document.getElementById(QUESTIONS_ANCHOR_ID)).toBeNull();
  });

  it("drops a jump request nobody took in time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      apiFetch.mockResolvedValue(ok({ questions: [question("q1")] }));
      render(<WaitingForYouLink />);
      fireEvent.click(await screen.findByTestId("questions-nudge"));
      vi.setSystemTime(Date.now() + 60_000);
      expect(takeQuestionsJump()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on the home welcome it is a compact highlighted callout under the title; in chat it keeps the quiet notice", async () => {
    apiFetch.mockResolvedValue(ok({ questions: [question("q1"), question("q2")] }));
    const chat = render(<WaitingForYouLink />);
    const chatPill = await within(chat.container).findByTestId("questions-nudge");
    expect(chatPill.getAttribute("data-variant")).toBe("inline");
    expect(chatPill.className).not.toContain("amber-500");
    cleanup();
    const home = render(<WaitingForYouLink embedded />);
    const homePill = await within(home.container).findByTestId("questions-nudge");
    expect(homePill.getAttribute("data-variant")).toBe("home");
    expect(homePill.className).toMatch(/(^|\s)h-9(\s|$)/);
    expect(homePill.className).toContain("bg-amber-500/[0.09]");
    expect(homePill.className).toContain("rounded-xl");
    expect(homePill.className).not.toContain("rounded-full");
    expect(homePill.querySelector(".animate-ping")?.className).toContain("motion-reduce:animate-none");
    expect(homePill.parentElement!.parentElement!.className).toMatch(/(^|\s)mb-4(\s|$)/);
    expect(homePill.textContent).toContain("Zavi has 2 questions for you");
    expect(homePill.textContent).toContain("Open Your CGO");
  });

  it("the X hides the line without opening Your CGO, and it stays hidden on the next load", async () => {
    apiFetch.mockResolvedValue(ok({ questions: [question("q1"), question("q2")] }));
    render(<WaitingForYouLink embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("questions-nudge")).toBeNull();
    expect(openTab).not.toHaveBeenCalled();
    cleanup();

    apiFetch.mockResolvedValue(ok({ questions: [question("q2")] }));
    render(<WaitingForYouLink embedded />);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(screen.queryByTestId("questions-nudge")).toBeNull();
  });

  it("a new question brings the hidden line back", async () => {
    window.localStorage.setItem("zavi:questions-nudge-hidden", JSON.stringify(["q1"]));
    apiFetch.mockResolvedValue(ok({ questions: [question("q1"), question("q3")] }));
    render(<WaitingForYouLink embedded />);
    expect((await screen.findByTestId("questions-nudge")).textContent).toContain("Zavi has 2 questions for you");
  });

  it("renders nothing when no question waits", async () => {
    apiFetch.mockResolvedValue(ok({ questions: [] }));
    const { container } = render(<WaitingForYouLink />);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

describe("question nudge and team-note bar share one visual system", () => {
  it("both use the same surface, dot and type scale", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("/growth/questions") ? ok({ questions: [question("q1")] }) : ok({}),
    );
    render(
      <>
        <WaitingForYouLink />
        <TeamNoteStrip
          threadId="t1"
          teamNote={{ messageId: "m1", offerId: "o", note: "n", offerStop: false, state: "shown", surface: "strip", anchorMessageId: "m1" }}
          replying={false}
        />
      </>,
    );
    const nudge = await screen.findByTestId("questions-nudge");
    const strip = screen.getByTestId("team-note-strip");
    const surfaces = withAll(strip, NOTICE_SURFACE);
    expect(surfaces).toHaveLength(1);
    const surface = surfaces[0];
    expect(tokens(nudge.className)).toEqual(expect.arrayContaining(tokens(NOTICE_SURFACE)));

    expect(withAll(nudge, NOTICE_DOT)).toHaveLength(1);
    expect(withAll(surface, NOTICE_DOT)).toHaveLength(1);

    const stripLabel = within(strip).getByText("That went badly. I wrote a note for the Zavi team.");
    const nudgeLabel = within(nudge).getByText(/question for you/);
    expect(stripLabel.className).toContain("text-inkMuted");
    expect(nudgeLabel.className).toContain("text-inkMuted");

    const send = within(strip).getByRole("button", { name: "Send to Zavi team" });
    const dismiss = within(strip).getByRole("button", { name: "Dismiss" });
    expect(send.className).toContain("rounded-full");
    expect(send.className).toContain("h-7");
    expect(dismiss.className).toContain("h-7");
  });
});

describe("WaitingForYou: a claim about the founder's own records (owner call C)", () => {
  const solid = (b: HTMLElement) => b.className.includes("bg-ink");
  it("neither answer is styled as the default; an unrecommended question shows Yes and No alike (cgo-log 2026-10-23)", () => {
    const onAnswered = vi.fn();
    const plain = render(<ul><WaitingForYou questions={[question("q1")]} canAnswer answered={{}} onAnswered={onAnswered} /></ul>);
    expect(solid(within(plain.container).getByRole("button", { name: "Yes" }))).toBe(false);
    expect(solid(within(plain.container).getByRole("button", { name: "No" }))).toBe(false);
    cleanup();
    const rec = render(<ul><WaitingForYou questions={[{ ...question("q3"), recommended: "no" }]} canAnswer answered={{}} onAnswered={onAnswered} /></ul>);
    expect(solid(within(rec.container).getByRole("button", { name: "No" }))).toBe(true);
    expect(solid(within(rec.container).getByRole("button", { name: "Yes" }))).toBe(false);
    cleanup();
    const fact = render(<ul><WaitingForYou questions={[{ ...question("q2"), fact_check: true }]} canAnswer answered={{}} onAnswered={onAnswered} /></ul>);
    expect(solid(within(fact.container).getByRole("button", { name: "Yes" }))).toBe(false);
    expect(solid(within(fact.container).getByRole("button", { name: "No" }))).toBe(false);
  });

  it("a question closed before the tap (withdrawn or expired) says so, never 'already answered'", async () => {
    apiFetch.mockResolvedValue(ok({ outcome: "closed", question_id: "q4", ordinal: 1, ask: "x" }));
    const onAnswered = vi.fn();
    const r = render(<ul><WaitingForYou questions={[{ ...question("q4"), fact_check: true }]} canAnswer answered={{}} onAnswered={onAnswered} /></ul>);
    fireEvent.click(within(r.container).getByRole("button", { name: "No" }));
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled());
    expect(onAnswered).toHaveBeenCalledWith("q4", { label: "No longer open", note: "Nothing changed." });
  });

  it("an answer that changed nothing shows why", async () => {
    apiFetch.mockResolvedValue(ok({ outcome: "answered", answer: "yes", applied: null, note: "Nothing changed: that idea was already ruled out." }));
    const onAnswered = vi.fn();
    const r = render(<ul><WaitingForYou questions={[{ ...question("q3"), fact_check: true }]} canAnswer answered={{}} onAnswered={onAnswered} /></ul>);
    fireEvent.click(within(r.container).getByRole("button", { name: "Yes" }));
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled());
    expect(onAnswered).toHaveBeenCalledWith("q3", { label: "Not applied: Yes", note: "Nothing changed: that idea was already ruled out." });
  });
});

describe("WaitingForYou: Not now, and the questions waiting behind", () => {
  it("'Not now' posts not_now and says it won't be asked again for two weeks", async () => {
    apiFetch.mockResolvedValue(ok({ outcome: "answered", answer: "not_now", applied: null }));
    const onAnswered = vi.fn();
    const r = render(<ul><WaitingForYou questions={[question("q1")]} canAnswer answered={{}} onAnswered={onAnswered} /></ul>);
    fireEvent.click(within(r.container).getByRole("button", { name: "Not now" }));
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled());
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ answer: "not_now" });
    expect(onAnswered).toHaveBeenCalledWith("q1", { label: "Not now", note: "Zavi won't ask this again for two weeks." });
  });

  it("no 'Not now' on a claim about the founder's own records, nor for a member who cannot answer", () => {
    const fact = render(<ul><WaitingForYou questions={[{ ...question("q2"), fact_check: true }]} canAnswer answered={{}} onAnswered={vi.fn()} /></ul>);
    expect(within(fact.container).queryByRole("button", { name: "Not now" })).toBeNull();
    cleanup();
    const member = render(<ul><WaitingForYou questions={[question("q3")]} canAnswer={false} answered={{}} onAnswered={vi.fn()} /></ul>);
    expect(within(member.container).queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("ends with how many questions wait behind these", () => {
    const one = render(<ul><WaitingForYou questions={[question("q1")]} canAnswer queuedCount={1} answered={{}} onAnswered={vi.fn()} /></ul>);
    expect(within(one.container).getByTestId("questions-queued").textContent).toBe("1 more question after these. It opens as you answer.");
    cleanup();
    const none = render(<ul><WaitingForYou questions={[question("q1")]} canAnswer answered={{}} onAnswered={vi.fn()} /></ul>);
    expect(within(none.container).queryByTestId("questions-queued")).toBeNull();
  });
});
