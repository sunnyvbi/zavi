// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionModal } from "../../actions/topActions/ActionModal";
import { clockLabel, QUARTER_HOURS, TimePicker } from "../TimePicker";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

function Picker({ start, onChange }: { start: string; onChange: (v: string) => void }) {
  const [value, setValue] = useState(start);
  return (
    <TimePicker
      label="Time"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

const trigger = () => screen.getByRole("button", { name: "Time" }) as HTMLButtonElement;
const list = () => within(screen.getByRole("listbox", { name: "Time" }));

function pressEscape(target: Element) {
  const notPrevented = fireEvent.keyDown(target, { key: "Escape" });
  if (notPrevented) document.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
  return notPrevented;
}

describe("clockLabel", () => {
  it("reads a 24-hour HH:MM as a 12-hour clock", () => {
    expect(clockLabel("00:00")).toBe("12:00 AM");
    expect(clockLabel("09:00")).toBe("9:00 AM");
    expect(clockLabel("12:15")).toBe("12:15 PM");
    expect(clockLabel("23:45")).toBe("11:45 PM");
  });
});

describe("TimePicker", () => {
  it("offers every quarter hour of the day, and picking one hands back HH:MM and shows the 12-hour label", () => {
    const onChange = vi.fn();
    render(<Picker start="09:00" onChange={onChange} />);
    expect(trigger().textContent).toBe("9:00 AM");
    fireEvent.click(trigger());
    const options = list().getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(QUARTER_HOURS.map(clockLabel));
    expect(options).toHaveLength(96);
    expect(options.filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.textContent)).toEqual(["9:00 AM"]);
    fireEvent.click(list().getByRole("option", { name: "2:45 PM" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("14:45");
    expect(screen.queryByRole("listbox", { name: "Time" })).toBeNull();
    expect(trigger().textContent).toBe("2:45 PM");
    fireEvent.click(trigger());
    expect(list().getByRole("option", { name: "2:45 PM" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(list().getByRole("option", { name: "12:00 AM" }));
    expect(onChange).toHaveBeenLastCalledWith("00:00");
    expect(trigger().textContent).toBe("12:00 AM");
  });

  it("keeps a saved time that is off the quarter-hour grid, sorted in place and selected", () => {
    const onChange = vi.fn();
    render(<Picker start="09:07" onChange={onChange} />);
    expect(trigger().textContent).toBe("9:07 AM");
    fireEvent.click(trigger());
    const names = list().getAllByRole("option").map((o) => o.textContent);
    expect(names).toHaveLength(97);
    expect(names.slice(names.indexOf("9:00 AM"), names.indexOf("9:00 AM") + 3)).toEqual(["9:00 AM", "9:07 AM", "9:15 AM"]);
    expect(list().getByRole("option", { name: "9:07 AM" }).getAttribute("aria-selected")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape closes only the list: the modal stays open and its onClose never runs, and a second Escape then closes the modal", () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(
      <ActionModal eyebrow="Email" title="New campaign" sub="" onClose={onClose} footer={<button type="button">Go</button>}>
        <Picker start="09:00" onChange={onChange} />
      </ActionModal>,
    );
    fireEvent.click(trigger());
    expect(pressEscape(list().getByRole("option", { name: "9:00 AM" }))).toBe(false);
    expect(screen.queryByRole("listbox", { name: "Time" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")!.hasAttribute("open")).toBe(true);
    expect(trigger().textContent).toBe("9:00 AM");
    expect(pressEscape(trigger())).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a press outside closes the list without picking", () => {
    const onChange = vi.fn();
    render(
      <div>
        <p>Outside</p>
        <Picker start="09:00" onChange={onChange} />
      </div>,
    );
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText("Outside"));
    expect(screen.queryByRole("listbox", { name: "Time" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("outside any modal, Escape on the list is kept from a page-level Escape listener, such as a drawer that closes on any Escape", () => {
    const pageEscape = vi.fn();
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") pageEscape();
    };
    document.addEventListener("keydown", listen);
    try {
      render(<Picker start="09:00" onChange={() => {}} />);
      fireEvent.click(trigger());
      expect(fireEvent.keyDown(trigger(), { key: "Escape" })).toBe(false);
      expect(screen.queryByRole("listbox", { name: "Time" })).toBeNull();
      expect(pageEscape).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger(), { key: "Escape" });
      expect(pageEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });
});
