// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  read: {} as unknown,
  readStatus: 200,
  writeStatus: 200,
  gate: null as null | Promise<void>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      if (h.gate) await h.gate;
      return { ok: h.writeStatus < 400, status: h.writeStatus, json: async () => ({}) };
    }
    return { ok: h.readStatus < 400, status: h.readStatus, json: async () => h.read, path };
  }),
}));

import { apiFetch } from "@/lib/api";
import { LaterQuestions } from "./LaterQuestions";

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const slot = (key: string, answer: string | null = null) => ({ key, answer });
const EMPTY = { slots: [slot("metric"), slot("constraint"), slot("channels")], skipped: false, customers_answered: false };
const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST");
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

beforeEach(() => {
  fetchMock.mockClear();
  h.read = EMPTY;
  h.readStatus = 200;
  h.writeStatus = 200;
  h.gate = null;
});
afterEach(cleanup);

describe("LaterQuestions", () => {
  it("does not read or show anything until the plan is ready", async () => {
    render(<LaterQuestions active={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("later-questions")).toBeNull();
  });

  it("asks one question at a time and moves on after each saved answer, in order, through all four", async () => {
    render(<LaterQuestions active />);
    await screen.findByText(/If one thing got better/);
    expect(screen.getAllByRole("heading")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "More people finding us" }));
    await screen.findByText(/Where do you lose people/);
    expect(bodyOf(posts()[0]!)).toEqual({ key: "metric", answer: "More people finding us" });

    fireEvent.click(screen.getByRole("button", { name: "They never hear about us" }));
    await screen.findByText(/How did they find you/);

    fireEvent.click(screen.getByRole("button", { name: "Someone I already knew" }));
    fireEvent.click(screen.getByRole("button", { name: "We paid for ads" }));
    expect(posts()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/how many new customers/);
    expect(bodyOf(posts()[2]!)).toEqual({ key: "channels", answer: "Someone I already knew, We paid for ads" });

    fireEvent.click(screen.getByRole("button", { name: "1-5" }));
    await waitFor(() => expect(screen.queryByTestId("later-questions")).toBeNull());
    expect(bodyOf(posts()[3]!)).toEqual({ key: "customers", answer: "1-5" });
  });

  it("never asks again what the server already has, inferred channels included", async () => {
    h.read = { slots: [slot("metric", "x"), slot("constraint"), slot("channels", "word of mouth")], skipped: false, customers_answered: true };
    render(<LaterQuestions active />);
    await screen.findByText(/Where do you lose people/);
    fireEvent.click(screen.getByRole("button", { name: "They never hear about us" }));
    await waitFor(() => expect(screen.queryByTestId("later-questions")).toBeNull());
  });

  it("an owner who already skipped is never asked, and all-answered shows nothing", async () => {
    h.read = { ...EMPTY, skipped: true };
    const first = render(<LaterQuestions active />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("later-questions")).toBeNull();
    first.unmount();

    h.read = { slots: [slot("metric", "a"), slot("constraint", "b"), slot("channels", "c")], skipped: false, customers_answered: true };
    render(<LaterQuestions active />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("later-questions")).toBeNull();
  });

  it("skip records the durable skip once and hides every remaining question", async () => {
    render(<LaterQuestions active />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip these" }));
    await waitFor(() => expect(screen.queryByTestId("later-questions")).toBeNull());
    expect(posts().map((c) => c[0])).toEqual(["/api/workspace/growth-interview/skip"]);
  });

  it("a failed save keeps the same question up, says so, and never advances", async () => {
    h.writeStatus = 500;
    render(<LaterQuestions active />);
    fireEvent.click(await screen.findByRole("button", { name: "More people finding us" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/If one thing got better/)).toBeTruthy();
    h.writeStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "More people finding us" }));
    await screen.findByText(/Where do you lose people/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a double tap while saving sends one answer", async () => {
    let release = () => {};
    h.gate = new Promise<void>((r) => { release = r; });
    render(<LaterQuestions active />);
    const chip = await screen.findByRole("button", { name: "More people finding us" });
    fireEvent.click(chip);
    await waitFor(() => expect((chip as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(chip);
    expect(posts()).toHaveLength(1);
    await act(async () => { release(); await h.gate; });
    await screen.findByText(/Where do you lose people/);
  });

  it("a failed read shows nothing and breaks nothing", async () => {
    h.readStatus = 500;
    render(<LaterQuestions active />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("later-questions")).toBeNull();
  });
});
