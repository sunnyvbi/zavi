// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateRangeMenu } from "./DateRangeMenu";

const ranges = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 18, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const day = (label: string) => screen.getByRole("button", { name: label });

it("names a preset with the dates the report covers, and no dates when the report gave none", () => {
  const { unmount } = render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={() => {}} />);
  expect(screen.getByRole("button", { name: "Last 30 days" })).toBeTruthy();
  unmount();
  render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={() => {}} allowCustom period={{ from: "2026-10-19", to: "2026-11-17" }} />);
  expect(screen.getByRole("button", { name: /Last 30 days · Oct 19 – Nov 17, 2026/ })).toBeTruthy();
});

it("offers no Custom row on a channel that cannot answer one", () => {
  render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
  expect(screen.getByRole("option", { name: "Last 7 days" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Custom/ })).toBeNull();
});

it("Custom picks a start and an end day and applies them as dates", () => {
  const onPick = vi.fn();
  render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={onPick} allowCustom />);
  fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
  fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
  expect(screen.getByRole("dialog", { name: "Custom date range" })).toBeTruthy();
  fireEvent.click(day("Wednesday, November 4, 2026"));
  expect(screen.getByRole("status").textContent).toBe("Pick the end date");
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(day("Thursday, November 12, 2026"));
  expect(screen.getByRole("status").textContent).toBe("9 days");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(onPick).toHaveBeenCalledWith({ id: "custom", days: 9, since: "2026-11-04", until: "2026-11-12" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("days after today cannot be picked, and Cancel changes nothing", () => {
  const onPick = vi.fn();
  render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={onPick} allowCustom />);
  fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
  fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
  expect((day("Thursday, November 19, 2026") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onPick).not.toHaveBeenCalled();
});

it("a range longer than the limit cannot be applied", () => {
  render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={() => {}} allowCustom maxDays={5} />);
  fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
  fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
  fireEvent.click(day("Wednesday, November 4, 2026"));
  fireEvent.click(day("Thursday, November 12, 2026"));
  expect(screen.getByRole("status").textContent).toBe("Pick 5 days or fewer");
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
});

it("an applied custom range shows on the button and reopens on the calendar", () => {
  render(<DateRangeMenu label="ignored" ranges={ranges} pickedId="custom" custom={{ since: "2026-11-04", until: "2026-11-12" }} onPick={() => {}} allowCustom />);
  fireEvent.click(screen.getByRole("button", { name: "Nov 4 – Nov 12, 2026" }));
  expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("Nov 4, 2026");
  expect((screen.getByLabelText("End date") as HTMLInputElement).value).toBe("Nov 12, 2026");
  fireEvent.click(screen.getByRole("button", { name: "Back to date ranges" }));
  fireEvent.click(screen.getByRole("option", { name: "Last 7 days" }));
});

it("a typed end date before the start is refused with a reason", () => {
  render(<DateRangeMenu label="Last 30 days" ranges={ranges} pickedId="30d" onPick={() => {}} allowCustom />);
  fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
  fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
  const end = screen.getByLabelText("End date");
  fireEvent.change(end, { target: { value: "Jan 1, 2026" } });
  fireEvent.blur(end);
  expect(screen.getByText(/Use a date from Oct 19, 2026 to today/)).toBeTruthy();
});

it("a report that came back for different dates than the custom range is treated as refused", async () => {
  const { customRangeRefused } = await import("./dateRange");
  const custom = { since: "2026-11-03", until: "2026-11-10" };
  expect(customRangeRefused(custom, { from: "2026-11-03", to: "2026-11-10" })).toBe(false);
  expect(customRangeRefused({ since: "2026-11-19", until: "2026-11-19" }, { from: "2026-11-18", to: "2026-11-18" })).toBe(false);
  expect(customRangeRefused(custom, { from: "2026-10-19", to: "2026-11-17" })).toBe(true);
  expect(customRangeRefused(custom, null)).toBe(false);
  expect(customRangeRefused(null, { from: "2026-10-19", to: "2026-11-17" })).toBe(false);
});
