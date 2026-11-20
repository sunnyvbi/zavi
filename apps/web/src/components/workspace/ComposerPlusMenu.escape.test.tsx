// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComposerPlusMenu } from "./ComposerPlusMenu";

vi.mock("@/lib/workspace/useGithubRepos", () => ({
  useGithubRepos: () => ({
    state: { status: "loading" },
    pending: false,
    setDefault: async () => ({ ok: true }),
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ sessions: [], loading: false }),
}));

afterEach(cleanup);

describe("ComposerPlusMenu Escape", () => {
  it("closes the menu and marks the key handled for listeners on document", () => {
    render(
      <ComposerPlusMenu onAttach={() => {}} repoEnabled role="owner" onManageRepos={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to this message" }));
    expect(screen.queryByRole("menu")).toBeTruthy();
    let seenPrevented: boolean | null = null;
    const onDoc = (e: KeyboardEvent) => {
      seenPrevented = e.defaultPrevented;
    };
    document.addEventListener("keydown", onDoc);
    fireEvent.keyDown(document, { key: "Escape" });
    document.removeEventListener("keydown", onDoc);
    expect(seenPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
