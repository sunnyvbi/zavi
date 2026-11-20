// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ChatBubble } from "./ChatBubble";
import { resetReplyRatings } from "@/lib/workspace/replyRatings";

const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let saved: Record<string, { rating: number | null; comment: string | null }> = {};

const ok = (url: string) =>
  Promise.resolve({
    ok: true,
    json: async () => (url.startsWith("/api/feedback/mine") ? { ratings: saved } : { ok: true }),
  });
const posts = () => apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST");
const reads = () => apiFetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/feedback/mine"));
const bodies = () => posts().map((c) => JSON.parse((c[1] as { body: string }).body));

beforeEach(() => {
  saved = {};
  resetReplyRatings();
  apiFetch.mockReset();
  apiFetch.mockImplementation(ok);
});

afterEach(() => cleanup());

const good = () => screen.getByRole("button", { name: "Good response" });
const bad = () => screen.getByRole("button", { name: "Bad response" });
const note = () => screen.queryByRole("textbox", { name: "What was wrong with this reply" });

function Reply({ runId }: { runId?: string }) {
  return <ChatBubble role="assistant" text="Here is the plan" agentSlug="operator" feedbackRunId={runId} />;
}

describe("ChatBubble reply feedback", () => {
  it("shows the thumbs next to Copy only when the reply has a run to rate", () => {
    const { rerender } = render(<Reply />);
    expect(screen.queryByRole("button", { name: "Good response" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();

    rerender(<Reply runId="run-1" />);
    expect(good()).toBeTruthy();
    expect(bad()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("does not offer feedback on a reply that is still streaming", () => {
    render(<ChatBubble role="assistant" text="Half a" agentSlug="operator" feedbackRunId="run-1" isStreaming />);
    expect(screen.queryByRole("button", { name: "Good response" })).toBeNull();
  });

  it("records Good response against the reply's run and keeps it pressed", async () => {
    render(<Reply runId="run-1" />);
    fireEvent.click(good());
    await waitFor(() => expect(good().getAttribute("aria-pressed")).toBe("true"));
    expect(bodies()).toEqual([{ target_type: "agent_run", target_id: "run-1", rating: 1, comment: null }]);
    expect(bad().getAttribute("aria-pressed")).toBe("false");
    expect(note()).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();

    fireEvent.click(good());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("records Bad response, then sends the optional note with it", async () => {
    render(<Reply runId="run-1" />);
    fireEvent.click(bad());
    await waitFor(() => expect(note()).toBeTruthy());
    expect(bad().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(note()!, { target: { value: "  The numbers are wrong  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(note()).toBeNull());
    expect(bodies()).toEqual([
      { target_type: "agent_run", target_id: "run-1", rating: -1, comment: null },
      { target_type: "agent_run", target_id: "run-1", rating: -1, comment: "The numbers are wrong" },
    ]);
    expect(screen.getByText("Thanks for the feedback")).toBeTruthy();
  });

  it("keeps the rating when the note is skipped", async () => {
    render(<Reply runId="run-1" />);
    fireEvent.click(bad());
    await waitFor(() => expect(note()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(note()).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(bad().getAttribute("aria-pressed")).toBe("true");
  });

  it("lets the founder change their mind from Bad to Good", async () => {
    render(<Reply runId="run-1" />);
    fireEvent.click(bad());
    await waitFor(() => expect(note()).toBeTruthy());
    fireEvent.click(good());
    await waitFor(() => expect(good().getAttribute("aria-pressed")).toBe("true"));
    expect(note()).toBeNull();
    expect(bad().getAttribute("aria-pressed")).toBe("false");
    expect(bodies().at(-1)).toEqual({ target_type: "agent_run", target_id: "run-1", rating: 1, comment: null });
  });

  it("shows the error and leaves nothing pressed when the save fails", async () => {
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/feedback/mine")
        ? ok(url)
        : Promise.resolve({ ok: false, status: 400, json: async () => ({ error: { message: "target not found" } }) }),
    );
    render(<Reply runId="run-1" />);
    fireEvent.click(bad());
    await waitFor(() => expect(screen.getByText("target not found")).toBeTruthy());
    expect(bad().getAttribute("aria-pressed")).toBe("false");
    expect(note()).toBeNull();
  });

  it("shows the saved rating after a reload and does not post it again", async () => {
    saved = { [RUN_A]: { rating: -1, comment: "The numbers are wrong" } };
    render(<Reply runId={RUN_A} />);
    await waitFor(() => expect(bad().getAttribute("aria-pressed")).toBe("true"));
    expect(good().getAttribute("aria-pressed")).toBe("false");
    expect(note()).toBeNull();

    fireEvent.click(bad());
    expect(posts()).toHaveLength(0);
  });

  it("reads every reply's saved rating in one request", async () => {
    saved = { [RUN_B]: { rating: 1, comment: null } };
    render(
      <>
        <Reply runId={RUN_A} />
        <Reply runId={RUN_B} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Good response" })[1]!.getAttribute("aria-pressed")).toBe("true"));
    expect(reads()).toHaveLength(1);
    expect(String(reads()[0]![0])).toBe(`/api/feedback/mine?target_type=agent_run&ids=${RUN_A},${RUN_B}`);
    expect(screen.getAllByRole("button", { name: "Good response" })[0]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a new rating when the reply is shown again, without reading it back", async () => {
    const { unmount } = render(<Reply runId={RUN_A} />);
    await waitFor(() => expect(good().hasAttribute("disabled")).toBe(false));
    fireEvent.click(good());
    await waitFor(() => expect(good().getAttribute("aria-pressed")).toBe("true"));
    unmount();

    render(<Reply runId={RUN_A} />);
    expect(good().getAttribute("aria-pressed")).toBe("true");
    expect(reads()).toHaveLength(1);
  });
});
