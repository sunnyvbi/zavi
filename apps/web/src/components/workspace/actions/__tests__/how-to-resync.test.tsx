// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HowTo } from "../HowTo";
import { makeAction } from "./fixtures";

const save = vi.hoisted(() => vi.fn(async (_id: string, _steps: number[]) => ({})));
vi.mock("@/lib/workspace/channelActionsApi", () => ({ setChannelActionSteps: save }));
beforeEach(() => { save.mockImplementation(async () => ({})); });
afterEach(() => { cleanup(); save.mockReset(); });

const task = (steps_done: number[]) => makeAction("fix", { card_kind: "task", how_to: ["Open settings", "Add the tag", "Publish"], steps_done });
const boxes = () => screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).checked);

it("shows ticks saved elsewhere after the card refreshes", () => {
  const view = render(<HowTo a={task([])} />);
  expect(boxes()).toEqual([false, false, false]);
  view.rerender(<HowTo a={task([1])} />);
  expect(boxes()).toEqual([false, true, false]);
});

it("keeps a tick that arrived during a save that then failed", async () => {
  let fail: (error: Error) => void = () => {};
  save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = render(<HowTo a={task([])} />);
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  view.rerender(<HowTo a={task([2])} />);
  await act(async () => { fail(new Error("offline")); });
  expect(boxes()).toEqual([false, false, true]);
});

it("shows the server's ticks when a save fails, not unsaved local ones", async () => {
  let fail: (error: Error) => void = () => {};
  save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = render(<HowTo a={task([])} />);
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  view.rerender(<HowTo a={task([2])} />);
  fireEvent.click(screen.getAllByRole("checkbox")[1]);
  await act(async () => { fail(new Error("offline")); });
  expect(boxes()).toEqual([false, false, true]);
});

it("falls back to the last saved set when a queued save fails", async () => {
  let land: (value: object) => void = () => {};
  save.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
  save.mockImplementationOnce(async () => { throw new Error("offline"); });
  render(<HowTo a={task([])} />);
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  fireEvent.click(screen.getAllByRole("checkbox")[1]);
  await act(async () => { land({}); });
  expect(save).toHaveBeenLastCalledWith(expect.any(String), [0, 1]);
  expect(boxes()).toEqual([true, false, false]);
});

it("keeps a pending tick over a refresh and sends it in the next set", async () => {
  let land: (value: object) => void = () => {};
  save.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
  const view = render(<HowTo a={task([])} />);
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  fireEvent.click(screen.getAllByRole("checkbox")[1]);
  view.rerender(<HowTo a={task([0])} />);
  expect(boxes()).toEqual([true, true, false]);
  await act(async () => { land({}); });
  expect(boxes()).toEqual([true, true, false]);
  fireEvent.click(screen.getAllByRole("checkbox")[2]);
  expect(save).toHaveBeenLastCalledWith(expect.any(String), [0, 1, 2]);
});
