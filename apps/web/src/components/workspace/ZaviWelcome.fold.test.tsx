// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let connectAvailable = true;
vi.mock("./ConnectRows", () => ({
  ConnectRows: ({
    hidden,
    onAvailability,
  }: {
    hidden?: boolean;
    onAvailability?: (a: boolean) => void;
  }) => {
    useEffect(() => {
      onAvailability?.(connectAvailable);
    }, [onAvailability]);
    return hidden || !connectAvailable ? null : <div>connect-rows</div>;
  },
}));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("./TypewriterHeading", () => ({ TypewriterHeading: () => <h1>Let's start</h1> }));

import { WorkspaceModeWelcome } from "./ZaviWelcome";

afterEach(() => {
  cleanup();
  connectAvailable = true;
});

function renderWelcome(props: { foldIdeas?: boolean; foldConnect?: boolean; mode?: "grow" | "build" }) {
  return render(
    <WorkspaceModeWelcome
      mode={props.mode ?? "grow"}
      composer={<textarea aria-label="composer" />}
      nextTiles={<div>tiles</div>}
      foldIdeas={props.foldIdeas}
      foldConnect={props.foldConnect}
      onPickSuggestion={() => {}}
    />,
  );
}

describe("WorkspaceModeWelcome folding", () => {
  it("first run: tiles and composer show, idea chips and connect rows sit behind two links", () => {
    renderWelcome({ foldIdeas: true, foldConnect: true });
    expect(screen.getByText("tiles")).toBeTruthy();
    expect(screen.getByLabelText("composer")).toBeTruthy();
    expect(screen.queryByText("Plan my next month")).toBeNull();
    expect(screen.queryByText("Make a deck")).toBeNull();
    expect(screen.queryByText("connect-rows")).toBeNull();
    expect(screen.getByRole("button", { name: /More ideas/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect apps/ })).toBeTruthy();
  });

  it("More ideas opens both chip rows; nothing is deleted", () => {
    renderWelcome({ foldIdeas: true, foldConnect: true });
    fireEvent.click(screen.getByRole("button", { name: /More ideas/ }));
    expect(screen.getAllByText("Plan my next month").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Make a deck").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Fewer ideas/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("Connect apps opens the connect rows", () => {
    renderWelcome({ foldIdeas: true, foldConnect: true });
    fireEvent.click(screen.getByRole("button", { name: /Connect apps/ }));
    expect(screen.getByText("connect-rows")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hide apps/ })).toBeTruthy();
  });

  it("first-run steps done: idea chips open by default, no More ideas link", () => {
    renderWelcome({ foldIdeas: false, foldConnect: true });
    expect(screen.getAllByText("Plan my next month").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /More ideas/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Connect apps/ })).toBeTruthy();
  });

  it("a fully connected tenant never sees the Connect apps link", () => {
    connectAvailable = false;
    renderWelcome({ foldIdeas: true, foldConnect: true });
    expect(screen.queryByRole("button", { name: /Connect apps/ })).toBeNull();
  });

  it("without fold flags (Build mode) the layout is unchanged: chips shown, no links", () => {
    renderWelcome({ mode: "build" });
    expect(screen.queryByRole("button", { name: /More ideas/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect apps/ })).toBeNull();
    expect(screen.getByText("connect-rows")).toBeTruthy();
  });
});
