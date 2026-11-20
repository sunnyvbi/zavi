// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const repos = vi.hoisted(() => ({ state: { status: "loading" } as Record<string, unknown> }));
vi.mock("@/lib/workspace/useGithubRepos", () => ({ readGithubRepos: () => repos.state }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => new Response("{}", { status: 404 })) }));

import { ExportToGithubButton } from "./ExportToGithubButton";

afterEach(cleanup);

describe("the export button", () => {
  it("reads Export to GitHub whichever account is connected, in the filled ink style", () => {
    for (const state of [
      { status: "ok", connected: true, repos: [], default: null, hiddenByScope: 0, accountLogin: "mohitdudhat22" },
      { status: "loading" },
      { status: "ok", connected: false, repos: [], default: null, hiddenByScope: 0, accountLogin: "old-login" },
    ]) {
      repos.state = state;
      render(<ExportToGithubButton repoName="yoga-studio" buildId={null} />);
      const button = screen.getByTestId("export-to-github");
      expect(button.textContent).toBe("Export to GitHub");
      expect(button.textContent).not.toMatch(/github\.com/);
      expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-ink", "text-cream", "rounded-full"]));
      cleanup();
    }
  });
});
