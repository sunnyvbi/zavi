// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DaypartingFields, deliveryMask, deliveryWindows } from "./DaypartingFields";
afterEach(cleanup);
it("round trips disjoint half-hour windows without losing days or gaps", () => {
  const days = [[{ start: 1, end: 3 }, { start: 18, end: 34 }], [], [], [], [], [], [{ start: 47, end: 48 }]];
  const mask = deliveryMask(days);
  expect(mask).toHaveLength(336);
  expect(deliveryWindows(mask)).toEqual(days);
  expect(deliveryWindows("000")).toBeNull();
  expect(deliveryWindows("0".repeat(336))).toEqual(Array.from({ length: 7 }, () => [{ start: 0, end: 48 }]));
});
it("does not allow removing the last delivery window (which TikTok treats as all day)", () => {
  const change = vi.fn();
  render(<DaypartingFields value={deliveryMask([[{ start: 18, end: 34 }], [], [], [], [], [], []])} onChange={change} timezone="Asia/Kolkata" disabled={false} />);
  expect((screen.getByRole("button", { name: "Remove Monday window 1" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Hours use the ad account time zone: Asia\/Kolkata/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Monday window 1" }));
  expect(change).not.toHaveBeenCalled();
});
it("edits weekday hours in half-hour slots and adds a distinct additional window", () => {
  const changed = vi.fn();
  function Form() { const [value, setValue] = useState("1".repeat(336)); return <DaypartingFields value={value} onChange={v => { setValue(v); changed(v); }} timezone="UTC" disabled={false} />; }
  render(<Form />);
  fireEvent.click(screen.getByRole("button", { name: "Use weekdays, 09:00–17:00" }));
  fireEvent.change(screen.getByLabelText("Monday window 1 start"), { target: { value: "19" } });
  expect(deliveryWindows(changed.mock.lastCall![0])![0]).toEqual([{ start: 19, end: 34 }]);
  fireEvent.click(screen.getByRole("button", { name: "Add Sunday hours" }));
  expect(deliveryWindows(changed.mock.lastCall![0])![6]).toEqual([{ start: 0, end: 48 }]);
});
