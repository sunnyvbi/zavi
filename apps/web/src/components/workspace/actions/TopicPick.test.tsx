// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { act } from "react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelActionCard } from "./ChannelActionCard";
import { platformFor } from "./platforms";
import type { ActionHandlers } from "./types";
import { TopicPickList, TopicResearch, topicPickOf } from "./TopicPick";
import { makeAction } from "./__tests__/fixtures";
import { KeptCardsProvider } from "./card/keptCards";

const moveToHistory = vi.hoisted(() => vi.fn());
vi.mock("./card/useMoveToHistory", () => ({ useMoveToHistory: (options: unknown) => moveToHistory(options) }));

vi.mock("./topActions/api", async () => {
  const actual = await vi.importActual<typeof import("./topActions/api")>("./topActions/api");
  return { ...actual, readTopActionContext: vi.fn().mockResolvedValue({ credits: 460 }) };
});

afterEach(cleanup);
beforeEach(() => {
  moveToHistory.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const topics = [0, 1].map((n) => ({
  title: `Topic ${n}`, why: `why ${n}`, searches: [`q${n}`], ranks: [{ site: `s${n}.com`, note: "n" }],
  your_site: "none", have: [{ text: `fact ${n}`, src: "src" }], fill: n ? [] : ["One quote"],
}));
const card = { body: { step: { deliverable: { kind: "proof_topics", label: "Pick", content: "x", presentation: { type: "topic_pick", topics } } } } };

describe("TopicPick", () => {
  it("reads the topics off the card", () => {
    expect(topicPickOf(card as never)?.length).toBe(2);
    expect(topicPickOf({ body: {} } as never)).toBeNull();
    expect(topicPickOf({ body: null } as never)).toBeNull();
  });
  it("drops a broken topic and survives junk fields", () => {
    const junk = { body: { step: { deliverable: { presentation: { type: "topic_pick", topics: [{ title: "" }, null, 7, { title: "Ok", searches: "nope", ranks: [null, { site: 3 }] }] } } } } };
    const t = topicPickOf(junk as never);
    expect(t).toHaveLength(1);
    expect(t?.[0]).toMatchObject({ title: "Ok", searches: [], ranks: [], have: [], fill: [] });
  });
  it("selects the best bet first and swaps the research on tap", () => {
    const onSelect = vi.fn();
    render(<TopicPickList topics={topics} selected={0} onSelect={onSelect} />);
    expect(screen.getByRole("radio", { name: /Topic 0/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Topic 1/ }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: /Topic 1/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
  it("shows the selected topic's research and the blanks left", () => {
    render(<TopicResearch topic={topics[0]} />);
    expect(screen.getByText("“q0”")).toBeTruthy();
    expect(screen.getByText("1 blank to fill")).toBeTruthy();
    render(<TopicResearch topic={topics[1]} />);
    expect(screen.getByText("No blanks")).toBeTruthy();
  });
});

describe("the pick card", () => {
  const pickCard = (): ChannelActionView =>
    makeAction("check", {
      channel_slug: "seo",
      title: "Pick your next page",
      body: { step: { title: "Pick your next page", body: "One new page a month.", deliverable: card.body.step.deliverable } } as never,
      card_kind: "task",
      primary_label: "Write this page",
      done_label: "Writing it",
      how_to: ["Pick one.", "Press Write this page.", "Fill any blank."],
    });

  it("writes the selected topic's page from the main button", async () => {
    const h: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onWriteProofPage: vi.fn().mockResolvedValue(true) };
    const a = pickCard();
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={h} />);
    const research = () => {
      fireEvent.click(screen.getByRole("button", { name: "What it is" }));
      const text = screen.getByRole("dialog").textContent;
      fireEvent.click(screen.getByRole("button", { name: "Got it" }));
      return text;
    };
    expect(research()).toContain("“q0”");
    fireEvent.click(screen.getByRole("radio", { name: /Topic 1/ }));
    expect(research()).toContain("“q1”");
    fireEvent.click(screen.getByRole("button", { name: "Write this page" }));
    expect(h.onWriteProofPage).toHaveBeenCalledWith(a, 1);
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("About 460 credits")).toBeTruthy();
  });

  it("disables the main button while the page is being written", () => {
    const h: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onWriteProofPage: vi.fn() };
    render(<ChannelActionCard action={pickCard()} platform={platformFor("seo")} handlers={h} redoing="working" />);
    expect((screen.getByRole("button", { name: "Write this page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves a rejected topic card to History", async () => {
    const h: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn() };
    render(<KeptCardsProvider value={{ keep: vi.fn(), release: vi.fn() }}><ChannelActionCard action={pickCard()} platform={platformFor("seo")} handlers={h} /></KeptCardsProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Not relevant" } });
    fireEvent.click(within(screen.getByTestId("note-panel-actions")).getByRole("button", { name: "Reject" }));
    await act(async () => {});
    expect(moveToHistory).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });
});
