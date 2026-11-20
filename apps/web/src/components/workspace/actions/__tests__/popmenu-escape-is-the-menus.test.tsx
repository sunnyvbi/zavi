// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PopMenu } from "../PopMenu";

afterEach(cleanup);

it("closing the menu with Escape marks the key, even for a listener added before it", () => {
  const seen: boolean[] = [];
  const earlier = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
  document.addEventListener("keydown", earlier);
  render(
    <PopMenu
      label="Dismiss"
      trigger={() => "Dismiss"}
      items={[{ label: "Not relevant for us", onSelect: () => {} }]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(seen).toEqual([true]);
  document.removeEventListener("keydown", earlier);
});
