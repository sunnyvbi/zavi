// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtraTable, type ExtraTableData } from "../ExtraTable";

const OPTIONS = [
  { value: "allowed", label: "Allowed" },
  { value: "banned", label: "Banned" },
];

let seq = 0;
let label = "";
beforeEach(() => {
  seq += 1;
  label = `Self-promo in r/sub${seq}`;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const table = (onChange: (v: string | null) => void | Promise<unknown>, value: string | null = null, name = label): ExtraTableData => ({
  title: "Relevant subreddits",
  columns: [{ label: "Subreddit", align: "left" }, { label: "Self-promo", align: "left" }],
  rows: [{ id: "row", cells: [{ text: "r/sub" }, { text: "Check rules", select: { value, unsetLabel: "Check rules", options: OPTIONS, label: name, onChange } }] }],
  empty: "Nothing here.",
});
const pick = async (value: string) => {
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
  });
};
const saved = () => screen.queryByText("Saved.");

it("says Saved. once the save lands, and not before", async () => {
  let resolve!: () => void;
  render(<ExtraTable data={table(() => new Promise<void>((r) => { resolve = r; }))} />);
  await pick("banned");
  expect(saved()).toBeNull();
  await act(async () => resolve());
  expect(saved()?.getAttribute("role")).toBe("status");
});

it("keeps Saved. through the remount the reload causes, then clears it on the original clock", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const view = render(<ExtraTable key="before" data={table(onChange)} />);
  await pick("banned");
  expect(saved()).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(1_000); });
  view.rerender(<ExtraTable key="after-reload" data={table(onChange, "banned")} />);
  expect(saved()).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(1_400); });
  expect(saved()).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(saved()).toBeNull();
});

it("does not resurrect Saved. on a remount after it has expired", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const view = render(<ExtraTable key="a" data={table(onChange)} />);
  await pick("banned");
  await act(async () => { vi.advanceTimersByTime(2_600); });
  expect(saved()).toBeNull();
  view.rerender(<ExtraTable key="b" data={table(onChange, "banned")} />);
  expect(saved()).toBeNull();
});

it("shows the error and no Saved. when the save fails, and puts the old value back", async () => {
  render(<ExtraTable data={table(() => Promise.reject(new Error("Only an owner or an admin can change this.")), "allowed")} />);
  await pick("banned");
  expect(screen.getByRole("alert").textContent).toBe("Only an owner or an admin can change this.");
  expect(saved()).toBeNull();
  expect((screen.getByRole("combobox", { name: label }) as HTMLSelectElement).value).toBe("allowed");
});

it("drops an earlier Saved. the moment a failing save starts, and does not bring it back on remount", async () => {
  let fail!: (e: Error) => void;
  const onChange = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise((_, r) => { fail = r; }));
  const view = render(<ExtraTable key="a" data={table(onChange)} />);
  await pick("banned");
  expect(saved()).not.toBeNull();
  await pick("allowed");
  expect(saved()).toBeNull();
  await act(async () => fail(new Error("Couldn't save that. Try again in a moment.")));
  expect(saved()).toBeNull();
  view.rerender(<ExtraTable key="b" data={table(onChange, "banned")} />);
  expect(saved()).toBeNull();
});

it("keeps one select's Saved. off another select's row", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<ExtraTable data={table(onChange)} />);
  await pick("banned");
  cleanup();
  render(<ExtraTable data={table(onChange, null, `${label} other`)} />);
  expect(saved()).toBeNull();
});

it("never claims Saved. for a select whose change is not a save", async () => {
  render(<ExtraTable data={table(() => undefined)} />);
  await pick("banned");
  expect(saved()).toBeNull();
});
