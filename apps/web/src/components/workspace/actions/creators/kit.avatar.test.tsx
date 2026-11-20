// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Avatar } from "./kit";

afterEach(cleanup);

describe("Avatar", () => {
  it("shows the initial when the creator has no photo", () => {
    render(<Avatar name="Tarun Asnani" photoUrl={null} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("T")).toBeTruthy();
  });

  it("shows the saved photo when there is one", () => {
    render(<Avatar name="Tarun Asnani" photoUrl="https://example.test/p.jpg" />);
    expect(screen.getByRole("img", { name: "Tarun Asnani's photo" }).getAttribute("src")).toBe("https://example.test/p.jpg");
  });

  it("falls back to the initial when the photo fails to load", () => {
    render(<Avatar name="Tarun Asnani" photoUrl="https://example.test/expired.jpg" />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("T")).toBeTruthy();
  });
});
