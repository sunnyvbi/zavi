// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  repos: vi.fn(() => ({ state: { status: "loading" }, pending: false, setDefault: vi.fn() })),
  builds: vi.fn(() => ({ loaded: false })),
  reload: vi.fn(),
}));
vi.mock("@/lib/workspace/useGithubRepos", () => ({ useGithubRepos: mocks.repos }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ useBuildSessions: mocks.builds }));
vi.mock("./artifacts/useArtifacts", () => ({ useArtifacts: () => ({
  artifacts: [{ id: "image-1", filename: "existing-creative.png", title: "Saved creative", mime: "image/png", bytes: 300 }],
  loading: false, error: null, reload: mocks.reload,
}) }));

import { ComposerPlusMenu } from "./ComposerPlusMenu";

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

function setup(repoEnabled = false) {
  const onAttach = vi.fn();
  const onPickArtifact = vi.fn();
  const onManageRepos = vi.fn();
  render(<ComposerPlusMenu repoEnabled={repoEnabled} role="member" onAttach={onAttach}
    onPickArtifact={onPickArtifact} onManageRepos={onManageRepos} />);
  fireEvent.click(screen.getByRole("button", { name: "Add to this message" }));
  return { onAttach, onPickArtifact, onManageRepos };
}

it("channel chat can select an existing artifact without mounting repository or build hooks", () => {
  const callbacks = setup();
  expect(screen.queryByRole("menuitem", { name: /GitHub/ })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: /Attach from Artifacts/ }));
  expect(mocks.reload).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("menuitem", { name: /Saved creative/ }));
  expect(callbacks.onPickArtifact).toHaveBeenCalledTimes(1);
  expect(callbacks.onPickArtifact).toHaveBeenCalledWith("image-1", "existing-creative.png");
  expect(callbacks.onAttach).not.toHaveBeenCalled();
  expect(callbacks.onManageRepos).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(mocks.repos).not.toHaveBeenCalled();
  expect(mocks.builds).not.toHaveBeenCalled();
});

it("channel upload still opens the ordinary file picker once", () => {
  const callbacks = setup();
  fireEvent.click(screen.getByRole("menuitem", { name: "Attach a file" }));
  expect(callbacks.onAttach).toHaveBeenCalledOnce();
  expect(callbacks.onPickArtifact).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(mocks.repos).not.toHaveBeenCalled();
  expect(mocks.builds).not.toHaveBeenCalled();
});

it("Escape closes the artifact picker and consumes Escape before the channel chat", () => {
  setup();
  fireEvent.click(screen.getByRole("menuitem", { name: /Attach from Artifacts/ }));
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  fireEvent(window, event);
  expect(event.defaultPrevented).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("repo-enabled agents retain GitHub controls and both attachment choices", () => {
  const callbacks = setup(true);
  expect(mocks.repos).toHaveBeenCalled();
  expect(mocks.builds).toHaveBeenCalled();
  expect(screen.getByRole("menuitem", { name: /Attach from Artifacts/ })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Attach a file" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: /GitHub repo/ }));
  expect(callbacks.onManageRepos).toHaveBeenCalledOnce();
});
