// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionModal } from "../actions/topActions/ActionModal";
import { DatePicker, longDay } from "./DatePicker";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Picker({ onChange, min = "2026-10-28", max = "2026-11-10" }: { onChange: (v: string) => void; min?: string; max?: string }) {
  const [value, setValue] = useState("");
  return (
    <DatePicker
      label="Day"
      field="day"
      value={value}
      min={min}
      max={max}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

const trigger = () => screen.getByRole("button", { name: "Day" }) as HTMLButtonElement;
const popover = () => within(screen.getByRole("dialog", { name: "Choose a day" }));
const cell = (iso: string) => popover().getByRole("button", { name: longDay(iso)! }) as HTMLButtonElement;
const nav = (name: "Next month" | "Previous month") => popover().getByRole("button", { name }) as HTMLButtonElement;

function pressEscape(target: Element) {
  const notPrevented = fireEvent.keyDown(target, { key: "Escape" });
  if (notPrevented) document.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
  return notPrevented;
}

describe("DatePicker max", () => {
  it("days after max cannot be picked, Next month stops at the max month, and the last allowed day still picks", () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.click(trigger());
    expect(popover().getByText("October 2026")).toBeTruthy();
    expect(nav("Previous month").disabled).toBe(true);
    expect(cell("2026-10-27").disabled).toBe(true);
    expect(cell("2026-10-28").disabled).toBe(false);
    fireEvent.click(nav("Next month"));
    expect(popover().getByText("November 2026")).toBeTruthy();
    expect(nav("Next month").disabled).toBe(true);
    fireEvent.click(nav("Next month"));
    expect(popover().getByText("November 2026")).toBeTruthy();
    expect(cell("2026-11-10").disabled).toBe(false);
    for (const iso of ["2026-11-11", "2026-11-12", "2026-11-30"]) {
      expect(cell(iso).disabled).toBe(true);
      fireEvent.click(cell(iso));
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("Pick a day");
    fireEvent.click(cell("2026-11-10"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-11-10");
    expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
    expect(trigger().textContent).toBe(longDay("2026-11-10"));
  });

  it("with no max every later month and day stays open", () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} max="" />);
    fireEvent.click(trigger());
    for (let i = 0; i < 14; i++) {
      expect(nav("Next month").disabled).toBe(false);
      fireEvent.click(nav("Next month"));
    }
    expect(popover().getByText("December 2027")).toBeTruthy();
    fireEvent.click(cell("2027-12-31"));
    expect(onChange).toHaveBeenCalledWith("2027-12-31");
  });
});

describe("DatePicker Escape inside a modal", () => {
  it("Escape closes only the calendar: the modal stays open, its onClose never runs and a page-level Escape listener never hears it", () => {
    const onClose = vi.fn();
    const pageEscape = vi.fn();
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") pageEscape();
    };
    document.addEventListener("keydown", listen);
    try {
      render(
        <ActionModal eyebrow="Email" title="New campaign" sub="" onClose={onClose} footer={<button type="button">Go</button>}>
          <Picker onChange={() => {}} />
        </ActionModal>,
      );
      fireEvent.click(trigger());
      expect(pressEscape(cell("2026-10-29"))).toBe(false);
      expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(pageEscape).not.toHaveBeenCalled();
      expect(document.querySelector("dialog")!.hasAttribute("open")).toBe(true);
      expect(pressEscape(trigger())).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });

  it("outside any modal, Escape on the calendar is kept from a page-level Escape listener, such as a drawer that closes on any Escape", () => {
    const pageEscape = vi.fn();
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") pageEscape();
    };
    document.addEventListener("keydown", listen);
    try {
      render(<Picker onChange={() => {}} />);
      fireEvent.click(trigger());
      expect(fireEvent.keyDown(trigger(), { key: "Escape" })).toBe(false);
      expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
      expect(pageEscape).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger(), { key: "Escape" });
      expect(pageEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });
});
