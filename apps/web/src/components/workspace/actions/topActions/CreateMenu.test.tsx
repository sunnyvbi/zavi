// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CreateMenu } from "./CreateMenu";
import { linkedin_organic } from "../platforms/linkedin_organic";

afterEach(cleanup);

const menu = (onPick = vi.fn()) => {
  render(<CreateMenu label="Create post" tag={null} actions={linkedin_organic.topActions ?? []} onPick={onPick} />);
  return onPick;
};

describe("the Create post menu", () => {
  it("lists LinkedIn's three ways to make something, as in the design", () => {
    menu();
    const trigger = screen.getByRole("button", { name: /Create post/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("menu", { name: "What do you want to make?" });
    expect(Array.from(list.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual(["New post", "Post with image", "Draft comment"]);
  });

  it("opens the picked action and closes", () => {
    const onPick = menu();
    fireEvent.click(screen.getByRole("button", { name: /Create post/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Post with image" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ key: "post_image" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves with the arrow keys and closes on Escape, back to the button", () => {
    menu();
    const trigger = screen.getByRole("button", { name: /Create post/ });
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the founder clicks elsewhere", () => {
    menu();
    fireEvent.click(screen.getByRole("button", { name: /Create post/ }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
