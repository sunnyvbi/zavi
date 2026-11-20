import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelActions } from "./useChannelActions";
import { TaskFooter, REJECT_NOTE_MAX } from "./ActionFooter";
import { makeAction } from "./__tests__/fixtures";

const SLUG = "linkedin_ads";
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const card = makeAction("send_message", { id: "ca-1", channel_slug: SLUG });

let rejected = false;
let answer: () => Promise<unknown>;
let release: () => void = () => {};

beforeEach(() => {
  rejected = false;
  apiFetch.mockReset().mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST") return answer();
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ actions: rejected ? [] : [card], more: 0, store: "channel_actions", plan: null });
  });
});
afterEach(cleanup);

function Board() {
  const s = useChannelActions(SLUG);
  return (
    <div>
      {s.notice && <p data-testid="notice">{s.notice}</p>}
      {s.actions.map((a) => (
        <div key={a.id} data-testid={`card-${a.id}`}>
          <TaskFooter a={a} handlers={s.handlers} busy={s.busyId === a.id} />
        </div>
      ))}
    </div>
  );
}

const box = () => screen.getByRole("textbox", { name: "Why are you rejecting it?" }) as HTMLTextAreaElement;
const submit = () => screen.getAllByRole("button", { name: "Reject" }).find((b) => !b.hasAttribute("aria-expanded"))!;

async function openReject(reason: string) {
  render(<Board />);
  await waitFor(() => expect(screen.getByTestId("card-ca-1")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Reject", expanded: false }));
  fireEvent.change(box(), { target: { value: reason } });
}

describe("the Reject reason box", () => {
  it("stays open with the reason until the server answers, and keeps the reason when Reject fails", async () => {
    answer = () => new Promise((resolve) => {
      release = () => resolve({ ok: false, status: 500, json: async () => ({}) });
    });
    await openReject("We never discount, so skip price posts");
    await act(async () => {
      fireEvent.click(submit());
    });
    expect(screen.getByTestId("card-ca-1")).toBeTruthy();
    expect(box().value).toBe("We never discount, so skip price posts");
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.getByTestId("notice").textContent).toBe("Zavi could not save that. Try again."));
    expect(box().value).toBe("We never discount, so skip price posts");
    expect(submit().hasAttribute("disabled")).toBe(false);
  });

  it("closes once the server accepts it", async () => {
    answer = () => {
      rejected = true;
      return ok({ ok: true });
    };
    await openReject("Not our audience");
    await act(async () => {
      fireEvent.click(submit());
    });
    await waitFor(() => expect(screen.queryByTestId("card-ca-1")).toBeNull());
    const body = JSON.parse(String(apiFetch.mock.calls.find(([, i]) => i?.method === "POST")![1].body));
    expect(body.note).toBe("Not our audience");
  });

  it("caps the reason at the server's limit and never sends one that is too long", async () => {
    answer = () => ok({ ok: true });
    await openReject("x".repeat(REJECT_NOTE_MAX + 1));
    expect(REJECT_NOTE_MAX).toBe(1000);
    expect(box().maxLength).toBe(1000);
    expect(screen.getByTestId("note-too-long").textContent).toContain("1,000 characters or fewer");
    expect(submit().hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit());
    expect(apiFetch.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
  });
});
